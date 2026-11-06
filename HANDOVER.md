# 项目交接文档 — DeepSeek Pre-edit Review

> 面向接手本项目的工程师 / Agent：目标是在 **30 分钟内**安全地理解、运行、修改并发布本项目。
> 本文件是入口；细节以各专题文档与源码注释为准。**如果你改动了架构/流程，请同步更新本文件。**
>
> 最后更新：2026-11-06（此前 29 个提交、tag `v0.2.5`；本次交接文档会新增一个提交）。

---

## 0. 一页速览

**它是什么**：DeepSeek Harness（DSH）的 Agent 在改文件之前，先把修改变成 VS Code 里的**可编辑左右分栏 diff**；用户在 VS Code 点 **Accept** 之后才真正写入原文件。Reject 则原文件字节不变。

**组成**（两个独立发行物 + 一个共享协议包）：

| 组件 | 位置 | 发行物 | 版本 |
|---|---|---|---|
| DSH Host 插件 | `packages/dsh-plugin` | npm `dsh-pre-edit-review` | **0.2.1** |
| VS Code 扩展 | `packages/vscode-extension` | VS Marketplace `The4leepy.deepseek-pre-edit-review` + Release VSIX | **0.2.5** |
| 共享协议/契约 | `packages/shared` | 不独立发布（构建内联） | — |

**已发布渠道**（2026-11-05/06）：

- GitHub：<https://github.com/The4leepy/dsh-pre-edit-review>（tag `v0.2.5`，CI 绿，Release 附带 VSIX + `dsh-pre-edit-review-0.2.1.tgz`）
- VS Code Marketplace：`The4leepy.deepseek-pre-edit-review@0.2.5`
- npm：`dsh-pre-edit-review@0.2.1`（`latest`；曾有 `0.0.0-stage` staged-publish 残留，不影响 latest）
- DSH 插件索引（format 1，npm 源）：`https://raw.githubusercontent.com/The4leepy/dsh-pre-edit-review/main/market/index.json`
- 发布流程详见 [docs/publish.md](docs/publish.md)。

**最重要的 5 条规则（违反会破坏安全模型或发布流程）**

1. **审批前绝不写原文件。** 唯一允许写用户工作区的代码是 `CommitTarget`（`packages/dsh-plugin/src/targets/*`）；任何其他模块不得调用 `ctx.fs.writeText`（`pnpm run check:boundaries` 会拦截）。
2. **安装插件前先 arm kill switch**：`touch ~/.dsh/pre-edit-review/DISABLED`。插件挂载在全局工具流水线，首次安装若自身故障会拖垮所有工具（曾发生过，见 §6.4）。
3. **日常开发本仓库时不要把插件留在 profile 里**——否则你自己的 `write`/`edit` 会被拦截（VS Code 未开时会 fail-closed 直接失败）。联调/测试完就 `scripts/uninstall.sh` 并清理状态目录。
4. **只有严格模式（`/review strict`，会话 `read-only`）能防止 bash/脚本绕过**；工具级模式只拦工具写入，文档与 `/review status` 必须如实说明。
5. **提交身份必须保持 `The4leepy` 唯一作者**（single-maintainer 模型，见 `CONTRIBUTING.md` / `docs/publish.md` §1.3）：不要 `Co-authored-by`、不要合并外部 PR、不要用其他身份提交。本机 `git config user.name/email` 已配置正确。

**10 秒自检**

```bash
pnpm run check        # typecheck + 依赖边界 + 88 个单测 + market 索引校验
pnpm run build        # 插件 bundle + 扩展 bundle
scripts/doctor.sh     # 扩展/插件/状态目录/socket/kill switch
git log --oneline -5 && git status --short
```

---

## 1. 新 Agent 上手路径

### 1.1 必读顺序（约 30–40 分钟）

1. **本文件**（架构、规则、工作流、坑）
2. [README.md](README.md)（定位、安装、状态）
3. [docs/security.md](docs/security.md)（威胁模型、三种模式的保证矩阵、已知限制）
4. [docs/usage.md](docs/usage.md)（用户交互、决策入口、命令）
5. [CHANGELOG.md](CHANGELOG.md)（版本演进；注意历史条目里的"放行/bypass"是旧称，现为"暂停/pause"）
6. [docs/install.md](docs/install.md) + [docs/troubleshooting.md](docs/troubleshooting.md)（安装顺序、故障恢复）
7. 若涉及发布：[docs/publish.md](docs/publish.md)
8. 源码入口：`packages/dsh-plugin/src/index.ts`（Host 插件 `apply`）、`packages/vscode-extension/src/extension.ts`（扩展 `activate`）、`packages/shared/src/protocol.ts`（协议）

可选：`docs/design-plan.md`（最初的需求/方案原文）、`docs/m1-status.md` … `docs/m5-status.md`（阶段验收）、`docs/interaction-test-2026-11-05.md`（真实人工联调记录与踩坑）。

### 1.2 本机环境事实（2026-11-06 实测）

| 项 | 值 |
|---|---|
| DSH Desktop | **0.2.1-rc.5**，`/Applications/DeepSeek Harness.app`（Host 代码在 `app.asar`，只读） |
| DSH CLI | **本机 PATH 上没有 `dsh`**（打包版 Desktop）。脚本遇到这种情况会 arm kill switch 后打印手动安装步骤 |
| DSH profile | `desktop` → `~/.dsh/profiles/desktop`（`DSH_PROFILE`/`DSH_PROFILE_DIR` 环境变量可覆盖脚本中的默认值） |
| 插件安装形态 | 本机当前从 **npm 0.2.1** 安装（profile `dependencies` 是 `"0.2.1"`，不是 `link:`） |
| 运行时状态目录 | `~/.dsh/pre-edit-review`（当前存在：`audit/ staging/ token ipc.sock`；**有会话处于暂停状态**，见 `audit` 最后一条 `review/paused`） |
| VS Code | **1.145.0**，CLI：`/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code` |
| 已安装扩展 | `the4leepy.deepseek-pre-edit-review@0.2.5`（Marketplace id 小写；manifest publisher 为 `The4leepy`） |
| 平台 | macOS arm64；Windows/Linux 未验证 |
| 工程环境 | Node v26（仓库要求 ≥22.19）、pnpm 12.5.1（`packageManager` 固定）、TypeScript 5.9、esbuild、vsce 4 |

