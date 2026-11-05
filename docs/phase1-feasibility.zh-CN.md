# Phase 1 技术可行性报告：DeepSeek Pre-edit Review

> 范围：只做可行性验证，不写产品代码、不修改 Desktop 内部文件。
> 环境：DeepSeek Harness Desktop **0.2.1-rc.5**（Electron，`/Applications/DeepSeek Harness.app`）、VS Code **1.144.0**、macOS (arm64)、profile = `desktop`。
> 证据等级标记：**【已核实】** = 读过实际运行代码 / 官方 d.ts / 线上实测；**【推断】** = 由 API 契约推导，未跑通；**【未验证】** = 明确未知。

---

## 0. 一页结论

**能做，而且比 plan.md 写作时预期的更可行——但不是"一层拦截"就能做对，必须分两级目标。**

| 目标 | 可行性 | 关键依据 |
|---|---|---|
| A. 工具级 pre-edit 审批（write/edit/str_replace_editor 在写盘前挂起，弹 VS Code 可编辑 diff，Accept 后写、Reject 后不写，内容以用户最终编辑为准） | **可行** | 官方 `tools/pre-execute` 是**异步 waterfall**，返回前可任意 await；已有第三方插件正在用它做"写前快照"【已核实】 |
| B. 严格模式：Agent 完全无法绕过审批改文件（含 bash / python / sed / 重定向） | **可行，且 DSH 已内置所需机制** | 会话级沙箱 `read-only` 模式在 OS 层（macOS Seatbelt）拒绝一切写；per-call 策略可让"受控提交服务"单独获得工作区写权限【已核实】 |
| C. 在 workspace-write 模式下"拦住所有写入途径" | **不可行** | bash / 子进程写不经 `ctx.fs`，任何 hook 都看不到；这是 plan.md 担心的点，结论是**只能靠沙箱，不能靠拦截** |
| D. 让用户编辑后的内容生效 | **可行，但需要"短路工具执行 + 自行提交"**，这是全项目唯一需要先做 spike 的集成不确定性 | `tools/pre-execute` **不能改写 `exec.arguments`**（官方已知限制）；`tools/execute` waterfall 允许不调用 `next()` 直接返回结果【已核实 API / 短路写法无官方先例】 |
| E. VS Code 侧可编辑左右分栏 diff | **可行** | 自定义 `FileSystemProvider` 作为 `vscode.diff` 右侧（原生可编辑/保存）；Monaco Webview 兜底【已核实 d.ts】 |

三条必须写进产品边界的硬结论：

1. **"审批前绝不改原文件"可以严格做到。** 审批期间只读 + 内存/暂存区，Accept 时才通过 `ctx.fs.writeText` 以 **CAS（`replaceIfVersion`）+ 原子 rename** 提交；文件在此期间被外部改动会直接 `FS_STALE_VERSION` 失败，不会覆盖。
2. **"拦住 bash 写入"只有一条路：把会话沙箱设成 `read-only`。** 这不是我们发明的机制，是 DSH 现成的 per-session 权限档位；在 `workspace-write` 下 Agent 用 bash 写文件，任何插件 hook 都无法阻止（它根本不经过工具层之外的可拦截点）。
3. **不要幻想复用官方现成 UI。** DSH 有 approval UI（工具名 + 理由的气泡），但没有"可编辑 proposed content 的 diff 审批"；VS Code 侧也没有第三方可复用的 proposed-edit 审批 API（Copilot 那套是 proposed API，外部扩展拿不到）。

因此建议的产品定位是：**"工具级 diff 审批" + 可选"严格只读模式（唯一可宣称无绕过的模式）"**，而不是一上来就承诺"绝对拦截"。

---

## 1. 环境事实清单

| 项 | 事实 | 来源 |
|---|---|---|
| Desktop 版本 | `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.5**，全部依赖同版本 | `app.asar/dsh/package.json`【已核实】 |
| 运行时形态 | Electron 打包在 `app.asar`；Host 是**普通 Node 进程**（跑 Cordis Loader），插件**在进程内执行** | `@deepseek-ai/dsh-desktop-host`；plugin-manager README："installed Host code executes in-process outside the workspace sandbox"【已核实】 |
| profile 目录 | `~/.dsh/profiles/desktop`（`DSH_PROFILE=desktop`）；组合 = `package.json` 的 `dsh.profile.bundles` 逐层 patch + `cordis.patch.yml` | 本机实测【已核实】 |
| Desktop 组合 | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + 第三方 `dsh-checkpoint-rewind` / `dsh-context` / `dsh-hot-installer` + agent-team / voice-input | `~/.dsh/profiles/desktop/package.json`【已核实】 |
| Web 端 | Host 内置 HTTP 服务，当前 `http://127.0.0.1:52914`，带鉴权 | 运行时上下文 / `dsh-host-webserver`【已核实】 |
| CLI 与 Desktop 是否共用 | **不共用配置目录**：Desktop 用 `desktop` profile，CLI 用各自 profile（本机另有 `web` profile，组合不同）。**但**同一份 Cordis/`dsh-tools` 版本给出**相同的 hook 契约**，插件包可以分别安装到不同 profile | 两个 profile 目录实测对比【已核实】 |

