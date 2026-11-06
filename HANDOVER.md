# 项目交接文档 — DeepSeek Pre-edit Review

> 面向接手本项目的工程师 / Agent：目标是**快速、安全地**理解、运行、修改并发布本项目。
> 本文件是入口；细节以各专题文档与源码注释为准。**如果你改动了架构/流程，请同步更新本文件。**
>
> 最后更新：2026-11-06（0.3.0 / ADR 0002：默认未启用 + 多 Host 共存）。此前 30 个提交、tag `v0.2.5`。

---

## 0. 一页速览

**它是什么**：DeepSeek Harness（DSH）的 Agent 在改文件之前，先把修改变成 VS Code 里的**可编辑左右分栏 diff**；用户在 VS Code 点 **Accept** 之后才真正写入原文件。Reject 则原文件字节不变。

**0.3.0 的两个重要变化（先读 ADR 0002）**

1. **安装 ≠ 自动审查**：插件默认「未启用」，不拦截任何写入；用户在某个会话里 `/review on` 之后，该会话的写操作才进入审批。
2. **多 Host 共存**：每个 Host（DSH profile 的一个进程实例，如 `desktop` 与 `dsh-tui`）在
   `<stateDir>/hosts/<hostKey>/` 下有独立的 socket/token/staging/audit；VS Code 扩展会同时连接所有 Host，并按请求来源路由决策。

**组成**（两个独立发行物 + 一个共享协议包）：

| 组件 | 位置 | 发行物 | 版本 |
|---|---|---|---|
| DSH Host 插件 | `packages/dsh-plugin` | npm `dsh-pre-edit-review` | **0.3.0**（未发布；npm 上是 0.2.1） |
| VS Code 扩展 | `packages/vscode-extension` | VS Marketplace `The4leepy.deepseek-pre-edit-review` + Release VSIX | **0.3.0**（未发布；Marketplace 上是 0.2.5） |
| 共享协议/契约 | `packages/shared` | 不独立发布（构建内联） | — |

**已发布渠道**（截至 0.2.x）：

- GitHub：<https://github.com/The4leepy/dsh-pre-edit-review>（tag `v0.2.5`）
- VS Code Marketplace：`The4leepy.deepseek-pre-edit-review@0.2.5`
- npm：`dsh-pre-edit-review@0.2.1`（`latest`）
- DSH 插件索引（format 1，npm 源）：`https://raw.githubusercontent.com/The4leepy/dsh-pre-edit-review/main/market/index.json`
- 0.3.0 发布清单见 [docs/publish.md](docs/publish.md) §8.1；**发布顺序：先扩展、后插件**（0.2.x 扩展连不上 0.3.0 Host）。

**最重要的规则（违反会破坏安全模型或发布流程）**

1. **审批前绝不写原文件。** 唯一允许写用户工作区的代码是 `CommitTarget`（`packages/dsh-plugin/src/targets/*`）；任何其他模块不得调用 `ctx.fs.writeText`（`pnpm run check:boundaries` 会拦截）。
2. **默认未启用是产品语义，不是故障。** 未启用时会话照常直写；只有 `/review on` 之后才审查。Agent 的工具、IPC、配置**都不能**打开或关闭审查（只有用户会话命令可以）。
3. **每个 Host 一个命名空间。** 不要手工把 token/socket/staging 在 Host 之间搬移或合并；`<stateDir>/DISABLED` 是**全局**急停，会影响所有 Host。
4. **安装插件前先 arm kill switch**：`touch ~/.dsh/pre-edit-review/DISABLED`。插件挂载在全局工具流水线，首次安装若自身故障会拖垮所有工具（历史事故 §6.4）。
5. **只有严格模式（`/review strict`，会话 `read-only`）能防止 bash/脚本绕过**；工具级模式只拦工具写入，文档与 `/review status` 必须如实说明。
6. **提交身份必须保持 `The4leepy` 唯一作者**（single-maintainer 模型，见 `CONTRIBUTING.md` / `docs/publish.md` §1.3）：不要 `Co-authored-by`、不要合并外部 PR、不要用其他身份提交。

**10 秒自检**

```bash
pnpm run check        # typecheck + 依赖边界 + 全部单测 + market 索引校验
pnpm run build        # 插件 bundle + 扩展 bundle
scripts/doctor.sh     # 扩展/插件/每个 Host 的状态目录/socket/token/kill switch
git log --oneline -5 && git status --short
```

---

## 1. 新 Agent 上手路径

### 1.1 必读顺序（约 30–40 分钟）

1. **本文件**（架构、规则、工作流、坑）
2. [docs/adr/0002-opt-in-activation-and-multi-host.md](docs/adr/0002-opt-in-activation-and-multi-host.md)（0.3.0 契约：会话级启用 + 多 Host）
3. [README.md](README.md)（定位、安装、状态）
4. [docs/security.md](docs/security.md)（威胁模型、保证矩阵、默认未启用的语义、已知限制）
5. [docs/usage.md](docs/usage.md)（交互、决策入口、运行状态、命令）
6. [CHANGELOG.md](CHANGELOG.md)（注意历史条目里的 "bypass/放行/暂停" 是旧称）
7. [docs/install.md](docs/install.md) + [docs/troubleshooting.md](docs/troubleshooting.md)（安装顺序、多 Host 故障恢复）
8. 若涉及发布：[docs/publish.md](docs/publish.md)
9. 源码入口：`packages/dsh-plugin/src/index.ts`（Host 插件 `apply`）、`packages/dsh-plugin/src/activation.ts`（会话启用）、
   `packages/dsh-plugin/src/paths.ts`（Host 命名空间）、`packages/vscode-extension/src/extension.ts`（多 Host 会话管理）、
   `packages/vscode-extension/src/host-registry.ts`（发现）、`packages/shared/src/protocol.ts`（协议）

可选：`docs/design-plan.md`（最初需求）、`docs/m1-status.md` … `docs/m5-status.md`（阶段验收，历史）、
`docs/interaction-test-2026-11-05.md`（真实人工联调记录）。

### 1.2 本机环境事实（2026-11-06 实测）

| 项 | 值 |
|---|---|
| DSH | **0.2.2-rc.1**（Desktop app + `dsh` CLI 都在；CLI 位于 `/opt/homebrew/bin/dsh`） |
| DSH profile | `desktop` → `~/.dsh/profiles/desktop`；另有 `dsh-tui` → `~/.dsh/profiles/dsh-tui` |
| 插件安装形态 | 发布前联调用 **本地 `link:` 0.3.0** 装入两个 profile；发布后应改回 npm `0.3.0` |
| 当前挂载状态 | 两个 profile 的 bundles 都包含 `dsh-pre-edit-review`；Desktop 与 TUI 两个 Host 可同时运行（0.3.0 起） |
| 运行时状态目录 | `~/.dsh/pre-edit-review`：0.3.0 起为 `hosts/<hostKey>/{ipc.sock,token,meta.json,staging,audit}`（根目录旧的 socket 会被自动清理） |
| VS Code | **1.145.0** 正在运行；扩展 `the4leepy.deepseek-pre-edit-review@0.2.5` 已安装 |
| 平台 | macOS arm64；Windows/Linux 未验证 |
| 工程环境 | Node v26（要求 ≥22.19）、pnpm 12.5.1、TypeScript 5.9、esbuild、vsce 4 |