> ⚠️ **当前 profile 里插件是装着的，且某个会话已暂停审批**。新窗口 Agent 开始工作前先看 `/review status`（或 `tail ~/.dsh/pre-edit-review/audit/*.jsonl`）；若你的写操作被拦截/失败，先判断是"暂停态"还是"没有 VS Code 客户端"。**不要擅自替用户切换暂停/权限**。

### 1.3 开始工作的 10 分钟检查清单

- [ ] `git status --short` 为空、`git log -1` 知道当前 commit
- [ ] `pnpm run check` 通过（88 测试 + market 索引）
- [ ] `scripts/doctor.sh` 输出符合预期（无 FAIL）
- [ ] 确认当前 DSH profile 插件版本与状态（npm vs 本地 link；是否 paused；是否有 kill switch）
- [ ] 知道如何安全安装/卸载（§7.3），以及如何在不触发审批的情况下改仓库文件（§7.1）
- [ ] 明确"禁止事项"（§7.6）

---

## 2. 当前仓库状态与历史

### 2.1 版本与发布

| 项 | 值 |
|---|---|
| 根 `package.json` version | `0.2.1`（private，仅用于工作区脚本） |
| 插件 `packages/dsh-plugin/package.json` | `0.2.1`，npm 已发布 |
| 扩展 `packages/vscode-extension/package.json` | `0.2.5`，Marketplace 已发布 |
| git tag | `v0.2.5`（Release 已生成） |
| 提交数 / 作者 | 29 个提交，作者全是 `The4leepy <The4leepy@users.noreply.github.com>` |
| 远程 | `origin = git@github.com:The4leepy/dsh-pre-edit-review.git`（main） |

> 版本建议（尚未执行）：插件 0.2.1 与扩展 0.2.5 数字不一致，长期建议下一次统一到 `0.3.0` 一起发布（见 §13）。

### 2.2 里程碑时间线（git log 摘要）

| 阶段 | 内容 |
|---|---|
| Phase 1.5 (M1) | 可行性 spike S1/S2/S3：`tools/execute` 短路、VS Code 可编辑 diff、只读沙箱 + CAS 提交；冻结 `packages/shared` 接口（ADR 0001 `CommitTarget`） |
| Phase 2 (M2) | Host 全链路（gate→staging→IPC→commit）、VS Code 客户端、`/review` 命令、E2E；**发生过一次插件自锁**（缺 `inject`），加了 kill switch/挂载自检 |
| M2.1/M2.2 UX | 决策入口收敛到编辑器标题栏 ✓/✗（用户主导），移除重复入口 |
| Phase 3 (M3) | 多文件 Pending/History 视图、批量 Reject All、`str_replace_editor` 提案、`/review history` |
| Phase 4 (M4) | 严格模式整会话 E2E、IPC nonce/帧上限、崩溃对账（`recovery.ts`）、`docs/security.md` |
| Phase 5 (M5) | 安装/卸载/体检脚本、LICENSE/CHANGELOG、安装/使用/排障文档 |
| 交互测试与修复 | 快捷键冲突修复（Ctrl+Alt+A/R）、**bypass → `/review off` 暂停语义**（用户选择）、5 秒状态栏消息（0.2.5） |
| 公开发布 | GitHub 仓库/CI/Release、npm 0.2.1、Marketplace 0.2.5、DSH format-1 索引 |

### 2.3 当前本机环境快照

- profile 已装插件（npm 0.2.1），`~/.dsh/pre-edit-review` 存在；
- 最近审计事件包含 `review/paused`（某会话暂停审批），以及此前多次 `review/committed`；
- VS Code 当前未运行；扩展 0.2.5 已安装；
- 仓库工作树干净。

---

## 3. 系统架构

### 3.1 组件与数据流

```
Agent 工具调用 (write / edit / str_replace_editor)
        │
        ▼  DSH Host 进程（Cordis 插件运行时）
┌─────────────────────────────────────────────────────────────┐
│ packages/dsh-plugin  (bundle: cordis.patch.yml → dist/index.mjs) │
│                                                             │
│  gate.ts            tools/execute prepend 监听器            │
│    ├─ killSwitch.active()      → 直接放行（急停）           │
│    ├─ pause.isPaused(session)  → 直接放行（用户暂停）       │
│    ├─ classifier.classify()    → pass / deny / review       │
│    └─ review 时调用 coordinator.review(exec)，不调 next()   │
│                                                             │
│  review-coordinator.ts                                      │
│    ① target.prepare()       解析路径 + stat→read→stat 快照  │
│    ② proposal.ts            write/edit/str_replace_editor   │
│                              → proposed 全文（或 passthrough）│
│    ③ staging/store.ts       落盘 pending 记录（0600）       │
│    ④ ipc/server.ts          通过 UDS 发 review/request      │
│    ⑤ 等待 decision（内联完成提交，扩展能拿到真实 outcome）  │
│    ⑥ targets/direct-workspace.ts  CAS + 原子写 + fs/observed│
│    ⑦ 返回合成的 ToolExecutionResult（成功/失败）            │
│                                                             │
│  runtime.ts  组装 store/ipc/coordinator/pause/target；启动时  │
│              expirePending + reconcileStaging（崩溃对账）    │
│  recovery.ts 启动只读对账：pending→expired；decided 与磁盘   │
│              SHA-256 比对 → committed / conflict，绝不重写   │
└─────────────────────────────────────────────────────────────┘
        │ Unix domain socket: ~/.dsh/pre-edit-review/ipc.sock
        │ JSON-RPC 2.0 over NDJSON；token 鉴权 + 每请求 nonce + 8MiB 帧上限
        ▼
┌─────────────────────────────────────────────────────────────┐
│ packages/vscode-extension                                   │
│  ipc-client.ts       连接/握手/重连/决策 RPC                 │
│  fs-provider.ts      自定义 dpr: FileSystemProvider（可写）  │
│  review-session.ts   pending 队列 + vscode.diff + accept/reject│
│  extension.ts        activate、状态栏、命令、5s 消息、上下文键│
│  tree-views.ts       活动栏 Pending/History 两个视图         │
│  history-store.ts    workspaceState 决策历史（最近 50 条）   │
│  self-test.ts        进程内 mock Host 自检（27 步）          │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
   用户：编辑器标题栏 ✓/✗（或快捷键）→ decision
```