**关键推论：插件若要做成产品形态，应该做成一个"profile bundle"（npm 包 + `dsh.bundle.patch`），而不是去改 Desktop 源码。** 本机已有 3 个第三方 bundle 在跑，这本身就是可行性证据。

---

## 2. Harness 侧能力验证（核心）

### 2.1 工具执行流水线（照抄官方顺序）

```
tools/pre-execute   ← 可拒绝 / 可"询问用户" / 可异步挂起（waterfall）
  ↓
ctx.tools.guard()   ← 单调同步守卫（只能否，不能翻案）
  ↓
tools/execute       ← around-dispatch：可以【不调用 next()】直接返回结果
  ↓
工具 body（真正写盘的地方）
  ↓
tools/post-execute  ← 可替换 content / 可 block 并回灌反馈
  ↓
finalizeContent → tools/result
```

【已核实】`dsh-tools` README「Understand the implementation / Design concept」与 `lib/index.js:3321`、`:3427`、`:3600`。

### 2.2 `tools/pre-execute`：这才是"真正的修改前拦截"

事件签名【已核实】：

```ts
'tools/pre-execute'(
  exec: ToolExecution,                                    // name / arguments / agent / signal
  next: () => Promise<PreToolDecision>
): Promise<PreToolDecision>

type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: {...} }
```

实现处 `dsh-tools/lib/index.js:3321`：

```ts
const gate = await this.ctx.waterfall(carrier, 'tools/pre-execute', exec,
                                     () => Promise.resolve({ kind: 'allow' }))
const askResolution = gate.kind === 'ask' ? await this.serviceAsk(exec, gate) : ...
```

- **可以异步、可以挂很久**。官方 Event 契约原文："Async gates must observe `exec.signal`; the registry rechecks cancellation after they settle but **never abandons their promise**."【已核实】
- `deny` → 工具 body **根本不会执行**，模型收到 `Error: <reason>`；可附带结构化 `ToolErrorInfo`。
- `ask` → 走 `ctx.approval`（`serviceAsk`，`dsh-tools/lib/index.js:3535`），四种结果：`allowed-once / rejected / cancelled / unavailable`；无 approval 通道时**降级为拒绝**（fail-closed）。
- **限制（官方明说）**："`tools/pre-execute` deliberately cannot rewrite `exec.arguments`"【已核实，README Known Limitations】。

**⇒ 结论：plan.md 里要求的"阻塞当前文件修改操作，等待用户审批"是官方支持的，不需要 hack。**

### 2.3 `tools/execute`：让"用户编辑后的内容"生效的唯一干净入口

`dsh-tools/lib/index.js:3427`：

```ts
const result = await this.ctx.waterfall(carrier, 'tools/execute', mutableExec,
                                        () => this.dispatchToolBody(mutableExec))
```

- waterfall 语义允许监听器**不调用 `next()`**，直接返回一个 `ToolExecutionResult` ⇒ 工具 body 不执行。
- 返回值会被 `normalizeDispatchResult()`（`:3669`）用该工具声明的 **output schema 校验 + render**。所以"合成成功结果"必须符合各工具的输出结构——而 write/edit 的输出结构非常简单【已核实】：

| 工具 | 成功 value |
|---|---|
| `write` | `{ path: string, operation: 'create'\|'update', before: string\|null, after: string }` |
| `edit` | `{ path: string, before: string, after: string }` |
| `str_replace_editor` | `{ type: 'string' }` |

⇒ 我们在审批通过后自行写盘，再返回一个**结构完全真实**的合成结果（`before` = 原始内容，`after` = 用户最终确认内容），模型和 UI 看到的信息是准确的。

⚠️ 这是全项目**唯一没有官方先例**的地方：现有 shipped 代码里只有一个 `tools/execute` 监听器（`dsh-tool-call-timeout-policy`），它仍然调用了 `next()`。**必须先花半天做 spike 验证短路**（见 §8 S1）。

### 2.4 文件写层：CAS、原子写、权限保留——已经全部具备

`ctx.fs`（`dsh-fs` 抽象，Desktop 实际挂的是 `dsh-fs-sandbox` → `dsh-fs-local`）【已核实】：