> ⚠️ **本机 profile 里插件依赖仍在**。如果你是新的 Agent 会话：
> - 默认未启用时，你的 `write`/`edit` **不会**被拦截；
> - 若某个会话 `review/activated`（看 `~/.dsh/pre-edit-review/hosts/*/audit/*.jsonl`），那个会话才需要审批；
> - 不要擅自替用户切换 profile 挂载/启用审查/开 kill switch。

### 1.3 开始工作的 10 分钟检查清单

- [ ] `git status --short` 知道当前改动、`git log -1` 知道 commit
- [ ] `pnpm run check` 通过（typecheck + boundaries + 全部单测 + market 索引）
- [ ] `scripts/doctor.sh` 输出符合预期（无 FAIL；0.3.0 Host 会显示 `hosts/<key>/`）
- [ ] 确认当前 DSH profile 插件版本与挂载状态（npm vs 本地 link；是否在 bundles；是否 paused/activated；是否有 kill switch）
- [ ] 知道如何安全安装/卸载（§7.3），以及如何在不触发审批的情况下改仓库文件（§7.1）
- [ ] 明确"禁止事项"（§7.6）

---

## 2. 当前仓库状态与历史

### 2.1 版本与发布

| 项 | 值 |
|---|---|
| 根 `package.json` version | `0.3.0`（private，仅用于工作区脚本） |
| 插件 `packages/dsh-plugin/package.json` | `0.3.0`（npm 上最新仍是 0.2.1） |
| 扩展 `packages/vscode-extension/package.json` | `0.3.0`（Marketplace 上最新仍是 0.2.5） |
| git tag | 最新 `v0.2.5`；`v0.3.0` 待发布时打 |
| 远程 | `origin = git@github.com:The4leepy/dsh-pre-edit-review.git`（main） |

> 0.3.0 把插件与扩展版本统一，解决了 0.2.x 的版本号不一致。

### 2.2 里程碑时间线（git log 摘要）

| 阶段 | 内容 |
|---|---|
| Phase 1.5 (M1) | 可行性 spike S1/S2/S3；冻结 `packages/shared` 接口（ADR 0001 `CommitTarget`） |
| Phase 2 (M2) | Host 全链路（gate→staging→IPC→commit）、VS Code 客户端、`/review` 命令、E2E；**插件自锁事故**（缺 `inject`）→ kill switch/挂载自检 |
| M2.1/M2.2 UX | 决策入口收敛到编辑器标题栏 ✓/✗；移除重复入口 |
| Phase 3 (M3) | 多文件 Pending/History 视图、批量 Reject All、`str_replace_editor` 提案、`/review history` |
| Phase 4 (M4) | 严格模式整会话 E2E、IPC nonce/帧上限、崩溃对账（`recovery.ts`）、`docs/security.md` |
| Phase 5 (M5) | 安装/卸载/体检脚本、LICENSE/CHANGELOG、安装/使用/排障文档 |
| 交互测试与修复 | 快捷键修复（Ctrl+Alt+A/R）、bypass → `/review off` 暂停语义、5 秒状态栏消息（0.2.5） |
| 公开发布 | GitHub 仓库/CI/Release、npm 0.2.1、Marketplace 0.2.5、DSH format-1 索引 |
| 0.3.0（ADR 0002） | **默认未启用 + 会话级 `/review on`**；**按 Host 隔离 socket/token/staging/audit**；扩展多 Host 连接与路由；IPC bind-before-token、stop 不误删 socket、`HOST_IN_USE` |

### 2.3 当前本机环境快照（开发 0.3.0 时）

- 两个 profile 都安装本地 `link:` 0.3.0；Desktop 与 TUI 两个 Host 同时运行的联测已通过；
- `~/.dsh/pre-edit-review/hosts/{desktop,dsh-tui}/` 各有一套 socket/token/staging/audit；旧根目录 socket 已被自动清理；
- VS Code 运行中，扩展 0.3.0（含 `⌘+Shift+A` / `⌘+Shift+Backspace` 与双 Host 连接）；仓库工作树含 0.3.0 改动。

---

## 3. 系统架构

### 3.1 组件与数据流

```
Agent 工具调用 (write / edit / str_replace_editor)
        │
        ▼  DSH Host 进程（Cordis 插件运行时；每个 profile 一个独立进程）
┌──────────────────────────────────────────────────────────────┐
│ packages/dsh-plugin  (bundle: cordis.patch.yml → dist/index.mjs) │
│                                                              │
│  gate.ts            tools/execute prepend 监听器             │
│    ├─ killSwitch.active()        → 直接放行（全局急停）      │
│    ├─ activation.isActive(agent) → 未启用则直接放行（默认）  │
│    ├─ classifier.classify()      → pass / deny / review      │
│    └─ review 时调用 coordinator.review(exec)，不调 next()    │
│                                                              │
│  activation.ts      会话级启用注册表（内存、用户命令才可写） │
│  paths.ts / registry.ts  hostKey → hosts/<key>/ 命名空间+meta │
│                                                              │
│  review-coordinator.ts                                       │
│    ① target.prepare()       解析路径 + stat→read→stat 快照   │
│    ② proposal.ts            write/edit/str_replace_editor    │
│    ③ staging/store.ts       落盘 pending（0600，按 Host）    │
│    ④ ipc/server.ts          通过 UDS 发 review/request       │
│    ⑤ 等待 decision（内联完成提交）                           │
│    ⑥ targets/direct-workspace.ts  CAS + 原子写 + fs/observed │
│    ⑦ 返回合成的 ToolExecutionResult                          │
│                                                              │
│  runtime.ts  组装 paths/store/ipc/coordinator/activation/target│
│             启动时写 meta.json、expirePending+reconcile      │
└──────────────────────────────────────────────────────────────┘
        │ Unix domain socket: <stateDir>/hosts/<hostKey>/ipc.sock
        │ JSON-RPC 2.0 over NDJSON；token 鉴权 + nonce + 8MiB 帧上限
        ▼
┌──────────────────────────────────────────────────────────────┐
│ packages/vscode-extension                                    │
│  host-registry.ts   扫描 hosts/*/meta.json（+ legacy 根布局）│
│  ipc-client.ts      每 Host 一条连接（token 各自读取）       │
│  review-session.ts  每个 Host 一个 session：pending/diff/决策│
│  extension.ts       多 session 管理、路由、状态栏/命令/上下文│
│  tree-views.ts      Pending/History（行内显示 Host 标签）    │
│  fs-provider.ts     可写 dpr: FileSystemProvider（按 Host 唯一）│
│  self-test.ts       进程内 mock Host（含双 Host 阶段）       │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
   用户：编辑器标题栏 ✓/✗（或快捷键）→ decision → 签发它的 Host
```

**关键设计点**

- `tools/pre-execute` 不能替换结果、也不能改写 `exec.arguments`，所以内容替换必须在 `tools/execute` 包裹层**短路**（不调用 `next()`）并自行写盘，再返回符合工具 output schema 的**合成成功值**。
- 合成结果结构：`write` → `{path, operation, before, after}`；`edit` → `{path, before, after}`；`str_replace_editor` → `string`。见 `review-coordinator.ts` 的 `successValueFor`。
- 写盘只走 `CommitTarget.commit`：CAS + 临时文件原子 rename + 保留权限 + realpath containment；成功后 `ctx.emit('fs/observed', …)`。
- 用户 Accept 的内容 = 用户最终编辑的内容；若用户改过提案，会通过 `tools/post-execute` 追加提示。
- 失败语义全部 **fail-closed**（只在会话已启用时有意义）：异常/超时/取消/断连/无客户端/CAS 冲突 → `isError` 且不写盘。
- **未启用 = 什么都不做**：gate 只做 kill switch + 内存 Map 查询，然后 `next()`；不查工具注册表、不碰 coordinator/staging/IPC。