**关键设计点**

- `tools/pre-execute` 不能替换结果、也**不能改写 `exec.arguments`**（官方限制），所以内容替换必须在 `tools/execute` 包裹层**短路**（不调用 `next()`）并自行写盘，再返回符合该工具 output schema 的**合成成功值**。
- 合成结果结构：`write` → `{path, operation, before, after}`；`edit` → `{path, before, after}`；`str_replace_editor` → `string`（与真实工具文案一致）。见 `review-coordinator.ts` 的 `successValueFor`。
- 写盘只走 `CommitTarget.commit`：CAS（`replaceIfVersion` / `createIfAbsent`）+ 临时文件原子 rename + 保留权限 + realpath containment；成功后 `ctx.emit('fs/observed', …)` 供后续工具使用。
- 用户 Accept 的内容 = 用户最终编辑的内容；若用户改过提案，会通过 `tools/post-execute` 追加一段提示，要求模型重新读取文件。
- 失败语义全部 **fail-closed**：异常/超时/取消/断连/无客户端/CAS 冲突 → `isError` 且不写盘。

### 3.2 运行模式矩阵

| 模式 | 如何进入 | 审批 | 能防 bash 写? | 可见性 |
|---|---|---|---|---|
| 工具级（默认） | 默认 | 拦截工具写入 | ❌ 明确声明不防 | 状态栏普通 |
| 严格 | 用户 `/review strict`（会话 `read-only`） | 全部写入需审批（唯一写路径是受控提交） | ✅ OS 沙箱 | 状态栏/status 显示 |
| 暂停 | 用户 `/review off`（会话级） | 跳过（直接写） | —（沙箱策略不变） | 状态栏 `· 已关闭`，审计 `review/paused` |
| 急停 kill switch | 文件 `~/.dsh/pre-edit-review/DISABLED` | 全部旁路 | — | 启动日志 WARN；doctor WARN |
| 无客户端 fallback | 配置 `fallback: 'dsh-approval'` | 走 DSH 自身审批（不能编辑内容） | — | — |
| Auto-Accept 窗口 | 扩展设置 + `dpr.acceptAll` 显式点击 | 5 分钟内自动接受 | — | 状态栏 `AUTO-ACCEPT` |

> 暂停只能由**用户在会话命令**里开启：Agent 工具、IPC、配置都无法打开（`pause.ts` 的关键不变量）。急停是文件，任何有本机文件权限的人都能开；在 `workspace-write`/`read-only` 会话中 Agent 写不到 `~/.dsh`。

### 3.3 一次 Accept（含用户编辑）的时序

```
Agent → gate(intercept) → coordinator.prepare → staging(pending)
  → ipc review/request → extension 打开 dpr: diff（左=真实文件，右=可编辑）
  → 用户编辑右栏 → 点标题栏 ✓（Ctrl+Alt+A）
  → extension decision {requestId, nonce, status:'accept', finalContent}
  → ipc 内联调用 coordinator.handleDecision
      → 若 finalContent 与提案不同：restoreLineEndings(用户文本)
      → CommitTarget.commit(CAS) → staging(committed) → audit
  → ipc 回复真实 outcome → coordinator 返回合成成功值 → 模型继续
```

---

## 4. 代码地图（要改什么去哪里）

### 4.1 `packages/shared`（无运行时依赖，构建时内联）

| 文件 | 作用 |
|---|---|
| `src/protocol.ts` | 协议 v1：方法名、参数/结果类型、JSON-RPC 校验、NDJSON framing；`PROTOCOL_VERSION=1`；`paused`（新）+ `bypass`（legacy）字段 |
| `src/commit-target.ts` | `CommitTarget` / `FileSnapshot`（含 `rawContent`）/ `CommitPrecondition` / `CommitResult` / `CommitConflict` / `InspectResult` / `CommitTargetHost` |
| `src/review-record.ts` | staging 记录与状态机（`pending/decided/committed/rejected/expired/cancelled/conflict/failed`）、`canTransition` |
| `src/text.ts` | 行尾归一/恢复、字面替换（与 `dsh-fs-local` 对齐）、出现次数 |
| `src/hash.ts` | SHA-256、随机 hex（token/nonce） |

### 4.2 `packages/dsh-plugin`（Host 插件；`dist/` **被提交**以便 DSH git 源安装）