```ts
writeText(target, content, expected?: FsWriteIntent, signal?, sandboxPolicy?: SandboxExecutionPolicy)
editText (target, { oldString, newString, replaceAll }, expected?, signal?, sandboxPolicy?)

type FsWriteIntent =
  | { kind: 'replaceIfVersion'; version: FsVersion }
  | { kind: 'createIfAbsent' }
```

`dsh-fs-local/lib/index.js:864` 的实现：

- `replaceIfVersion` 且版本不符 → `FS_STALE_VERSION`（**这就是 plan.md 测试 4 要的"审批期间文件被改 → 拒绝自动提交"**，而且是原子的，不是 TOCTOU）。
- `createIfAbsent` 且文件已存在 → `FS_NOT_OBSERVED`（防"审批时是新建、提交时已存在"）。
- 写入走 `writeFileAtomic`（临时文件 + rename），**保留原文件 mode**，符号链接写穿到目标而不是替换链接。
- 编辑语义：`applyLiteralEdit`（`dsh-fs-local/lib/index.js:698`）—— CRLF→LF 归一化、唯一匹配、多匹配报 `FS_AMBIGUOUS_EDIT`、`replaceAll` 全替换。
- 写入成功后返回 `{ operation, version, before, after }`。

另外一个细节必须照抄：工具写完后会 `ctx.emit('fs/observed', target, { kind:'present', version }, exec)`（`dsh-tool-fs/lib/index.js:492` `mutationResult`）。**我们的提交服务也必须补发这个事件**，否则 Agent 后续对同一文件的 `edit` 会因为"未读/版本过期"失败。

### 2.5 沙箱与权限档位：严格模式的现成基础

`dsh-sandbox-policy`（`lib/index.js:31`）【已核实】：

```ts
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
// 按会话持久化在 session log 的 sandbox/mode 事件里，重放可恢复
ctx.sandboxPolicy.resolve({ session }) -> { mode, workspaceRoot, sessionId? }
```

`dsh-fs-sandbox`（`lib/index.js:125-164`）【已核实】：`writeText/editText` 之前 `checkedTarget()` 按 **per-call policy** 判定：

- `read-only` → **拒绝一切 mutation**（`FS_SANDBOX_DENIED`）
- `workspace-write` → 仅允许 canonical 后落在 workspaceRoot / 平台临时目录内
- `danger-full-access` → 不设防
- **调用方可以显式传入更宽的 `sandboxPolicy`**（`policy = sandboxPolicy ?? ctx.sandboxPolicy.resolve()`）——这正是"受控提交服务"可以写、而 Agent 不能写的机制。

`dsh-bash-sandbox` 对同一个 policy 做 **OS 级**执行世界限制（macOS Seatbelt / Linux Landlock / Windows ACL），拒绝时返回 `[sandbox: file access denied under <mode> mode]`【已核实，README「Modes and enforcement」】。

Desktop 组合里三个档位已经配好（`dsh-base/cordis.patch.yml:264`）【已核实】：

```yaml
presets:
  read-only:          { sandbox: read-only,          approval: ask }
  workspace-write:    { sandbox: workspace-write,    approval: ask }
  danger-full-access: { sandbox: danger-full-access, approval: never }
```

用户可用 `/permission` 或界面切换，选择会写进该会话日志并跨重启保留。

### 2.6 现有的 approval 机制能复用什么、不能复用什么

- `ctx.approval.request({ agent, toolName, callId, reason, displayReason, signal })` → `allowed-once | rejected | cancelled | unavailable`。
- Web UI 已有审批气泡；但它只展示**工具名 + 理由**，不能展示/编辑文件内容 ⇒ **不能当 diff 审批用**，只能当"VS Code 不在线时的兜底确认通道"。
- 第三方插件 `dsh-checkpoint-rewind` 的注释提到：`approval.request` **要求有打开的 turn**，命令在 turn 之间跑时会直接失败关闭。我们的拦截发生在 turn 内，不受此限【已核实：第三方观察】。

### 2.7 先例：本机正在运行的第三方插件，用的就是我们要用的 hook

`~/.dsh/profiles/desktop/node_modules/dsh-checkpoint-rewind@0.6.24`：`index.mjs:918-925`【已核实】

```js
ctx.on('fs/write-intent', (target, actor, next) => snapshotPassThrough(...), { prepend: true })
ctx.on('fs/edit-intent',  (target, actor, next) => snapshotPassThrough(...), { prepend: true })
ctx.on('tools/pre-execute', (exec, next) => {
  if (getLive().mutationTools.includes(exec?.name)) return snapshotPassThrough(exec.agent.session, exec.name, next)
  return next()
}, { prepend: true })
```

它 `await` 了一次真实 git 快照后才 `next()` ⇒ **异步挂起 pre-execute 在生产版本上跑得通**，且 `{ prepend: true }` 的监听器顺序可用。它同时还注册了 command、tool、会话投影、设置页、自定义 client 面板 ⇒ **第三方 bundle 的完整能力边界已被验证**。