### 3.2 运行状态矩阵

| 状态 | 如何进入 | 审批 | 能防 bash 写? | 可见性 |
|---|---|---|---|---|
| **未启用（安装默认）** | 默认 / `/review off` | 不拦截（直接写） | 不适用 | 状态栏 `· 未启用`；`/review status` 显示 INACTIVE |
| 工具级 | 用户在会话 `/review on` | 拦截工具写入 | ❌ 明确声明不防 | 状态栏普通 |
| 严格 | 用户 `/review strict`（会话 `read-only`） | 全部写入需审批（唯一写路径是受控提交） | ✅ OS 沙箱 | 状态栏/status 显示 |
| 急停 kill switch | 文件 `<stateDir>/DISABLED`（全局） | 全部旁路 | — | 启动日志 WARN；doctor WARN |
| 无客户端 fallback | 配置 `fallback: 'dsh-approval'` | 走 DSH 自身审批（不能编辑内容） | — | — |
| Auto-Accept 窗口 | 扩展设置 + `dpr.acceptAll` 显式点击 | 5 分钟内自动接受 | — | 状态栏 `AUTO-ACCEPT` |

> **审查开关与沙箱解耦**：`/review on|off` 只决定是否审查；`/review strict|balanced` 只改沙箱。
> 严格模式 + 未启用 ⇒ 写入被 OS 沙箱直接拒绝（不会走审批提交）。
> 启用/关闭只能由**用户在会话命令**里触发（`activation.ts` 不变量）；内存态，Host 重启回配置默认（安装默认未启用）。
> 子代理/团队成员会话是**独立会话**，需要在各自会话启用（已知限制）。

### 3.3 一次 Accept（含用户编辑）的时序

```
用户 /review on（本会话）
Agent → gate(intercept) → coordinator.prepare → staging(pending, 本 Host)
  → ipc review/request → extension 找到签发 Host 的 session
  → 打开 dpr: diff（左=真实文件，右=可编辑）
  → 用户编辑右栏 → 点标题栏 ✓（Ctrl+Alt+A）
  → extension decision {requestId, nonce, status:'accept', finalContent} → 该 Host 的 IPC
  → coordinator.handleDecision → restoreLineEndings → CommitTarget.commit(CAS)
  → staging(committed) → audit → 合成成功值 → 模型继续
```

---

## 4. 代码地图（要改什么去哪里）

### 4.1 `packages/shared`（无运行时依赖，构建时内联）

| 文件 | 作用 |
|---|---|
| `src/protocol.ts` | 协议 v1：方法名、参数/结果类型、校验、NDJSON framing；`PROTOCOL_VERSION=1`；可选 `hostKey/hostLabel`；`paused`（语义见 §5.1） |
| `src/host.ts` | 多 Host 发现契约：`HostDescriptor`、`isHostDescriptor`、`sanitizeHostKey`、`HOSTS_DIR_NAME` |
| `src/commit-target.ts` | `CommitTarget` / `FileSnapshot` / `CommitPrecondition` / `CommitResult` / `CommitConflict` / `InspectResult` / `CommitTargetHost` |
| `src/review-record.ts` | staging 记录与状态机、`canTransition` |
| `src/text.ts` | 行尾归一/恢复、字面替换、出现次数 |
| `src/hash.ts` | SHA-256、随机 hex（token/nonce） |

### 4.2 `packages/dsh-plugin`（Host 插件；`dist/` **被提交**以便 DSH git 源安装）

| 文件 | 作用 / 修改注意 |
|---|---|
| `src/index.ts` | 插件入口 `apply(ctx, rawConfig)`：`inject=['fs','tools']`、能力自检、装配 runtime、注册 gate/post-execute/`/review` 命令/prompt 段落。**不要删 `inject`**。 |
| `src/gate.ts` | `tools/execute` prepend 拦截；kill switch → **activation** → classifier；fail-closed 边界。 |
| `src/activation.ts` | 会话级启用注册表（替代旧 `pause.ts`）：`sessionKeyOf`、`isActive`、`set`、`forget`、`anyInactive`；同步、无 I/O；会话销毁时由 `index.ts` 剪枝并刷新客户端指示。 |
| `src/paths.ts` | `resolveHostKey`（config → profileContext → `DSH_PROFILE` → default）与 `resolveHostPaths`（hosts/<key> 布局）。 |
| `src/registry.ts` | 原子写/删 `<hostDir>/meta.json`（shared `HostDescriptor`，0600）。 |
| `src/ipc/server.ts` | UDS 服务端：**先 bind 后原子发布 token**、只删自己 bind 的 socket、typed `HostInUseError`、nonce/8MiB/单客户端。 |
| `src/classifier.ts` | review/pass/deny：allowlist + `presentCall` diff 启发式 + 名字正则 + `unknownToolPolicy`。 |
| `src/proposal.ts` | `write`/`edit`/`str_replace_editor` 提案全文；前置条件失败 → `passthrough`。 |
| `src/review-coordinator.ts` | 全链路编排 + 决策处理 + 合成结果；`pathArgument`/`successValueFor` 与工具集同步。 |
| `src/targets/direct-workspace.ts` | 唯一写路径：prepare/commit/inspect、CAS、原子写、containment、`fs/observed`。 |
| `src/targets/git-worktree.ts` | **预留 stub**（`NOT_IMPLEMENTED`）。 |
| `src/staging/store.ts` | 0600 原子写、状态机、`expirePending`、审计 JSONL；`dir` 现在是 host 目录。 |
| `src/recovery.ts` | 启动只读对账（按 Host 自己的 staging 目录）。 |
| `src/kill-switch.ts` | 全局 `DISABLED` 检测（1s 缓存）。 |
| `src/history.ts` | 审计 JSONL 读取/格式化（`/review history`，读本 Host 的 audit 目录）。 |
| `src/config.ts` | 配置 schema/默认值/校验（§5.5）。 |
| `src/host.ts` | 对 DSH 服务的 duck-type 视图（**不 import `@deepseek-ai/*` 运行时**）。 |
| `src/runtime.ts` | 组装 + 启动顺序（paths→store→ipc→meta→expire→reconcile）+ IPC mode 推送；`PLUGIN_VERSION`。 |
| `cordis.patch.yml` | bundle 安装行（`id: pre-edit-review`；设置 `defaultActive: false` 作为安装默认）。 |
| `build.mjs` | esbuild → `dist/index.mjs`（ESM，node22）。 |
| `dist/index.mjs` | **提交到 git**（`.gitignore` 特例）：改源码后必须重新 `pnpm run build:plugin` 并提交 dist。 |

### 4.3 `packages/vscode-extension`