| 文件 | 作用 / 修改注意 |
|---|---|
| `src/index.ts` | 插件入口 `apply(ctx, rawConfig)`：`inject=['fs','tools']`、能力自检、装配 runtime、注册 gate/post-execute/`/review` 命令/systemPrompt 段落。**不要删 `inject`**（历史事故根因）。 |
| `src/gate.ts` | `tools/execute` prepend 拦截；kill switch / pause / classifier；注册顺序与 fail-closed 边界。 |
| `src/classifier.ts` | 决定 review/pass/deny：allowlist + `presentCall` diff 启发式 + 名字正则 + `unknownToolPolicy`。 |
| `src/proposal.ts` | `write`/`edit`/`str_replace_editor` 提案全文；前置条件失败 → `passthrough` 交还真实工具。 |
| `src/review-coordinator.ts` | 全链路编排 + 决策处理 + 合成结果 + 通知；`pathArgument`/`successValueFor` 在改工具集时同步。 |
| `src/targets/direct-workspace.ts` | 唯一写路径：prepare/commit/inspect、CAS、原子写、containment、`fs/observed`。 |
| `src/targets/git-worktree.ts` | **预留 stub**（`NOT_IMPLEMENTED`），实现隔离工作树时替换。 |
| `src/targets/index.ts` | target 工厂 + `createCommitTargetHost(ctx, cwd)` 适配器（依赖方向守卫的一部分）。 |
| `src/staging/store.ts` | 0600 原子写、状态机迁移、`expirePending`、审计 JSONL。 |
| `src/ipc/server.ts` | UDS 服务端：token 握手、decision nonce 校验、8 MiB 帧上限、单客户端、断连取消、`notifyMode`。 |
| `src/recovery.ts` | 启动只读对账（decided→committed/conflict；pending→expired）。 |
| `src/pause.ts` | 会话级暂停注册表（memory-only，用户命令才可写）。 |
| `src/kill-switch.ts` | `DISABLED` 文件检测（1s 缓存）。 |
| `src/history.ts` | 审计 JSONL 读取/格式化（`/review history`）。 |
| `src/config.ts` | 配置 schema/默认值/校验（字段见 §5.5）。 |
| `src/host.ts` | 对 DSH 服务的 duck-type 视图（**不 import `@deepseek-ai/*` 运行时**）。 |
| `src/runtime.ts` | 组装 + 启动顺序（store→ipc→expire→reconcile）+ IPC mode 推送。 |
| `cordis.patch.yml` | bundle 安装行（`id: pre-edit-review`，默认 config）。 |
| `build.mjs` | esbuild → `dist/index.mjs`（ESM，node22）。 |
| `dist/index.mjs` | **提交到 git**（`.gitignore` 特例）：`plugin_manager` 从 git 源安装时需要。改源码后必须重新 `pnpm run build:plugin` 并提交 dist。 |

### 4.3 `packages/vscode-extension`

| 文件 | 作用 |
|---|---|
| `src/extension.ts` | `activate()`：状态栏（主指示器 + 5s 消息条）、命令注册、上下文键、配置监听、自检调度；`presentTransient` 是消息入口。 |
| `src/ipc-client.ts` | UDS 客户端：token 重读、hello、3s 退避重连、decision RPC、通知分发、`paused` 状态。 |
| `src/review-session.ts` | 会话状态机：pending 队列、打开/聚焦 diff、语言识别、accept/reject/acceptAll/rejectAll、断连清理、5s 消息路由。 |
| `src/fs-provider.ts` | `dpr:` 可写 FileSystemProvider（diff 右侧可编辑、保存回传）；新文件用空 `dpr:` 原始文档。 |
| `src/tree-views.ts` | Pending/History TreeDataProvider + TreeItem。 |
| `src/history-store.ts` | `workspaceState` 历史（最近 50 条、按 requestId 覆盖、损坏容错）。 |
| `src/i18n.ts` | en / zh-CN 全部用户文案（**新增文案两份都要加**）。 |
| `src/self-test.ts` | 进程内 mock Host + 27 步自检；写 `<workspace>/.spike/ext-selftest.json`。 |
| `src/util.ts` | `~` 展开、basename、delay、错误文案、`clampMessageDuration`。 |
| `package.json` | 贡献点：命令/菜单/快捷键/视图/设置/`viewsWelcome`；publisher `The4leepy`，版本 0.2.5。 |
| `package.nls.json` / `.zh-cn.json` | 命令/设置/欢迎页文案（manifest 里用 `%key%`）。 |
| `media/icon.svg` / `icon.png` | 活动栏图标 / Marketplace 图标（原创，勿换第三方素材）。 |
| `build.mjs` | esbuild CJS 单文件 → `dist/extension.js`。 |

### 4.4 其他

| 路径 | 作用 |
|---|---|
| `scripts/_common.sh` | 脚本共用：仓库根、profile/state 路径、`code`/`dsh` 探测、kill switch、安装检测。 |
| `scripts/install-extension.sh` | 安装/`--build` 重打包 VSIX。 |
| `scripts/install-plugin.sh` | **先 arm kill switch** 再装插件；无 `dsh` CLI 时打印手动步骤（exit 2 为设计）。 |
| `scripts/uninstall.sh` | 移除扩展+插件注册；`--purge` 删状态目录。 |
| `scripts/doctor.sh` | 体检（扩展/插件/权限/socket/token/kill switch）。 |
| `scripts/e2e-client.mjs` | 假审批客户端（accept/edited/reject/conflict/double-accept/ignore）；用于 Host 侧自动化 E2E。 |
| `scripts/check-boundaries.mjs` | 依赖方向守卫（CI 一部分）。 |
| `scripts/build-market-index.mjs` | 从插件 manifest 生成 `market/index.json`（npm 发布后运行）。 |
| `scripts/check-market-index.mjs` | 校验 format-1 索引（CI 一部分）。 |
| `packages/spikes/probe` | M1 探针（`tools/execute` 短路/严格模式检查；dist 未提交，需先 build）。 |
| `packages/spikes/sandbox-probe` | 严格模式验证探针（切 preset + 沙箱检查；dist 未提交）。 |
| `test/` | 88 个 `node --test` 单测（见 §8）。 |
| `.github/workflows/ci.yml` | push/PR：install → check → build（ubuntu, node 24）。 |
| `.github/workflows/release.yml` | tag `v*`：check/build → 打 VSIX + npm tgz → GitHub Release。 |
| `market/index.json` + `market/README.md` | DSH format-1 自托管索引（npm 源）。 |
| `docs/` | 专题文档与 `evidence/`（见 §8.3）。 |

---

## 5. 协议与数据契约

### 5.1 IPC 协议（`packages/shared/src/protocol.ts`）

- 传输：Unix domain socket `<stateDir>/ipc.sock`（0600），**JSON-RPC 2.0 + NDJSON**（每行一个 JSON）。
- 鉴权：首帧 `hello {token, protocolVersion:1, client:{name,version}}`；token 来自 `<stateDir>/token`（0600）。token 错 → `-32001` 并断开。
- 单客户端；断开即取消所有 pending；心跳 `ping/pong`。
- **单帧上限 8 MiB**，超限断开。
- 请求（扩展 → Host）：`hello`、`decision`、`ack`、`ping`、`autoAccept`。
- 通知（Host → 扩展）：`review/request`、`review/cancel`、`review/state`、`review/mode`、`server/shutdown`。
- `decision` 必须携带与 pending 请求匹配的 `nonce`；不匹配 → `-32001` 且请求保持 pending。重复/未知 requestId → `{outcome:'already-decided'}`。**协议里没有任何"写任意文件"的方法。**