官方 experimental 包 `dsh-experimental-auto-review` 是另一个直接证据：它在 `tools/pre-execute` 前置挂一个 LLM 审查器，拒绝时回落到 `ask`，并由 permission 体系提供 "Auto" 档位。**"写前审查 + 人工兜底"是官方自己认可的架构。**

### 2.8 工具清单与并发模型（决定多文件审批怎么做）

本 profile 实际暴露的文件相关工具【已核实，`cordis_inspect_query Tool.listTools`】：`write`、`edit`、`bash`、`read`、`glob`、`grep`、`read_image`、`present`、`load_workspace_dependencies`；另有 `checkpoint`、`plugin_manager` 等具备写副作用的管理工具。

- `str_replace_editor`（`dsh-tool-str-replace-editor`）与 `create_worktree`（`dsh-experimental-tool-worktree`）**包存在但当前没挂载**；不同 preset 会挂载不同工具集 ⇒ 拦截名单必须**按实际注册表动态取**（`ctx.tools.schemas()` / `ctx.tools.get(name)`），不能硬编码。
- `isConcurrencySafe`：只有 `read` / `read_image` 声明为 true【已核实】⇒ `write`/`edit` 是**串行独占**执行。因此**多文件审批天然是一份一份到达的**，"全部接受"只能是"预授权窗口"而不是"一批已知 diff 一次决策"。
- PTC 模式（`run_code` 内嵌工具调用）也走同一流水线（`exec.parent` 非空），理论上同样被拦截，需实测【推断】。

### 2.9 Host 侧 IPC 完全可行

Host 是 Node 进程，插件代码在进程内执行，`node:net` / `node:fs` / `node:crypto` 均可用【已核实：`dsh-host-webserver` 自己就在用 `node:http`/`node:net`】。不需要动 Electron 主进程，也不需要 new 一个端口给浏览器——**用 Unix Domain Socket 即可**。

---

## 3. VS Code 侧能力验证

（独立调研结论，已核对 VS Code 1.144.0 的 `vscode.d.ts`）

| 方案 | 结论 | 置信度 |
|---|---|---|
| `vscode.diff(真实文件, 自定义 scheme)`，右侧由 `registerFileSystemProvider`（**不设** `isReadonly`）提供 | **首选**。左侧只读=Original，右侧是普通可编辑文档，用户改动经 `writeFile()` 回到扩展；原生 undo/主题/多光标/保存 | API 契约高；"自定义 scheme 在 diff 右栏可编辑"这一点官方文档没写死，**需 30 分钟 spike** |
| `vscode.diff` + `TextDocumentContentProvider` | **不可行**（该 API 按设计只读，没有写回路径） | 高（官方文档首句即 *readonly documents*） |
| Webview + Monaco `DiffEditor`（`originalEditable: false`） | **兜底**。可编辑性有保证、UI 完全可控；代价是放弃原生手感 + 数 MB 打包 + worker/CSP 配置 | 高（monaco 0.57.0 MIT，`originalEditable` 默认 false） |
| 复用 Copilot 的 edit-review UI | **不存在**。稳定版 `ChatResponseStream` 只有 markdown/anchor/button/filetree/progress/reference/push；`EditSession` 只存在于 proposed API | 高 |

其它要点：
- 扩展宿主是真实 Node ⇒ UDS 可用；`onUri` + `vscode://<publisher>.<ext>/...` 可以冷启动唤醒扩展。**建议扩展自建 UDS server，URI 只做唤醒握手**（`vscode:` scheme 可被伪造，URI 内容一律视为不可信输入）。
- **无法拦截保存**（`onWillSaveTextDocument` 只能追加编辑，没有取消令牌）⇒ 必须把 `writeFile` / `onDidSaveTextDocument` 当作"把最终内容回传 Agent"的通道，而不是确认门。**Accept 按钮必须由我们自己控制**，不能依赖"用户保存=同意"。
- 多文件 = 每个文件一个 diff 面板；`vscode.changes` 没有可编辑的审批流程。
- 打包：`engines.vscode: ^1.144.0`；1.74+ 命令/视图的 activation event 自动生成，但 `onUri` / `onWebviewPanel:<type>` 仍需显式声明；安装 `code --install-extension x.vsix`。

---

## 4. 推荐架构

### 4.1 两级模式（同一份插件代码）

**模式 A：工具级审批（默认，改动最小）**
会话文件策略保持默认 `workspace-write`；只拦截 `write` / `edit`（及将来任何注册为"文件写入"的工具）。
边界必须如实声明：**bash / pwsh / 子进程写入不受保护**。

**模式 B：严格审批（满足 plan.md §5 的强制安全要求）**
用户（或插件在会话建立时）把会话档位切到 `read-only`：