| 文件 | 作用 |
|---|---|
| `src/extension.ts` | `activate()`：**多 Host `Map<hostKey, ReviewSession>`**、发现轮询、路由、状态栏（聚合）、命令、上下文键、配置监听、自检调度。 |
| `src/host-registry.ts` | **无 vscode 依赖**的发现模块：扫描 `hosts/*/meta.json` + legacy 根布局，校验路径包含关系、pid 存活；可单测。 |
| `src/ipc-client.ts` | 每 Host 一条 UDS 连接：token 路径可配置、hello、3s 退避重连、decision RPC、通知分发、`paused` 状态。 |
| `src/review-session.ts` | 每 Host 一个会话：pending 队列、打开/聚焦 diff、accept/reject/acceptAll/rejectAll、断连清理、5s 消息。 |
| `src/fs-provider.ts` | `dpr:` 可写 FileSystemProvider（diff 右侧可编辑）；提案 URI 含 Host 前缀保证全局唯一。 |
| `src/tree-views.ts` | Pending/History 聚合视图（显示 Host 标签）。 |
| `src/history-store.ts` | `workspaceState` 历史（最近 50 条、按 requestId 覆盖、含可选 `hostKey`、损坏容错）。 |
| `src/i18n.ts` | en / zh-CN 全部用户文案（**新增文案两份都要加**）。 |
| `src/self-test.ts` | 进程内 mock Host 自检（含多 Host 阶段）；写 `<workspace>/.spike/ext-selftest.json`。 |
| `src/util.ts` | `~` 展开、basename、delay、错误文案、`clampMessageDuration`。 |
| `package.json` | 贡献点：命令/菜单/快捷键/视图/设置/`viewsWelcome`；publisher `The4leepy`，版本 0.3.0。 |
| `package.nls.json` / `.zh-cn.json` | 命令/设置/欢迎页文案（manifest 用 `%key%`）。 |
| `media/icon.svg` / `icon.png` | 活动栏图标 / Marketplace 图标（原创，勿换第三方素材）。 |
| `build.mjs` | esbuild CJS 单文件 → `dist/extension.js`。 |

### 4.4 其他

| 路径 | 作用 |
|---|---|
| `scripts/_common.sh` | 脚本共用：仓库根、profile/state 路径、`code`/`dsh` 探测、kill switch、安装检测。 |
| `scripts/install-extension.sh` | 安装/`--build` 重打包 VSIX。 |
| `scripts/install-plugin.sh` | **先 arm kill switch** 再装插件；有 `dsh` CLI 时直接安装。 |
| `scripts/uninstall.sh` | 移除扩展+插件注册；`--purge` 删状态目录（含 hosts/）。 |
| `scripts/doctor.sh` | 体检（扩展/插件/每个 host 的 meta/socket/token/kill switch）。 |
| `scripts/e2e-client.mjs` | 假审批客户端（accept/edited/reject/conflict/double-accept/ignore；`--host-key` 选命名空间）。 |
| `scripts/check-boundaries.mjs` | 依赖方向守卫（CI 一部分）。 |
| `scripts/build-market-index.mjs` / `check-market-index.mjs` | 生成/校验 `market/index.json`（CI 一部分）。 |
| `packages/spikes/*` | M1/严格模式探针（dist 未提交，使用前需 build）。 |
| `test/` | `node --test` 单测（清单见 §8）。 |
| `.github/workflows/ci.yml` | push/PR：install → check → build（ubuntu, node 24）。 |
| `.github/workflows/release.yml` | tag `v*`：check/build → 打 VSIX + npm tgz → GitHub Release。 |
| `market/index.json` + `market/README.md` | DSH format-1 自托管索引（npm 源）。 |
| `docs/` | 专题文档与 `evidence/`。 |

---

## 5. 协议与数据契约

### 5.1 IPC 协议（`packages/shared/src/protocol.ts`）

- 传输：Unix domain socket `<hostDir>/ipc.sock`（0600），**JSON-RPC 2.0 + NDJSON**。
  进程内 reload（HMR）时新旧 runtime 通过进程级 owner slot 串行化：旧实例 `close()` 完成后新实例才 bind（libuv 在 close 时会 unlink socket 路径）；`stop()` 还要求路径 inode 仍是自己绑定的那个才 unlink。
- **每个 Host 独立**：token 在 `<hostDir>/token`（0600，bind 成功后原子发布）；一个 Host 只有一个客户端。
- 鉴权：首帧 `hello {token, protocolVersion:1, client:{name,version}}`；token 错 → `-32001` 并断开。
- 单帧上限 8 MiB（每连接），超限断开。
- 请求（扩展 → Host）：`hello`、`decision`、`ack`、`ping`、`autoAccept`。
- 通知（Host → 扩展）：`review/request`、`review/cancel`、`review/state`、`review/mode`、`server/shutdown`。
- `decision` 必须携带与 pending 请求匹配的 `nonce`；不匹配 → `-32001` 且请求保持 pending。重复/未知 requestId → `{outcome:'already-decided'}`。**协议里没有任何"写任意文件"的方法。**
- **0.3.0 新增（全部可选、向后兼容）**：`hello.result.hostKey/hostLabel`、`review/request.params.hostKey/hostLabel`；`PROTOCOL_VERSION` 仍为 1。
- `paused` 语义（0.3.0 起）：**"该 Host 上没有活跃的审查会话，或急停已生效"** —— `defaultActive:true` 时等价旧暂停；`defaultActive:false` 时为"还没有会话启用"。会话销毁时 `activation.forget()` 会剪枝并推送新状态，所以指示器不会因为"上一个会话曾开启"而在新会话上错误显示为开启。`bypass` 仅作 legacy 接受。

`review/request.params` 关键字段：`requestId, nonce, protocolVersion, createdAt, expiresAt, sessionId, sessionLabel, toolName, callId, operation, displayPath, absolutePath, isNewFile, languageHint?, before, after, beforeSha256, afterSha256, targetKind, mode, hostKey?, hostLabel?`。

### 5.2 ReviewRecord 与状态机

staging 记录（JSON，0600）核心字段：

```
requestId, nonce, protocolVersion, createdAt, expiresAt,
sessionId, sessionLabel, agentId?, workspaceRoot?,
toolName, callId, operation, targetKind,
displayPath, absolutePath,
before, beforeSha256, proposed, proposedSha256,
lineEndings ('LF'|'CRLF'), mode ('tool-level'|'strict'),
state, decision?{status,by,reason?,finalContentSha256,decidedAt}, commit?{at,code,message}
```

状态迁移：`pending → decided | rejected | expired | cancelled | failed`；`decided → committed | conflict | failed`；终态不可变。
- 拒绝/超时/断连/无客户端：不写盘。
- 提交前 CAS 失败（文件被外部改）→ `conflict`，不重试覆盖。
- Host 崩溃后启动：`expirePending()` + `reconcileStaging()`（见 `recovery.ts`），**只看自己 Host 的 staging**，绝不重放提交。

### 5.3 目录布局

```
<stateDir> = ~/.dsh/pre-edit-review (0700)
├── DISABLED                      # 全局急停开关（所有 Host）
└── hosts/<hostKey>/              # 每个 Host 实例一份（0700）
    ├── ipc.sock                  # UDS（0600）
    ├── token                     # 32 字节 hex，每次该 Host 启动重新生成（bind 后原子发布，0600）
    ├── meta.json                 # HostDescriptor：key/label/pid/pluginVersion/startedAt/instanceId/路径（0600，不含 token）
    ├── staging/<requestId>.json  # 审批记录（0600；含 before/proposed 内容，**不要对外分享**）
    └── audit/YYYY-MM.jsonl       # 审计（0600；只含路径/事件/哈希/决策，不含内容）
```

旧布局（0.2.x）：根目录 `ipc.sock`、`token`、`staging/`、`audit/`。0.3.0 Host 不再写它们；启动时会清掉**已死**的根 socket/token（有旧 Host 在跑则不动），扩展在过渡期仍把根目录识别为 `legacy` Host 以兼容 0.2.x。`hostKey` 默认取 DSH profile 名（`desktop` / `dsh-tui`），可用配置覆盖。

### 5.4 `CommitTarget`（`packages/shared/src/commit-target.ts`）