`review/request.params` 关键字段：`requestId, nonce, protocolVersion, createdAt, expiresAt, sessionId, sessionLabel, toolName, callId, operation, displayPath, absolutePath, isNewFile, languageHint?, before, after, beforeSha256, afterSha256, targetKind, mode`。

`hello.result` / `review/mode`：`paused?: boolean`（当前语义），并保留 `bypass?: boolean` 作为 0.2.x legacy 兼容（`isReviewModeParams` 接受两者）。

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
- Host 崩溃后启动：`expirePending()` + `reconcileStaging()`（见 `recovery.ts`），绝不重放提交。

### 5.3 目录布局（`~/.dsh/pre-edit-review`，0700）

| 文件 | 说明 |
|---|---|
| `ipc.sock` | UDS（0600） |
| `token` | 32 字节 hex，每次 Host 启动重生成（0600） |
| `staging/<requestId>.json` | 审批记录（0600；含 before/proposed 内容，**不要对外分享**） |
| `audit/YYYY-MM.jsonl` | 审计（0600；只含路径/事件/哈希/决策，不含内容） |
| `DISABLED` | 急停开关（存在即旁路所有审批） |

### 5.4 `CommitTarget`（`packages/shared/src/commit-target.ts`）

- `prepare(host, requestedPath, signal, {mode})`：只读；`resolve`（realpath）→ `contains(workspaceRoot)` → `stat → readText → stat` 保证版本/内容一致 → `FileSnapshot`（含 `rawContent`、行尾、sha256）。
- `commit(host, snapshot, finalContent, precondition, signal, actor?)`：`ctx.fs.writeText` + 显式 `{mode:'workspace-write', workspaceRoot}` + CAS；成功后 `emit fs/observed`；`FS_STALE_VERSION`/`FS_NOT_OBSERVED`/`FS_SANDBOX_DENIED` → `CommitConflict`。
- `inspect(host, snapshot, signal)`：只读比对 hash（崩溃对账用）。
- `GitWorktreeTarget`：预留（同接口，抛 `NOT_IMPLEMENTED`）。

### 5.5 配置

**插件 config**（`cordis.patch.yml` 的 `config`；默认值见 `src/config.ts`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（关闭则完全透传） |
| `mode` | `review` | `review` / `off` |
| `reviewTools` | `["write","edit","str_replace_editor"]` | 进入审批的工具名 |
| `exemptTools` | `[]` | 永不审批 |
| `unknownToolPolicy` | `deny` | 未知"像写入"的工具：拒绝/放行 |
| `mutationNamePatterns` | 一组正则 | 名字启发式 |
| `approvalTimeoutMs` | `600000` | 审批超时（超时 = 拒绝） |
| `maxFileBytes` | `2097152` | 超过不进入审批 |
| `fallback` | `deny` | 无客户端时：`deny` / `dsh-approval`（不能编辑内容） |
| `enableAutoAccept` / `autoAcceptMax` | `true` / `20` | 扩展 Auto-Accept 窗口 |
| `stateDir` | `~/.dsh/pre-edit-review` | 状态目录 |
| `socketPath` | `<stateDir>/ipc.sock` | 可覆盖（两端必须一致） |
| `clientConnectTimeoutMs` | `3000` | 等客户端连接 |
| `noticeOnUserEdit` | `true` | 用户改稿后给模型的提示 |
| `allowPause` | `true` | 是否允许 `/review off`（旧名 `allowBypass` 兼容） |
| `auditRetentionDays` | `30` | 审计保留（当前无自动清理实现，仅文档语义） |

**扩展设置**（`dpr.*`）：`stateDir`（默认 `~/.dsh/pre-edit-review`）、`autoConnect`（true）、`autoAccept`（false，允许 Auto-Accept 窗口）、`messageDurationMs`（5000，1000–30000，状态栏临时消息时长）、`useNativeNotifications`（false；true 则改回 VS Code 原生通知，时长不可控）。

### 5.6 命令与快捷键

**DSH 会话命令**（Host 注册，用户输入）：

| 命令 | 作用 |
|---|---|
| `/review` / `/review status` | 状态：开关、客户端连接、pending 数、是否暂停、文件策略、state dir/socket |
| `/review off` / `/review on` | 暂停/恢复**当前会话**审批（用户主动；写审计；内存态） |
| `/review strict` / `/review balanced` | 会话文件策略切到 `read-only` / `workspace-write` |
| `/review history [n]` | 最近 n 条审计（默认 10，最多 50；无内容） |

**VS Code 命令**（`dpr.*`）：`accept`、`reject`、`acceptItem`、`rejectItem`、`openItem`、`showPending`、`reconnect`、`acceptAll`、`rejectAll`、`clearHistory`、`runSelfTest`。
**快捷键**：`Ctrl+Alt+A` 接受 / `Ctrl+Alt+R` 拒绝（主）；`Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace`（备用）；`when: dpr.hasPending`。
**上下文键**：`dpr.hasPending`、`dpr.pendingCount`、`dpr.activeProposal`（编辑器标题栏按钮用）。
**决策入口**：编辑器标题栏 ✓/✗、快捷键、活动栏 Pending 视图行内按钮、状态栏指示器 → QuickPick、命令面板。

---

## 6. 安全不变量与已知限制

### 6.1 不能破坏的不变量

1. 审批前不写原文件；唯一写路径 = `CommitTarget.commit`（CI 的 `check-boundaries` 守护）。
2. 未收到 decision 前不提交；decision 必须匹配 requestId + nonce；一次性。
3. 提交必须带 CAS precondition；冲突绝不重试覆盖。
4. 协议不存在"写任意文件"的方法；扩展只能对既有请求做 accept/reject。
5. staging 记录先落盘再展示；崩溃恢复绝不重放提交。
6. 暂停只能用户命令开启；暂停/过滤/急停都不改变沙箱策略。
7. 审计不写入文件内容（仅路径/事件/哈希）。
8. `inject` 声明 + 挂载自检 + gate 内安全查找：插件自身异常不得拖垮非写工具（尤其 bash 恢复通道）。