- Agent 的任何 `ctx.fs` 写入被 `dsh-fs-sandbox` 拒绝；
- Agent 的任何 bash 写入被 OS 沙箱拒绝（Seatbelt）；
- **唯一的写入路径**是：Agent 调 `write`/`edit` → 我们在 `tools/execute` 短路 → 用户在 VS Code 审批 → 受控提交服务以 `{ mode:'workspace-write', workspaceRoot }` **显式 per-call policy** 调 `ctx.fs.writeText`。
- 代价：Agent 不能跑会写盘的构建/安装命令。可用"命令白名单 + 单独审批"缓解，但那是另一个安全边界，不要混为一谈。

### 4.2 数据流

```
Agent 调 write/edit
   │
   ├─ tools/pre-execute → 记录 intent（谁、哪个文件、什么操作），allow
   │
   ├─ tools/execute 拦截（不调用 next）
   │     ├─ ctx.fs.resolve(path, {cwd})            ← realpath 归一
   │     ├─ stat → version V0 + readText → C0      ← 取原始内容与 CAS 基准
   │     ├─ 计算 proposed 全文 C1
   │     ├─ 生成 request {id, session, workspace, path, before:C0, after:C1, sha256×3, op, diff}
   │     ├─ 写暂存文件 ~/.dsh/pre-edit-review/staging/<id>.json (0600)
   │     └─ UDS → VS Code，await 决定（同时监听 exec.signal / 超时 / 断连）
   │
   ├─ Reject / 超时 / 断连 → 回 { isError:true, content:[Error: 用户拒绝…] }，不写盘
   │
   └─ Accept(finalContent C2)
         ├─ 用户改动过 → post-execute 追加一条 notice（"用户修改了提案"）
         ├─ ctx.fs.writeText(target, C2, { kind:'replaceIfVersion', version:V0 },
         │                   exec.signal, { mode:'workspace-write', workspaceRoot })
         │     └─ 版本不符 → FS_STALE_VERSION → 返回冲突错误，要求重新读取/重新提案
         ├─ ctx.emit('fs/observed', target, { kind:'present', version:V2 }, exec)
         ├─ 删除暂存文件，request 标记 consumed（幂等）
         └─ 返回合成成功结果 { path, operation, before:C0, after:C2 }
```

### 4.3 "proposed 全文"怎么算（按工具）

| 工具 | proposed 计算 | 备注 |
|---|---|---|
| `write` | 直接用 `args.content` | 最简单 |
| `edit` | 读原文 → 复刻 `applyLiteralEdit` 语义（CRLF 归一、唯一匹配、replaceAll） | 或用**更稳的"临时文件干跑"**：把 C0 写到临时文件 → `ctx.fs.editText` → 读回 C2'，语义 100% 一致 |
| `str_replace_editor` | `create`=file_text；`str_replace`/`insert` 需按行语义复刻 | 该工具当前未挂载，二期支持 |
| 未知/其他写工具 | **默认拒绝**（fail-closed），等确认语义后加白名单 | 对应 plan.md "无法确定是否可能修改原始文件 → 默认阻止" |

⚠️ **stat/read 的竞态**：只读版本 V0 与内容 C0 必须来自同一次稳定读取。安全做法是 `stat → read → stat`，两次 version 相同才继续，否则重试/失败关闭。（否则可能出现"版本比内容新"从而 CAS 误通过。）

### 4.4 IPC（UDS + JSON-RPC 2.0）

- Socket：`~/.dsh/pre-edit-review/ipc.sock`，目录 `0700`，socket 文件 `0600`，属主校验 + 首包 `hello{token, protocolVersion}`；token 由插件生成写 `0700` 目录内文件，VS Code 通过 `vscode://` URI 参数拿到一次性 nonce 再做握手。
- 谁做 server：**插件做 server，扩展做 client**（插件需要独立判断"客户端不在线 → fail-closed"，且日志/审计归插件）；扩展未启动时插件可 `open "vscode://…"` 唤醒它。
- 必备字段（覆盖 plan.md §2C）：`request_id`、`session_id`、`workspace_id`、`file_path`、`original_content`、`proposed_content`、`diff`、`operation_type`、`approval_status`、`final_content`、`error`。
- 生命周期：连接超时（5s）、审批超时（默认 10min，可配）、断连即取消、request_id **一次性消费**（重复 Accept 幂等丢弃）、响应必须携带 nonce+request_id 双校验（防伪造）。
- 大内容不走 socket：超过阈值时只传 `staging` 文件路径 + sha256（VS Code 侧读文件），避免 UDS 缓冲与日志泄漏。敏感内容不进普通日志（只记 path/sha256/长度）。

### 4.5 多文件与"全部接受"