- `prepare(host, requestedPath, signal, {mode})`：只读；`resolve`（realpath）→ `contains(workspaceRoot)` → `stat → readText → stat` → `FileSnapshot`。
- `commit(host, snapshot, finalContent, precondition, signal, actor?)`：`ctx.fs.writeText` + 显式 `{mode:'workspace-write', workspaceRoot}` + CAS；成功后 `emit fs/observed`。
- `inspect(host, snapshot, signal)`：只读比对 hash（崩溃对账用）。
- `GitWorktreeTarget`：预留（同接口，抛 `NOT_IMPLEMENTED`）。
- **0.3.0 未改动**。

### 5.5 配置

**插件 config**（`cordis.patch.yml` 的 `config`；默认值见 `src/config.ts`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（false 则完全不挂载，连 `/review` 命令都没有） |
| `defaultActive` | **`false`**（schema 与 bundle 一致） | 会话是否默认启用审查。手写配置行会整体覆盖 `config`，所以 schema 也必须是 false，避免升级时被悄悄打开 |
| `mode` | `review` | `review` / `off`（`off` 阻止 `/review on`） |
| `hostKey` | 自动（profile 名） | 状态命名空间；`[A-Za-z0-9._-]{1,64}` |
| `hostLabel` | = hostKey | UI 显示名 |
| `reviewTools` | `["write","edit","str_replace_editor"]` | 进入审批的工具名 |
| `exemptTools` | `[]` | 永不审批 |
| `unknownToolPolicy` | `deny` | 未知"像写入"的工具：拒绝/放行 |
| `mutationNamePatterns` | 一组正则 | 名字启发式 |
| `approvalTimeoutMs` | `600000` | 审批超时（超时 = 拒绝） |
| `maxFileBytes` | `2097152` | 超过不进入审批 |
| `fallback` | `deny` | 无客户端时：`deny` / `dsh-approval` |
| `enableAutoAccept` / `autoAcceptMax` | `true` / `20` | 扩展 Auto-Accept 窗口 |
| `stateDir` | `~/.dsh/pre-edit-review` | 状态根目录（Host 子目录在 `hosts/` 下） |
| `socketPath` | 未设置 | 显式覆盖 UDS 路径（专家选项；token 仍在 host 目录） |
| `clientConnectTimeoutMs` | `3000` | 等客户端连接 |
| `noticeOnUserEdit` | `true` | 用户改稿后给模型的提示 |
| `allowPause` | `true` | 是否允许 `/review off`；false 时只禁止关闭 |
| `auditRetentionDays` | `30` | 审计保留（当前无自动清理实现） |

**扩展设置**（`dpr.*`）：`stateDir`（根目录，默认 `~/.dsh/pre-edit-review`；自动发现 `hosts/*`）、`autoConnect`（true）、
`autoAccept`（false）、`messageDurationMs`（5000，1000–30000）、`useNativeNotifications`（false）。

### 5.6 命令与快捷键

**DSH 会话命令**（Host 注册，用户输入）：

| 命令 | 作用 |
|---|---|
| `/review` / `/review status` | Host key/label、安装默认、本会话是否启用、客户端连接、pending、文件策略、socket |
| `/review on` | **启用本会话审查**（之后该会话写入进入审批） |
| `/review off` | **关闭本会话审查**（回到默认直写） |
| `/review strict` / `/review balanced` | 会话文件策略切到 `read-only` / `workspace-write` |
| `/review history [n]` | 本 Host 最近 n 条审计（默认 10，最多 50；无内容） |

**VS Code 命令**（`dpr.*`）：`accept`、`reject`、`acceptItem`、`rejectItem`、`openItem`、`showPending`、`reconnect`（重连所有 Host）、`acceptAll`、`rejectAll`、`clearHistory`、`runSelfTest`。
**快捷键**：macOS `⌘+Shift+A` 接受 / `⌘+Shift+Backspace` 拒绝（首选，完全避开 Ctrl/Option）；Windows/Linux `Ctrl+Alt+A` / `Ctrl+Alt+R`；备用 `⌘+Alt+A`、`⌘+Alt+Backspace`、`⌘+Ctrl+D`、`Ctrl+Alt+Enter`、`Ctrl+Alt+Backspace`；`when: dpr.hasPending`。
**上下文键**：`dpr.hasPending`、`dpr.pendingCount`、`dpr.activeProposal`（聚合所有 Host）。
**决策入口**：编辑器标题栏 ✓/✗、快捷键、活动栏 Pending 视图行内按钮、状态栏指示器 → QuickPick、命令面板。

---

## 6. 安全不变量与已知限制

### 6.1 不能破坏的不变量

1. 审批前不写原文件；唯一写路径 = `CommitTarget.commit`（CI 的 `check-boundaries` 守护）。
2. 未收到 decision 前不提交；decision 必须匹配 requestId + nonce；一次性。
3. 提交必须带 CAS precondition；冲突绝不重试覆盖。
4. 协议不存在"写任意文件"的方法；扩展只能对既有请求做 accept/reject。
5. staging 记录先落盘再展示；崩溃恢复绝不重放提交。
6. **启用/关闭只能由用户会话命令触发**；Agent 工具、IPC、配置都无法打开或关闭审查。
7. **未启用 = 零副作用**：gate 只查 kill switch + 内存 Map，然后放行；不碰工具注册表/coordinator/staging/IPC。
8. **一个 Host = 一个 socket/token/staging 命名空间**；不得跨 Host 复用 token 或共享 staging。
9. 审计不写入文件内容（仅路径/事件/哈希）；kill switch 全局生效。
10. `inject` 声明 + 挂载自检 + gate 内安全查找：插件自身异常不得拖垮非写工具（尤其 bash 恢复通道）。

### 6.2 已知限制（如实对外说明）

- **默认未启用**：安装后、`/review on` 前，本插件不提供任何审查保护；需要强制的部署请设 `defaultActive: true`。
- **工具级模式不防 shell/脚本写入**；只有 `/review strict`（会话 read-only）提供强保证。
- **严格模式代价**：构建/测试/安装/缓存写入会失败；严格模式 + 未启用 ⇒ 写入被沙箱直接拒绝。
- **子代理/团队成员会话独立**：父会话 `/review on` 不覆盖子代理写入（每个会话各自启用）。
- **同一 profile 的两个实例不能并存**：后启动的 Host 得到 `HOST_IN_USE`；不同 profile（desktop/tui）可以并存。
- **显式 `socketPath` 覆盖的 Host 对扩展不可见**：Host 仍会写 meta.json，但扩展要求 socket/token 位于 `hosts/<hostKey>/` 内，路径逃逸会被拒绝；专家配置请把 socket 留在 host 目录内。
- **扩展多连接**：同一 Host 仍只接受一个 VS Code 窗口；两个窗口会互斥（沿用单客户端语义）。
- **版本配套**：0.3.0 Host 只写 `hosts/<key>/`；0.2.x 扩展只认根 `ipc.sock`。升级顺序：先扩展、后插件。
- **管理类工具**（`plugin_manager` 等）不受本插件 gate 约束；需强保证时用严格模式并限制管理工具。
- **MCP/第三方工具**若不经 DSH 沙箱，严格模式的覆盖范围需单独验证（当前 profile 挂载了 Playwright MCP）。
- **平台**：仅 macOS（Seatbelt）实测；Windows/Linux 未验证。
- **Git Worktree 隔离**只有一个 stub（ADR 0001 预留），未实现。
- **自动接受（Accept All）**只在扩展 mock 自检中验证过；真实链路未做自动化测试。
- **部分 UI**（徽标、`· 未启用` 标记、标题栏按钮、5s 状态栏消息、多 Host 标签）只能人工目视确认。
- **历史文档**：`docs/m2-status.md`/`m3-status.md`/`m4-status.md` 中的"放行/bypass"是旧称；以 README / CHANGELOG / 本文件为准。
- **扩展 dist 不提交**（打包时构建）；**插件 dist 提交**（git 安装需要）——改插件源码后务必重新 build 并提交。