### 6.2 已知限制（如实对外说明）

- **工具级模式不防 shell/脚本写入**；只有 `/review strict`（会话 read-only）提供强保证。
- **严格模式代价**：构建/测试/安装/缓存写入会失败，这是产品取舍。
- **管理类工具**（`plugin_manager` 等）不受本插件 gate 约束；其调用受 DSH 审批/权限策略约束。需强保证时用严格模式并限制管理工具。
- **MCP/第三方工具**若不经 DSH 沙箱，严格模式的 OS 沙箱覆盖范围需单独验证（当前 profile 未挂载 MCP）。
- **平台**：仅 macOS（Seatbelt）实测；Windows/Linux 未验证。
- **Git Worktree 隔离**只有一个 stub（ADR 0001 预留），未实现。
- **自动接受（Accept All）**只在扩展 mock 自检中验证过；真实链路未做自动化测试。
- **部分 UI**（徽标、暂停标记、标题栏按钮、5s 状态栏消息）只能人工目视确认。
- **历史文档**：`docs/m2-status.md`/`m3-status.md`/`m4-status.md` 中的"放行/bypass"是旧称（现为 `/review off` 暂停）；`m5-status` 有注记。以 README / CHANGELOG / 本文件为准。
- **探针 caveat**：`sandbox-probe` 的 shell 检查曾用 deployment fallback 而非会话策略，那次结果作废；严格模式证据以真实工具测得的 `docs/evidence/m4/strict-mode-evidence.json` 为准。
- **扩展 dist 不提交**（打包时构建）；**插件 dist 提交**（git 安装需要）——改插件源码后务必重新 build 并提交 `packages/dsh-plugin/dist/index.mjs`。

### 6.3 事故与踩坑（必读）

- **M2 自锁（2026-11-05）**：漏了 `export const inject = ['fs','tools']`，gate 第一行访问 `ctx.tools` 抛错 → 所有工具失败、无法自救。修复：inject 声明 + `checkHostCapabilities()` 挂载自检 + gate 内 try/catch（非写工具永远可走）+ kill switch + 测试。详见 `docs/m2-status.md` §5。
- **快捷键冲突**：`Ctrl+Alt+Enter` 被 MySQL 扩展占用，且 `when` 条件在 diff 路径不成立 → 改 `Ctrl+Alt+A/R` + `dpr.hasPending` 上下文键（0.2.2/0.2.3）。详见 `docs/interaction-test-2026-11-05.md`。
- **严格模式被并发覆盖**：多窗口/多 Agent 同时切权限会互相覆盖（会话级策略）；联调时不要并行切换。
- **version 降级事故**：曾有一次打包把扩展版本误写成 0.2.2（应为 0.2.4+），已修正为 0.2.5；发版前务必核对三处 version。

---

## 7. 开发、验证与发布工作流

### 7.1 本机开发注意（沙箱/审批）

- 当前会话可能处于 `workspace-write` / `read-only` / `danger-full-access` 之一（看 runtime context 或 `/review status`）；**不要默认自己有全权限**。
- `~/.npm` 在工作区沙箱下可能不可写：安装依赖用
  `npm_config_cache=/tmp/… pnpm install --store-dir /tmp/…`。
- **仓库文件写入**：若插件已安装且当前会话未暂停审批，`write`/`edit` 工具会被拦截（VS Code 未开时 3s 后 fail-closed）。此时可：
  (a) 用 `bash` 写文件（bash 不被本插件审批）；
  (b) 请用户执行 `/review off` 暂停（仅用户可做）；
  (c) 卸载插件后再开发。
  **不要**为了让写入通过而私自 `touch DISABLED`（kill switch 是全局旁路，需用户知情）。

### 7.2 常用命令

```bash
pnpm install                              # 首次（沙箱限制时加 cache/store 参数）
pnpm run check                            # typecheck + boundaries + 88 tests + market index
pnpm run build                            # packages/dsh-plugin/dist + extension/dist
pnpm run package:extension                # 打 VSIX（packages/vscode-extension/*.vsix）
node packages/dsh-plugin/build.mjs        # 只重建插件 bundle（记得提交 dist）
node packages/vscode-extension/build.mjs  # 只重建扩展 bundle
```

### 7.3 本地安装/卸载（必须遵守顺序）

```bash
# 安装（脚本会先 arm kill switch）
scripts/install-extension.sh --build
scripts/install-plugin.sh                 # 无 dsh CLI 时打印 plugin_manager/Web GUI 步骤
scripts/doctor.sh                         # 确认无 FAIL
rm ~/.dsh/pre-edit-review/DISABLED        # 解除急停（确认后！）

# 卸载
scripts/uninstall.sh --purge              # 无 dsh CLI 时按提示用 plugin_manager 注销
```

- 本机当前插件是 **npm 0.2.1**；若要测试本地源码修改，先 `remove_bundle` 再用绝对路径安装 `packages/dsh-plugin`（会创建 `link:` 依赖），测完恢复 npm 版。
- 安装/卸载都要确认 profile 的 `package.json`（dependencies + `dsh.profile.bundles`）、`node_modules` 软链、状态目录是否干净（`scripts/doctor.sh`）。

### 7.4 测试矩阵（如何验证改动）

| 改动 | 必须验证 |
|---|---|
| 插件逻辑 | `pnpm run check`；必要时用 `scripts/e2e-client.mjs` 跑 Host 侧 E2E（§8.2） |
| 扩展逻辑 | `pnpm run check` + `pnpm run build:extension` + 真实 VS Code 自检（§8.2） |
| 协议/契约 | 两端同时改 + 单测 + 假客户端 E2E；注意向后兼容（`paused`/`bypass`） |
| 严格模式 | 需要真实会话切 `read-only`（用户命令或 sandbox-probe），验证 shell 拒绝 + 受控提交 |
| 安装/打包 | 干净环境清单（`docs/install.md` §5）+ `scripts/doctor.sh` |
| 发布 | `docs/publish.md` 的 checklist |