- 串行到达 ⇒ UI 侧维护**队列 + 进度（第 k 个 / 已知 N 个未知）**；每来一个就并入面板。
- `Accept All` = 打开一个**预授权窗口**（例如"接下来 5 分钟内、本 turn 内、路径在工作区内的请求自动接受"），而不是"对一批已展示 diff 一次决策"。窗口到期自动关闭，且必须显式显示"自动接受中"。
- 进阶（Phase 3）：从 session log 读取当前 assistant message 里**尚未派发的同批 tool calls**，在第一个请求到达时就把整批 diff 一起呈现。技术上可行但依赖会话日志结构，放到后面。

### 4.6 建议目录

```
deepseek-pre-edit-review/
├─ packages/
│  ├─ dsh-pre-edit-review/                 # Host 侧 Cordis bundle（npm 包 + dsh.bundle.patch）
│  │  ├─ package.json                      # dsh.bundle.patch / engines.dsh / peerDeps
│  │  ├─ cordis.patch.yml                  # - insert: { id: pre-edit-review, name: ... }
│  │  ├─ src/
│  │  │  ├─ index.ts                       # apply(ctx): 注册 hook / prompt / 命令 / 服务
│  │  │  ├─ gate.ts                        # tools/pre-execute + tools/execute 短路
│  │  │  ├─ proposal.ts                    # 三种工具的 proposed 计算
│  │  │  ├─ commit.ts                      # CAS 提交 + fs/observed + 审计
│  │  │  ├─ ipc-server.ts                  # UDS server / JSON-RPC / 鉴权
│  │  │  ├─ staging.ts                     # 暂存 + 崩溃恢复
│  │  │  └─ protocol.ts                    # 共享类型（与扩展同源生成）
│  │  └─ locale/{en,zh}.json
│  └─ vscode-pre-edit-review/              # VS Code 扩展
│     ├─ package.json                      # engines.vscode ^1.144.0, onUri
│     ├─ src/{extension,ipc-client,proposal-fs,diff-panel,status-bar}.ts
│     └─ media/                            # 仅 Monaco 兜底方案需要
└─ docs/
```

### 4.7 模型侧的"告知"（很关键，否则体验会崩）

- `ctx.systemPrompt.section()` 加一段：*"修改文件请直接调用 write/edit；系统会先把提案交给用户审批，用户可能修改后再接受。不要因为 read-only 提示而拒绝尝试编辑。"*（checkpoint-rewind 与 auto-review 都用了这个 API【已核实】）。
- 拒绝时返回的 `Error:` 文案要让模型知道**可以重新提案**（而不是重试同一次调用）。

---

## 5. 安全边界（对照 plan.md §5）

| plan.md 要求 | 本方案 |
|---|---|
| 默认拒绝未审批写入 | 严格模式：沙箱层拒绝一切写，只有提交服务能写 ✅ |
| 审批前不改原文件 | ✅ 全程只读 + 暂存 |
| 不能通过 Bash/Python/Shell 绕过 | **仅严格模式成立**（OS 沙箱）；工具级模式不成立，必须声明 ❌/⚠️ |
| 检查所有可能改文件的工具 | `ctx.tools.schemas()` 动态枚举 + 未知写工具 fail-closed ✅ |
| 默认禁止工作区外写入 | `dsh-fs-sandbox` workspace-write containment（canonical realpath）+ 插件自身双检 ✅ |
| 拒绝过期审批 | 审批超时 + signal 取消 + 提交前 CAS ✅ |
| 防重复 Accept | request_id 一次性 + 幂等状态机 ✅ |
| 防 IPC 伪造 | 0600 socket + 首包 token + nonce + request_id 绑定 ✅ |
| 敏感内容不进日志 | 只记 path/sha256/长度；内容仅在内存/0600 暂存 ✅ |
| 崩溃时请求保持未提交 | 未 Accept 永远不写；重启后 staging 里的 pending 一律标 expired 并清理 ✅ |
| **不能只拦 write/edit** | 见上：这是本报告最重要的一条**限制**，不是实现细节 |

---

## 6. 对照 plan.md 的 8 条验收测试

| # | 测试 | 可行性 | 说明 |
|---|---|---|---|
| 1 | 普通文件修改：原文件不变，VS Code 自动弹 diff | ✅ | 模式 A 即可 |
| 2 | 编辑 Proposed：写入用户最终版本 | ✅ | 需 S1 短路验证；用户编辑后 `after` 用最终内容 |
| 3 | Reject：原文件 SHA-256 不变 | ✅ | 不写盘即成立 |
| 4 | 审批期间文件被外部修改：Accept 失败 | ✅ | `replaceIfVersion` → `FS_STALE_VERSION`（原子，非 TOCTOU） |
| 5 | Bash 写入不能绕过 | ⚠️ **仅模式下 B（read-only）成立** | 模式 A 下必然可绕过；必须按模式对外声明 |
| 6 | 多文件：独立审批 + 全部审批 | ✅（有条件） | 串行队列 + 预授权窗口；"同一批一次展示"需 Phase 3 |
| 7 | 客户端断开：无未批准写入 | ✅ | 断连即拒绝 |
| 8 | 重复 Accept：只提交一次 | ✅ | request_id 幂等 |