### 6.3 事故与踩坑（必读）

- **M2 自锁（2026-11-05）**：漏了 `export const inject = ['fs','tools']`，gate 第一行访问 `ctx.tools` 抛错 → 所有工具失败、无法自救。修复：inject 声明 + `checkHostCapabilities()` + gate 内 try/catch + kill switch + 测试。详见 `docs/m2-status.md` §5。
- **快捷键冲突（0.2.x）**：`Ctrl+Alt+Enter` 被 MySQL 扩展占用 → 改 `Ctrl+Alt+A/R` + `dpr.hasPending` 上下文键（0.2.2/0.2.3）。
- **macOS 快捷键被系统/输入法吞键（2026-11-06，人工联测发现）**：troubleshooting 日志显示 `Ctrl+Option+R`、`⌘+Ctrl+D` 都只有修饰键 keydown、**字母键的 keydown 根本不到 VS Code**（同一日志里 `Shift+Meta+P` 正常）。因此 0.3.0 的 mac 首选键改为**完全不含 Ctrl** 的 `⌘+Shift+A`（接受）/ `⌘+Shift+Backspace`（拒绝），`⌘+Alt+*`、`⌘+Ctrl+D`、`Ctrl+Alt+*` 保留为备选。
- **严格模式被并发覆盖**：多窗口/多 Agent 同时切权限会互相覆盖（会话级策略）。
- **version 降级事故**：曾把扩展版本误写成 0.2.2；发版前核对三处 version。
- **启动时闪 diff 页面（2026-11-06，人工联测发现并修复）**：扩展只要发现工作区有 `.spike/` 目录就在激活 2s 后自动跑自检；自检会依次打开 accept/reject/rejectAll/双 Host 的 diff，表现为启动时连续闪烁。仓库自身就有 `.spike/`（gitignore 的开发产物），所以每次开窗必现。修复：自动自检改为需要显式 `.spike/auto-selftest` 标记文件；并在激活后清理从上次窗口恢复出来的 `dpr:` 幽灵标签页。
- **socket close 会 unlink 路径（2026-11-06，审查发现并修复）**：libuv 在关闭监听句柄时 unlink UDS 路径；HMR/快速重启重叠时旧实例的 close 会删掉新实例刚 bind 的 socket，导致新 Host 不可发现。修复：进程级 owner 串行化 + bind 时记录 inode、`stop()` 仅当路径仍是该 inode 才 unlink。
- **多 Host 抢锁（2026-11-06 定位并修复，0.3.0）**：两个 profile 共用 `<stateDir>/ipc.sock` 与 `token`。后启动的 Host 在 bind 之前就覆盖 token（扩展重连鉴权失败），bind 失败后 `ready` 永久 reject（该 Host 所有写操作 fail-closed），且共享 staging 会让一方 `expirePending()` 把另一方在途审批标成 expired。修复：按 Host 隔离（ADR 0002 §3）+ IPC bind-before-token / stop 不误删 / `HOST_IN_USE`。

---

## 7. 开发、验证与发布工作流

### 7.1 本机开发注意（沙箱/审批）

- 当前会话可能处于 `workspace-write` / `read-only` / `danger-full-access` 之一（看 runtime context 或 `/review status`）；**不要默认自己有全权限**。
- `~/.npm` 在工作区沙箱下可能不可写：安装依赖用 `npm_config_cache=/tmp/… pnpm install --store-dir /tmp/…`。
- **写仓库文件**：
  - 0.3.0 默认未启用 ⇒ 你的 `write`/`edit` 不会被拦截（除非该会话执行过 `/review on`）；
  - 若被拦截（该会话已启用审查），请用户 `/review off`（仅用户可做）或卸载/停用插件；
  - 不要为了绕过而私自 `touch DISABLED`（全局旁路，需用户知情）。
- **不要在日常 profile 保留"已启用审查"的会话**；开发时保持默认未启用即可。

### 7.2 常用命令

```bash
pnpm install                              # 首次（沙箱限制时加 cache/store 参数）
pnpm run check                            # typecheck + boundaries + 全部单测 + market index
pnpm run build                            # packages/dsh-plugin/dist + extension/dist
pnpm run package:extension                # 打 VSIX（packages/vscode-extension/*.vsix）
node packages/dsh-plugin/build.mjs        # 只重建插件 bundle（记得提交 dist）
node packages/vscode-extension/build.mjs  # 只重建扩展 bundle
```

### 7.3 本地安装/卸载（必须遵守顺序）

```bash
# 安装（脚本会先 arm kill switch）
scripts/install-extension.sh --build
scripts/install-plugin.sh                 # 有 dsh CLI 时直接安装；无 CLI 时打印手动步骤
scripts/doctor.sh                         # 确认无 FAIL（0.3.0 会显示 hosts/<key>/）
rm ~/.dsh/pre-edit-review/DISABLED        # 解除急停（确认后！）
# 之后在需要审查的会话里 /review on

# 卸载
scripts/uninstall.sh --purge              # 每个 profile 跑一次；--purge 删除 hosts/、audit、token、socket
```

- 本机两个 profile 都装；版本升级顺序：**先扩展（Marketplace/VSIX），再插件（npm/本地）**。
- 安装/卸载都要确认 profile 的 `package.json`（dependencies + `dsh.profile.bundles`）、`node_modules` 软链、状态目录（`scripts/doctor.sh`）。

### 7.4 测试矩阵（如何验证改动）

| 改动 | 必须验证 |
|---|---|
| 插件逻辑 | `pnpm run check`；必要时用 `scripts/e2e-client.mjs --host-key <key>` 跑 Host 侧 E2E |
| 激活语义 | `test/activation.test.ts`、`test/gate.test.ts`、`test/config.test.ts`；真机 `/review on|off` + `/review status` |
| 多 Host | `test/ipc-multi.test.ts`、`test/recovery-isolation.test.ts`、`test/host-registry.test.ts`；真机同时开 desktop + tui 两个 profile |
| 扩展逻辑 | `pnpm run check` + `pnpm run build:extension` + 真实 VS Code 自检（含双 Host 阶段） |
| 协议/契约 | 两端同时改 + 单测 + 假客户端 E2E；注意向后兼容（可选字段、`paused`/`bypass`） |
| 严格模式 | 真实会话切 `read-only`，验证 shell 拒绝 + 受控提交 |
| 安装/打包 | 干净环境清单（`docs/install.md` §5）+ `scripts/doctor.sh` |
| 发布 | `docs/publish.md` 的 checklist（§8.1 为 0.3.0 版本） |

### 7.5 发布流程（详见 `docs/publish.md`）

1. 更新三处版本 + `CHANGELOG.md`（根/插件/扩展统一 0.3.0）。
2. `pnpm run check && pnpm run build`；确认 `packages/dsh-plugin/dist/index.mjs` 已重建并提交。
3. **先**扩展 Marketplace：`cd packages/vscode-extension && npx @vscode/vsce publish`。
4. 插件 npm：`cd packages/dsh-plugin && npm publish --access public`（2FA 见 publish.md §9）。
5. `node scripts/build-market-index.mjs` → 提交 `market/index.json` → `node scripts/check-market-index.mjs`。
6. tag `v0.3.0`，push 触发 Release（自动附 VSIX + npm tgz）。
7. 发布后核对：Marketplace 页面、`npm view dsh-pre-edit-review version`、raw index URL、README badges。