### 7.5 发布流程（详见 `docs/publish.md`）

1. 更新三处版本 + `CHANGELOG.md`（根/插件/扩展；扩展 marketplace 版本递增）。
2. `pnpm run check && pnpm run build`；确认 `packages/dsh-plugin/dist/index.mjs` 已重建并提交。
3. 插件 npm：`cd packages/dsh-plugin && npm publish --access public`（2FA 用 `--otp` 或带 bypass 的 Granular Token；注意 `0.0.0-stage` 残留；`prepublishOnly` 会 build）。
4. 扩展 Marketplace：`cd packages/vscode-extension && npx @vscode/vsce publish`（PAT 需 Marketplace Manage；publisher `The4leepy`）。
5. 更新 DSH 索引：`node scripts/build-market-index.mjs` → 提交 `market/index.json` → `node scripts/check-market-index.mjs`。
6. tag：`vX.Y.Z`，push 触发 Release 工作流（自动附 VSIX + npm tgz）。
7. 发布后核对：Marketplace 页面、`npm view dsh-pre-edit-review version`、raw index URL、README badges。

### 7.6 禁止事项

- ❌ 先写文件再靠 git/备份/回滚"模拟审批"。
- ❌ 绕过 `CommitTarget` 直接 `ctx.fs.writeText`（CI 会拦）。
- ❌ 为让测试通过而关闭 fail-closed、去掉 nonce/CAS/containment、或把 `read-only` 改为可写。
- ❌ 修改 `app.asar`/DSH 内部文件；只能通过 profile bundle 安装。
- ❌ 在提交里加其他作者/`Co-authored-by`、合并外部 PR（破坏 single-maintainer 约定）。
- ❌ 未经用户同意切换权限/暂停审批/安装插件到其 profile。
- ❌ 把 staging 内容、token、用户路径贴到 issue/公开渠道。

---

## 8. 测试与证据

### 8.1 单元/集成测试（88 个，`pnpm run test`；Node 内置 test runner + TS 类型剥离）

| 文件 | 覆盖 |
|---|---|
| `test/text.test.ts` | 行尾归一/恢复、字面替换语义 |
| `test/proposal.test.ts` | `write`/`edit` 提案、CRLF、透传/拒绝/超限 |
| `test/proposal-editor.test.ts` | `str_replace_editor` create/str_replace(原始字节)/insert/直通 |
| `test/classifier.test.ts` | 白名单、diff 启发式、异常 presentCall、正则、未知策略 |
| `test/direct-workspace.test.ts` | 越界、CRLF 快照、提交策略、CAS 失败不写、inspect |
| `test/staging.test.ts` | 0600、状态机、崩溃过期、审计不含内容 |
| `test/coordinator-helpers.test.ts` | 路径参数映射、合成成功值、语言提示 |
| `test/coordinator.test.ts` | accept/reject/编辑/冲突/无客户端/透传（真实 store + FakeHost） |
| `test/ipc.test.ts` | 真实 UDS：握手、错误 token、无客户端、超时、重复决策、断连 |
| `test/ipc-security.test.ts` | 伪造 nonce、未知/重放决策、坏 JSON、超大帧、token/socket 权限 |
| `test/recovery.test.ts` | 崩溃对账（landed/mismatch/no-hash/pending/terminal） |
| `test/gate.test.ts` | kill switch、review 短路、coordinator 异常 fail-closed、registry 异常不锁死非写工具、挂载自检 |
| `test/pause.test.ts` | 暂停注册表、协议校验、gate 双会话行为、`allowPause` |
| `test/history.test.ts` | 审计读取/坏行/跨月/格式化 |
| `test/extension-duration.test.ts` | 5s 消息时长 clamp（1000–30000） |

### 8.2 真实环境验证

- **扩展自检**（27 步，真实 VS Code）：命令面板 `Pre-edit Review: Run Self-test`；或打开含 `.spike/` 的工作区，激活后自动运行并写 `.spike/ext-selftest.json`（mock Host + 真实 diff/命令/决策/历史/树视图）。
- **Host 侧 E2E（假客户端）**：装好插件后
  ```bash
  node scripts/e2e-client.mjs --state-dir ~/.dsh/pre-edit-review --mode accept --out /tmp/report.json
  # 然后在 DSH 会话里让 Agent write/edit 一次；客户端会应答
  # 其它 mode：accept-edited / reject / conflict / double-accept / ignore
  ```
  （插件必须已安装、kill switch 关闭、stateDir 一致；VS Code 不要同时连接，单客户端。）
- **严格模式**：用 `packages/spikes/sandbox-probe`（build 后作为 bundle 安装）切 `read-only`/`balanced` 并跑检查；或用户手动 `/review strict`。
- 真实人工联调记录：`docs/interaction-test-2026-11-05.md`。

### 8.3 证据索引（`docs/evidence/`）

| 路径 | 内容 |
|---|---|
| `spike-s1-s3-plugin-evidence.jsonl` / `spike-s2-report.json` | M1 三个 spike 的原始证据 |
| `m2/*.json`、`m2/manual/*` | 工具级 E2E 6 场景 + 用户人工联调记录 |
| `m3/*.json` | `str_replace_editor` E2E |
| `m4/strict-mode-evidence.json`、`m4/crash-drill.json`、`m4/state-records.json` | 严格模式 / 崩溃对账证据 |
| `m5/install-cycle.json` | 安装→使用→卸载循环 |
| `ext-selftest.json` | 扩展 27 步自检报告（最新一次） |

---

## 9. 故障排查速查（Runbook）

完整版：[docs/troubleshooting.md](docs/troubleshooting.md)。先跑 `scripts/doctor.sh`。