---

## 7. 风险清单

| ID | 风险 | 影响 | 概率 | 缓解 / 验证 |
|---|---|---|---|---|
| R1 | `tools/execute` 短路（不调 `next`）在真实 registry 中的行为未经验证 | 高（阻塞方案 E 的核心） | 中 | **S1 spike（0.5d）**；失败则退化为"改写 fs provider 做 overlay"或"两段式：先 deny 再自行写入并向模型追加 context" |
| R2 | `edit` 语义复刻不一致（CRLF、多匹配、行尾） | 中（proposed 与真实工具不一致） | 中 | 用"临时文件干跑"复用 `ctx.fs.editText` 本体；单测对齐 `applyLiteralEdit` |
| R3 | bash / 子进程绕过 | 高 | **确定发生**（模式 A） | 严格模式用 read-only 沙箱；产品文案明确两档差异 |
| R4 | 严格模式导致构建/安装不可用，模型误判"不能改代码" | 中 | 高 | systemPrompt 说明 + 拒绝文案 + 可选命令白名单（独立审批） |
| R5 | 工具参数里的 `sandbox_permissions` 升级字段被短路忽略，模型意图落空 | 中 | 中 | 短路时识别该字段：按"用户已审批 workspace-write"处理并回填说明；`danger-full-access` 一律拒绝 |
| R6 | Desktop 升级导致 hook/API 变化 | 中 | 中 | 固定 `engines.dsh`；启动自检（探测事件是否存在）；集成测试纳入 CI |
| R7 | PTC（`run_code`）内嵌调用路径未测 | 中 | 低 | spike 里加一个 PTC 用例 |
| R8 | VS Code 自定义 scheme 在 diff 右栏不可编辑 | 中 | 低 | **S2 spike（0.5d）**；失败切 Monaco Webview |
| R9 | 审批等待过长 / 用户走开 | 低 | 高 | 超时默认 10min + 状态栏倒计时；超时=拒绝并提示可重提 |
| R10 | 大文件（>10MB）、二进制、无权限文件 | 低 | 中 | 拦截层上限 + 明确错误；二进制拒绝 |
| R11 | 崩溃恢复语义 | 中 | 中 | staging 0600 + 启动清扫；pending 一律 expired |
| R12 | 多扩展/多窗口同时连接 | 低 | 低 | 单 client 锁 + 窗口标识 |

---

## 8. 开工前必须做的 3 个 spike（合计 ≈1.5 天）

**S1（0.5d）Host 短路验证** — 决定项目能不能按推荐架构走
1. 生成一个最小 bundle：`tools/execute` 监听 `write`，不调 `next()`，自行把 `"HELLO"` 写进一个 scratch 文件，返回 `{ isError:false, value:{ path, operation:'update', before, after:'HELLO' } }`。
2. 用 `plugin_manager install_bundle`（或 `dsh plugin --profile desktop add <path>`）装进 `desktop` profile。
3. 让 Agent 对 scratch 文件调用 `write`。
- **通过标准**：文件内容为 `HELLO`（不是 Agent 给的内容）、不报 schema 错误、模型看到成功、Web UI 卡片正常、`fs/observed` 版本正确、后续 `edit` 不报 stale。
- **失败预案**：改用 `tools/pre-execute` 返回 `deny` + 之后用 `post-execute` 替换 content，并追加 `additionalContexts`（模型会看到"已按用户修改保存"）；或改为包装 `ctx.fs` 的 overlay provider。

**S2（0.5d）VS Code 可编辑 diff 验证**
1. 最小扩展注册 `agentproposal:` FileSystemProvider（可写，不设 `isReadonly`），用 `vscode.diff` 打开 `<真实文件> ↔ agentproposal:<id>`。
2. 在右栏输入并保存，`writeFile` 回调里拿到最终字节。
- **通过标准**：右栏可编辑、可保存、`writeFile` 收到用户最终内容；左栏不可编辑。
- **失败预案**：Monaco Webview `DiffEditor`（`originalEditable:false`）。

**S3（0.5d）严格模式闭环验证**
1. 会话切到 `read-only` 预设；确认 `write` 与 `bash 'echo x > f'` 都被拒绝。
2. 插件以显式 `{mode:'workspace-write', workspaceRoot}` 调 `ctx.fs.writeText` → 成功；再用过期 version 提交 → `FS_STALE_VERSION`。
- **通过标准**：三条全过 ⇒ 即可宣称"审批前不改原文件 + bash 不可绕过"。