### 7.6 禁止事项

- ❌ 先写文件再靠 git/备份/回滚"模拟审批"。
- ❌ 绕过 `CommitTarget` 直接 `ctx.fs.writeText`（CI 会拦）。
- ❌ 为让测试通过而关闭 fail-closed、去掉 nonce/CAS/containment、或把 `read-only` 改为可写。
- ❌ 给 Agent 增加任何可打开/关闭审查的路径（工具、IPC、配置热更都不行）。
- ❌ 修改 `app.asar`/DSH 内部文件；只能通过 profile bundle 安装。
- ❌ 在提交里加其他作者/`Co-authored-by`、合并外部 PR（破坏 single-maintainer 约定）。
- ❌ 未经用户同意切换权限/启用审查/安装插件到其 profile。
- ❌ 把 staging 内容、token、用户路径贴到 issue/公开渠道。

---

## 8. 测试与证据

### 8.1 单元/集成测试（当前 **163** 个，`pnpm run test`；Node 内置 test runner + TS 类型剥离）

| 文件 | 覆盖 |
|---|---|
| `test/text.test.ts` | 行尾归一/恢复、字面替换语义 |
| `test/proposal.test.ts` | `write`/`edit` 提案、CRLF、透传/拒绝/超限 |
| `test/proposal-editor.test.ts` | `str_replace_editor` create/str_replace/insert/直通 |
| `test/classifier.test.ts` | 白名单、diff 启发式、异常 presentCall、正则、未知策略 |
| `test/direct-workspace.test.ts` | 越界、CRLF 快照、提交策略、CAS 失败不写、inspect |
| `test/staging.test.ts` | 0600、状态机、崩溃过期、审计不含内容 |
| `test/coordinator-helpers.test.ts` | 路径参数映射、合成成功值、语言提示 |
| `test/coordinator.test.ts` | accept/reject/编辑/冲突/无客户端/透传 |
| `test/activation.test.ts` | 会话启用注册表：默认值、会话隔离、`sessionKeyOf`、`anyInactive` |
| `test/gate.test.ts` | 未启用直通（不碰 registry/coordinator）、启用后 review、kill switch、fail-closed |
| `test/config.test.ts` | `defaultActive` schema/bundle 双默认、`socketPath` 可选、hostKey/hostLabel 规整 |
| `test/host-paths.test.ts` | hostKey 优先级（config → profileContext → env → default）、hosts/ 路径、全局 kill switch 路径 |
| `test/registry.test.ts` | meta.json 原子写 0600、shared `isHostDescriptor` 解析、所有权校验的删除（HMR/重启重叠不误删） |
| `test/host-descriptor.test.ts` | `HostDescriptor`/`isHostKey`/`sanitizeHostKey` 的共享契约 |
| `test/ipc.test.ts` | 真实 UDS：握手、错误 token、无客户端、超时、重复决策、断连 |
| `test/ipc-multi.test.ts` | 两个 Host 命名空间并存、hello hostKey、第二实例 `HOST_IN_USE` 且不改 token、stop 不误删 socket、stale 回收 |
| `test/ipc-security.test.ts` | 伪造 nonce、未知/重放决策、坏 JSON、超大帧、token/socket 权限 |
| `test/ipc-client.test.ts` | 跨端集成：扩展 IpcClient ↔ Host IpcServer 的 per-Host token/身份、双 Host 独立连接、`HOST_IN_USE`、错误 token 断连 |
| `test/runtime.test.ts` | runtime 生命周期：干净停止清理 socket/meta、同 profile 第二实例 `HOST_IN_USE` 且不删 meta、HMR 重叠不误删新 descriptor、两个 profile 并存、指示器聚合（激活 + 急停）、旧根布局自动清理（死/活两种情况） |
| `test/commands.test.ts` | 通过 `apply()` 注册的 `/review` 命令：status/on/off 语义、会话隔离、审计事件、`allowPause:false`、`mode:off`、history、会话销毁剪枝 |
| `test/recovery.test.ts` | 崩溃对账（landed/mismatch/no-hash/pending/terminal） |
| `test/recovery-isolation.test.ts` | 一个 Host 的 `expirePending` 不影响另一个 Host 的 pending |
| `test/history.test.ts` | 审计读取/坏行/跨月/格式化 |
| `test/host-registry.test.ts` | 扩展侧发现：两个 host 目录、legacy 根布局、路径逃逸/键不匹配拒绝、死 pid 剪枝、缺失文件跳过 |
| `test/extension-duration.test.ts` | 5s 消息时长 clamp（1000–30000） |

### 8.2 真实环境验证

- **扩展自检**（真实 VS Code，0.3.0 共 34 步 = 27 步 0.2.x 用例 + 7 步双 Host 用例）：命令面板 `Pre-edit Review: Run Self-test`；自动运行需在工作区显式创建 `.spike/auto-selftest` 标记文件（仅 `.spike/` 目录不会触发——自检会打开多处 diff，避免影响普通工作区），报告写 `.spike/ext-selftest.json`。
- **Host 侧 E2E（假客户端）**：装好插件后
  ```bash
  node scripts/e2e-client.mjs --state-dir ~/.dsh/pre-edit-review --host-key desktop --mode accept --out /tmp/report.json
  # 然后在已 /review on 的 DSH 会话里让 Agent write/edit 一次；客户端会应答
  # 其它 mode：accept-edited / reject / conflict / double-accept / ignore
  ```
  （插件必须已安装、kill switch 关闭、会话已启用审查；VS Code 不要同时连接，单客户端。）
- **多 Host 真机**：同时启动 Desktop 与 `dsh-tui`（两个 profile 都装 0.3.0），`/review status` 各显示自己的 hostKey；VS Code 状态栏显示 2 个 Host；在 TUI 会话 `/review on` 后改文件，diff 出现在同一个 VS Code 并可 Accept。
- **严格模式**：用 `packages/spikes/sandbox-probe`（build 后作为 bundle 安装）切 `read-only`/`balanced` 并跑检查；或用户手动 `/review strict`。
- 真实人工联调记录：`docs/interaction-test-2026-11-05.md`（0.2.x 时代）。

### 8.3 证据索引（`docs/evidence/`）

| 路径 | 内容 |
|---|---|
| `spike-s1-s3-plugin-evidence.jsonl` / `spike-s2-report.json` | M1 三个 spike 的原始证据 |
| `m2/*.json`、`m2/manual/*` | 工具级 E2E 6 场景 + 用户人工联调记录 |
| `m3/*.json` | `str_replace_editor` E2E |
| `m4/strict-mode-evidence.json`、`m4/crash-drill.json`、`m4/state-records.json` | 严格模式 / 崩溃对账证据 |
| `m5/install-cycle.json` | 安装→使用→卸载循环 |
| `ext-selftest.json` | 扩展自检报告：**0.3.0、34/34 通过**（真实 VS Code 1.145，含 alpha/beta 双 Host 阶段） |

---

## 9. 故障排查速查（Runbook）

完整版：[docs/troubleshooting.md](docs/troubleshooting.md)。先跑 `scripts/doctor.sh`。