| 症状 | 处理 |
|---|---|
| 所有工具调用都报 `cannot get property ... without inject` / 全挂 | 插件自锁：按 `docs/troubleshooting.md` §D；Web GUI → Plugins 关掉插件；恢复后重新安装（先 arm kill switch） |
| `write` 报 "no review client is connected" / 3s 后失败 | VS Code 没开/扩展未连接；开 VS Code（装了扩展）或 `/review status` 确认；fail-closed 是设计 |
| 状态栏一直离线 | `<stateDir>` 无 `ipc.sock`（插件没挂载）或 token 不匹配；见 troubleshooting §B/C |
| Accept 后报 conflict | 审批期间文件被外部改（正确行为）；重新读取后再提案 |
| 严格模式下 build/install 失败 | 预期代价；`/review balanced` 或 `/review off`（用户决定） |
| 暂停后忘记恢复 | 状态栏 `· 已关闭`；`/review on`；Host 重启也会自动恢复 |
| 扩展不显示视图/按钮异常 | Reload Window；`View: Show Pre-edit Review`；检查上下文键/版本 |
| 发布失败（npm E403） | npm 2FA：`--otp=` 或带 bypass 的 Granular Token，见 publish.md §9 |
| 卸载残留 | `scripts/uninstall.sh --purge`；手动检查 profile package.json/node_modules/state dir（troubleshooting §J） |

**环境恢复（把机器还给用户）**

```bash
scripts/uninstall.sh --purge        # 插件按提示注销 + 扩展卸载 + 状态目录
rm -rf ~/.dsh/pre-edit-review       # 如仍存在
# 如需保留扩展：scripts/install-extension.sh
scripts/doctor.sh
```

---

## 10. 交接验收清单（新接手者逐项完成）

- [ ] 读完本文件 + README + security + usage + CHANGELOG
- [ ] `pnpm run check` 全绿（88 测试 + market index），`pnpm run build` 成功
- [ ] 能解释 gate → coordinator → CommitTarget 的完整链路与 fail-closed 语义
- [ ] 能说明四种状态（工具级/严格/暂停/急停）的差别与安全保证
- [ ] 跑过一次 `scripts/doctor.sh`；知道当前 profile 插件版本/安装形态（npm vs link）
- [ ] 在**不触发用户审批**的前提下安全地改过一次仓库文件（bash 或用户暂停）
- [ ] 完成过一次本地安装→验收→卸载循环（kill-switch 顺序）
- [ ] 真实 VS Code 跑过一次扩展自检（27 步）
- [ ] 知道发布流程（三处版本、npm 2FA、Marketplace PAT、market index、tag/Release）
- [ ] 确认遵守 single-maintainer 提交约定；未合并外部 PR
- [ ] 明确 §7.6 禁止事项，并知道"先问用户"再动 profile/权限/发布

---

## 11. 待办与建议（Roadmap / Tech debt）

按优先级：

1. **版本对齐**：下一次把插件与扩展统一到 `0.3.0` 一起发（当前 0.2.1 / 0.2.5 不一致）。
2. **Git Worktree 隔离**：实现 `GitWorktreeTarget`（Agent 在独立工作树写，审批后合并回原 checkout）——ADR 0001 已预留接口。
3. **跨平台**：Windows（pwsh 沙箱/ACL）与 Linux（Landlock）验证与适配；CI 可加矩阵（当前 ubuntu 只跑 check/build，不跑真实 DSH/VS Code）。
4. **MCP/第三方工具**：验证严格模式对 MCP 子进程写入的覆盖，必要时限制。
5. **Auto-Accept 真机集成测试**：当前只在扩展 mock 自检里验证。
6. **清理历史文档表述**：把 m2/m3/m4 里的 "bypass/放行" 统一标注为历史旧称（m5 已有一条注记）。
7. **修复/淘汰探针**：`sandbox-probe` 的 shell 检查曾用错策略；如继续使用需改为会话策略。probe 的 dist 未提交，使用前需 build。
8. **审计保留清理**：`auditRetentionDays` 目前只是配置，没有实际清理任务；可加启动时按月份清理。
9. **UI 可验证性**：尽量把可断言的逻辑放进 self-test；标题栏/徽标/5s 消息仍需人工目视。
10. **本机 profile 状态**：当前插件为 npm 0.2.1 且某会话暂停；接手后先与用户确认是否恢复审批/更新版本。

---

## 附录 A：文档索引

| 文档 | 内容 |
|---|---|
| [README.md](README.md) / [README.en.md](README.en.md) | 项目定位、快速开始、状态 |
| [docs/install.md](docs/install.md) | 安装/升级/卸载、干净机器清单 |
| [docs/usage.md](docs/usage.md) | 审批流程、决策入口、状态/命令、5s 消息 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 故障排查 A–J |
| [docs/security.md](docs/security.md) | 威胁模型、保证矩阵、已知限制 |
| [docs/publish.md](docs/publish.md) | GitHub/npm/Marketplace/DSH 索引发布 |
| [docs/interaction-test-2026-11-05.md](docs/interaction-test-2026-11-05.md) | 真实人工联调记录（11 场景） |
| [docs/m1-status.md](docs/m1-status.md) … [m5-status.md](docs/m5-status.md) | 各阶段验收（历史记录） |
| [docs/interface-freeze.md](docs/interface-freeze.md) | M1 接口冻结与依赖方向 |
| [docs/adr/0001-commit-target.md](docs/adr/0001-commit-target.md) | CommitTarget 抽象与 worktree 预留 |
| [docs/design-plan.md](docs/design-plan.md) | 最初需求/方案原文 |
| [docs/spike-s1.md](docs/spike-s1.md) / [spike-s2.md](docs/spike-s2.md) / [spike-s3.md](docs/spike-s3.md) | M1 三个 spike 报告 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) | 单维护者约定 / 漏洞报告 |
| [market/README.md](market/README.md) | DSH 插件索引说明 |

## 附录 B：一句话记住每个文件

- `gate.ts`：先看它 —— 决定"哪些调用进审批"。
- `review-coordinator.ts`：审批全流程编排，出 bug 先看这里。
- `direct-workspace.ts`：唯一能写文件的地方。
- `ipc/server.ts`：安全边界（token/nonce/帧上限）都在这里。
- `extension.ts`：状态栏/命令/5s 消息/上下文键。
- `review-session.ts`：diff 打开与 accept/reject/队列。
- `shared/protocol.ts`：改字段要两端一起改，并考虑 legacy 兼容。
- `dist/index.mjs`（插件）：**提交物**，改源码后必须重建。