---

## 9. 建议执行计划

| 阶段 | 内容 | 估时 | 出口标准 |
|---|---|---|---|
| Phase 1.5 | S1/S2/S3 三个 spike | 1.5d | 三份 spike 报告 + 若 S1 失败则改架构方案 |
| Phase 2 MVP | 模式 A：write/edit 拦截 + UDS + VS Code 可编辑 diff + Accept/Reject + CAS 提交 + 单测 | 2 周 | 测试 1/2/3/4/7/8 通过 |
| Phase 3 | 多文件队列 + Accept All 窗口 + 语法高亮/行号/行级 diff + 审批历史 + str_replace_editor | 1.5 周 | 测试 6 通过；UI 达到"可日常使用" |
| Phase 4 | 严格模式（read-only 预设 + 提示词 + 冲突/崩溃/幂等加固 + 审计） | 1 周 | 测试 5 通过；安全边界文档定稿 |
| Phase 5 | VSIX 打包 + bundle 安装脚本 + 文档（安装/配置/故障排查） | 1 周 | 干净机器可一键安装 |
| 后续 | 工作区隔离方案（`create_worktree` + 提交服务），彻底解决"Agent 自由写但原始工作区不动" | — | 计划里的"我的技术建议"终态 |

---

## 10. 与 plan.md 中若干"建议"的取舍（明确回答）

| plan.md 建议 | 结论 |
|---|---|
| 优先使用官方 pre-execute hook | ✅ 存在且可异步挂起，就用它 |
| 如果 API 无法在工具执行前拦截并挂起，必须明确报告 | ✅ 可以拦截并挂起，不需要造假 |
| 不允许用事后 rollback 冒充审批 | ✅ 本方案不依赖任何回滚 |
| 不能只拦 write/edit，要考虑 bash | ✅ 结论：拦截无法覆盖 bash；必须用会话 `read-only` 沙箱作为强制边界（DSH 内置） |
| 建议长期用"独立暂存区 + 受控 Commit Service" | ✅ 我们的"短路 + 提交服务"就是它的最小形态；终态可用 `create_worktree` 做物理隔离 |
| IPC 用 macOS UDS + JSON-RPC | ✅ 完全可行 |
| UI 用 Webview 或 Custom Editor，右侧可编辑 | ✅ 首选 `FileSystemProvider` + 原生 diff；Monaco 兜底 |
| 不允许修改 Desktop 内部文件 | ✅ 全程只通过 profile bundle 安装，不碰 `app.asar` |
| 不得假设 CLI/Web/Desktop 配置一致 | ✅ 已实测：profile 目录与组合不同；hook 契约来自同一 `dsh-tools` 版本 |

---

## 附录 A：证据获取方式（可复现）

- 版本/组合：`app.asar/dsh/package.json`、`~/.dsh/profiles/desktop/{package.json,cordis.patch.yml}`、`~/.dsh/profiles/web/package.json`。
- 工具流水线：`extract app.asar → dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`（pre-execute `:3321`、execute `:3427`、serviceAsk `:3535`、normalize `:3669`），README 的 *Execution and cancellation* / *Known Limitations*。
- 文件层：`dsh-fs-local/lib/index.js`（`writeText` `:864`、`applyLiteralEdit` `:698`）、`dsh-fs-sandbox/lib/index.js:125-164`、`dsh-sandbox-policy/lib/index.js:31,141`。
- 组合与档位：`dsh-base/cordis.patch.yml:239-300,516-520`。
- 工具输出结构：`dsh-tool-fs/lib/index.js`（write 输出 `:564`、edit 输出 `:714`、`mutationResult` `:492`）。
- 第三方先例：`~/.dsh/profiles/desktop/node_modules/dsh-checkpoint-rewind/index.mjs:918-925`；`dsh-experimental-auto-review/README.md`。
- VS Code：本机 1.144.0 的 `vscode.d.ts`；官方 virtual-documents / activation-events / webview / extension-host 文档。

## 附录 B：本报告未能验证的项（如实列出）

1. `tools/execute` 短路在真实 registry 中的行为（无官方先例）→ S1。
2. 自定义 scheme 文档在 diff **modified** 栏是否可编辑（文档未写死）→ S2。
3. PTC `run_code` 内嵌工具调用是否同样被拦截 → spike 加用例。
4. Monaco worker 在真实 Webview 中的加载（仅兜底方案才需要）。
5. Marketplace 单包体积上限（服务端限制，官方文档未给出数字）。
6. 第三方观察：`approval.request` 需要打开的 turn（来自 checkpoint-rewind 注释，未在官方源码注释中复核）。