| 症状 | 处理 |
|---|---|
| Agent 改文件没被拦截 | **0.3.0 默认未启用**；在该会话 `/review on` |
| 写操作报 "no review client is connected" | 该会话已启用但 VS Code 没开/扩展未连；打开 VS Code 或 `/review off`；fail-closed 是设计 |
| 状态栏一直离线/只连上部分 Host | 检查 `~/.dsh/pre-edit-review/hosts/*/meta.json`、socket、token；另一个 profile 是否装了 0.3.0 |
| 同一 profile 第二个实例 | 日志 `HOST_IN_USE`；只保留一个实例（不同 profile 不受影响） |
| 升级后扩展连不上 Host | 扩展还是 0.2.x；先升级扩展（或两者一起升级） |
| Accept 后报 conflict | 审批期间文件被外部改（正确行为）；重新读取后再提案 |
| 严格模式下 build/install 失败 | 预期代价；`/review balanced` 或 `/review off`（用户决定） |
| 严格模式下改不了文件但没弹审批 | 会话未启用审查 + read-only 沙箱直接拒绝；先 `/review on` |
| 所有工具调用都报 `cannot get property ... without inject` / 全挂 | 插件自锁：Web GUI → Plugins 关掉插件；或 `touch DISABLED`；恢复后重装（先 arm kill switch） |
| 发布失败（npm E403） | npm 2FA：`--otp=` 或带 bypass 的 Granular Token，见 publish.md §9 |
| 卸载残留 | `scripts/uninstall.sh --purge`；手动检查 profile package.json/node_modules/state dir（troubleshooting §J） |

**环境恢复（把机器还给用户）**

```bash
scripts/uninstall.sh --purge        # 每个 profile 各一次
rm -rf ~/.dsh/pre-edit-review       # 如仍存在
# 如需保留扩展：scripts/install-extension.sh
scripts/doctor.sh
```

---

## 10. 交接验收清单（新接手者逐项完成）

- [ ] 读完本文件 + ADR 0002 + README + security + usage + CHANGELOG
- [ ] `pnpm run check` 全绿（163 个单测 + market 索引），`pnpm run build` 成功
- [ ] 能解释 gate → activation → coordinator → CommitTarget 的完整链路与 fail-closed 语义
- [ ] 能说明五种状态（未启用/工具级/严格/急停/Auto-Accept）的差别与安全保证
- [ ] 能解释多 Host 发现、连接与决策路由（hostKey/meta.json/legacy）
- [ ] 跑过一次 `scripts/doctor.sh`；知道当前 profile 插件版本/挂载状态（npm vs link）
- [ ] 在**不触发用户审批**的前提下安全地改过一次仓库文件（默认未启用即可）
- [ ] 完成过一次本地安装→验收→卸载循环（kill-switch 顺序，两个 profile）
- [ ] 真实 VS Code 跑过一次扩展自检（含双 Host 阶段）
- [ ] 知道发布流程（三处版本、扩展先发、npm 2FA、Marketplace PAT、market index、tag/Release）
- [ ] 确认遵守 single-maintainer 提交约定；未合并外部 PR
- [ ] 明确 §7.6 禁止事项，并知道"先问用户"再动 profile/权限/发布

---

## 11. 待办与建议（Roadmap / Tech debt）

按优先级：

1. **发布 0.3.0**：版本已对齐；按 `docs/publish.md` §8.1 先扩展后插件；补一次双 Host 真机验证。
2. **子代理/队友会话的审查继承**：现在 `/review on` 只覆盖当前会话；可基于 DSH `subagents` 服务做父会话血缘继承。
3. **Git Worktree 隔离**：实现 `GitWorktreeTarget`（Agent 在独立工作树写，审批后合并回原 checkout）——ADR 0001 已预留接口；DSH 0.2.2 有 `ctx.worktrees` 服务可复用。
4. **跨平台**：Windows（pwsh 沙箱/ACL）与 Linux（Landlock）验证与适配；CI 可加矩阵。
5. **MCP/第三方工具**：验证严格模式对 MCP 子进程写入的覆盖。
6. **Auto-Accept 真机集成测试**：当前只在扩展 mock 自检里验证。
7. **清理历史文档表述**：把 m2/m3/m4 里的 "bypass/放行/暂停" 统一标注为历史旧称。
8. **审计保留清理**：`auditRetentionDays` 目前只是配置，没有实际清理任务；可加启动时按月份清理（按 Host）。
9. **UI 可验证性**：尽量把可断言的逻辑放进 self-test；标题栏/徽标/5s 消息/多 Host 标签仍需人工目视。
10. **同 profile 多实例**：如需支持，需要新的实例级 key（pid/窗口），并处理旧 meta 清理。

---

## 附录 A：文档索引

| 文档 | 内容 |
|---|---|
| [docs/adr/0002-opt-in-activation-and-multi-host.md](docs/adr/0002-opt-in-activation-and-multi-host.md) | 0.3.0 设计决策（默认未启用 + 多 Host） |
| [README.md](README.md) / [README.en.md](README.en.md) | 项目定位、快速开始、状态 |
| [docs/install.md](docs/install.md) | 安装/升级/卸载、干净机器清单、多 Host 安装 |
| [docs/usage.md](docs/usage.md) | 审批流程、决策入口、运行状态、命令 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 故障排查 A–K（含多 Host） |
| [docs/security.md](docs/security.md) | 威胁模型、保证矩阵、已知限制 |
| [docs/publish.md](docs/publish.md) | GitHub/npm/Marketplace/DSH 索引发布 |
| [docs/interaction-test-2026-11-05.md](docs/interaction-test-2026-11-05.md) | 真实人工联调记录（0.2.x） |
| [docs/m1-status.md](docs/m1-status.md) … [m5-status.md](docs/m5-status.md) | 各阶段验收（历史记录） |
| [docs/interface-freeze.md](docs/interface-freeze.md) | M1 接口冻结与依赖方向 |
| [docs/adr/0001-commit-target.md](docs/adr/0001-commit-target.md) | CommitTarget 抽象与 worktree 预留 |
| [docs/design-plan.md](docs/design-plan.md) | 最初需求/方案原文 |
| [docs/spike-s1.md](docs/spike-s1.md) / [spike-s2.md](docs/spike-s2.md) / [spike-s3.md](docs/spike-s3.md) | M1 三个 spike 报告 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) | 单维护者约定 / 漏洞报告 |
| [market/README.md](market/README.md) | DSH 插件索引说明 |

## 附录 B：一句话记住每个文件

- `gate.ts`：先看它 —— 决定"哪些调用进审批"（先 kill switch + 会话启用，再分类）。
- `activation.ts`：谁能打开/关闭审查（只有用户会话命令）。
- `paths.ts` / `registry.ts`：一个 Host 的命名空间与发现描述。
- `review-coordinator.ts`：审批全流程编排，出 bug 先看这里。
- `direct-workspace.ts`：唯一能写文件的地方。
- `ipc/server.ts`：安全边界（token/nonce/帧上限/bind 顺序）都在这里。
- `extension.ts`：多 Host 会话管理、路由、状态栏、命令、5s 消息、上下文键。
- `host-registry.ts`：扩展如何发现多个 Host（以及拒绝恶意 meta）。
- `review-session.ts`：单个 Host 的 diff 打开与 accept/reject/队列。
- `shared/protocol.ts`：改字段要两端一起改，并考虑 legacy 兼容。
- `shared/host.ts`：多 Host 元数据契约（不要在这里放 token）。
- `dist/index.mjs`（插件）：**提交物**，改源码后必须重建。
