# 安全边界（Security Model）

> 状态：ADR 0002 定稿（2026-11-06）。适用于 DSH 0.2.2-rc.1 及兼容版本 + 本仓库 0.3.x 扩展 / 插件。
> 本文档描述**保证什么、不保证什么、以及在什么模式下**。任何对外表述不得超出这里写明的边界。

## 0. 0.3.0 语义变化（先读）

从 0.3.0 起，**安装插件 ≠ 自动开启审查**：

- 安装后的默认状态是**未启用（inactive）**：本插件不拦截任何写入，行为与没装插件一致。
- 用户在某个 DSH 会话里执行 `/review on` 之后，**该会话**的 `write` / `edit` /
  `str_replace_editor` 才进入"先审批后写"。
- `/review off` 关闭该会话的审查（回到默认状态）。两者都是内存态、只写审计、
  Host 重启后回到默认。
- 因此下面保证矩阵里的"已启用"列，全部以**会话已 `/review on`** 为前提。

## 1. 威胁模型

被审查的 Agent（或其调用的工具/子进程）可能：

- 调用 `write` / `edit` / `str_replace_editor` 等文件工具；
- 通过 `bash`、`python`、`sed`、`sh`、脚本、子进程写文件；
- 尝试用其它工具间接写文件（MCP 工具、插件工具、管理工具）；
- 尝试让审批被跳过、伪造审批、重复提交、利用崩溃窗口；
- 尝试读取/篡改 IPC 与状态目录。

不在威胁模型内：拥有本机 root/同用户 shell 的真人、操作系统内核漏洞、DSH 自身被攻破。

## 2. 信任边界

| 组件 | 信任级别 | 说明 |
|---|---|---|
| Host 插件（dsh-pre-edit-review） | 可信 | 运行在 DSH Host 进程内，拥有进程权限；只有它调用 `CommitTarget.commit` |
| CommitTarget | 可信 | 唯一被允许写用户工作区的模块 |
| VS Code 扩展 | 半可信 | 只能提交对既有 requestId 的 decision；不能要求写任意文件 |
| 用户 | 唯一授权来源 | Accept/Reject、`/review on` 激活本会话、`/review off` 关闭、kill switch |
| Agent / 工具 / 子进程 | 不可信 | 受 gate + 沙箱约束（仅当会话已启用审查） |

## 3. 保证矩阵

| 能力 | 安装默认（未启用） | 工具级（会话已 `/review on`） | 严格模式（会话 `read-only`） | 急停（`DISABLED`） |
|---|---|---|---|---|
| `write`/`edit`/`str_replace_editor` 先审批后写 | ❌ 不拦截 | ✅ | ✅ | ❌ 全量旁路 |
| 未审批绝不写原文件 | —（没有审查） | ✅ | ✅ | ❌ |
| 审批期间文件变化 → 冲突不覆盖 | — | ✅（CAS） | ✅ | — |
| bash/python/sed/脚本写绕过 | 不适用（本就无审查） | ❌ **可绕过（已声明）** | ✅ OS 沙箱拒绝 | 不适用 |
| 工作区外写入 | 由 DSH 沙箱策略决定 | ✅ 拒绝（realpath containment） | ✅ | 由 DSH 沙箱策略决定 |
| 无 VS Code 客户端时 | 不适用（不审查） | ✅ fail-closed 拒绝 | ✅ fail-closed | 不适用 |
| 重复/伪造决策 | — | ✅ 拒绝 | ✅ 拒绝 | — |
| 崩溃恢复不重放提交 | — | ✅ | ✅ | — |

**结论：**

1. 只有"会话已 `/review on`"才进入审批语义；工具级模式是便捷模式，不宣称防
   shell 绕过。
2. 只有严格模式宣称"审批前不可写"。
3. 未启用状态不是保护，也不做静默伪装：状态栏（`· OFF / · 未启用`）、
   `/review status`、启动日志都会如实显示"未启用"。

## 4. 关键机制

### 4.1 修改前拦截（gate）

- 挂载在 `tools/execute` 的 prepend 监听器；命中审批名单（默认 `write|edit|str_replace_editor`）时不调用 `next()`，工具 body 不执行。
- **快速路径**：`DISABLED` 急停 → 会话是否已启用（内存 `Map`）→ 未启用直接 `next()`。
  未启用时不会触碰工具注册表、协调器、IPC、staging，几乎没有新增故障面。
- 分类器不只看工具名：`presentCall` 返回 diff 卡片的工具也会进入审批；名字像写入的未知工具默认 **deny**。
- 审批通过后由 CommitTarget 以 **显式 per-call `workspace-write` 策略** 写盘；即使会话是 `read-only` 也能写入（这是严格模式闭环的关键），但路径仍被 containment 限制在工作区内。
- 无法生成提案（前置条件必然失败、`view`、相对路径等）时 **直通**给真实工具，由工具产生原生错误，不消耗审批。

### 4.2 写入安全

- `replaceIfVersion` / `createIfAbsent` 的 CAS 提交；版本不符 → `FS_STALE_VERSION` → 冲突错误，**绝不重试覆盖**。
- 临时文件 + 原子 rename，保留原文件权限；符号链接写穿目标而非替换链接。
- 路径以 realpath 判定；工作区外一律拒绝（跨符号链接、`..`、绝对路径逃逸）。
- 提交成功后补发 `fs/observed`，保证后续 Agent 读取/编辑的版本一致。

### 4.3 IPC 安全（0.3.0：按 Host 隔离）

- 每个 Host 进程有**自己的** namespace：`<stateDir>/hosts/<hostKey>/{ipc.sock,token}`；
  token 只在首次成功 bind 之后**原子发布**（`0600` 临时文件 + rename）。一个 Host
  的 token 无法用于另一个 Host。
- 0700 目录、socket/token 均 `0600`；首包必须是带 token 的 `hello`，否则断开。
- 每个 Host 仍只接受**一个客户端**连接；断开即取消该 Host 的全部 pending。
- 每个审批请求有一次性 `nonce`；decision 必须携带匹配 nonce，否则 `-32001` 拒绝且请求保持 pending。
- 单帧上限 8 MiB，超限断开连接（防内存滥用）；多 Host 时是"每连接"上限。
- 协议**不存在**"写任意文件/任意提交"的方法；decision 只能作用于既有 requestId，且由签发它的 Host 校验。
- 发现文件 `<stateDir>/hosts/<key>/meta.json` 只含路径/pid/版本，**不含 token**；
  扩展校验 `socketPath` / `tokenPath` 必须落在该 Host 目录内，拒绝路径逃逸。
- 同一 Host（同 profile 的第二个实例）无法并存：后启动者得到明确的
  `HOST_IN_USE` 错误，不会覆盖 token，也不会删除在跑实例的 socket。

### 4.4 失败与崩溃语义（仅"已启用"时有意义）

- 任何异常、超时、取消、断连、客户端缺失 ⇒ 返回 `isError` 且**不写盘**（fail-closed）。
- 崩溃恢复（启动时，只读检查，按 Host 各自目录）：
  - `pending` → `expired`；
  - `decided` → 与磁盘当前 SHA-256 比对：一致 → `committed`（说明崩溃前已落盘），不一致 → `conflict`（保留证据，**绝不重试提交**）；
  - 终态记录不动。
- 审计 JSONL 只记录路径、事件、哈希、决策来源，不含文件内容；每个 Host 写自己的
  `audit/YYYY-MM.jsonl`。

### 4.5 会话级启用/关闭（`/review on` / `/review off`）

- 只能由**用户在会话命令**里开启或关闭；Agent 的工具、IPC、配置都无法打开或关闭。
- 会话级、内存态（Host 重启复位）、`allowPause:false` 只禁止"关闭"、每次切换写审计
  （`review/activated` / `review/deactivated`）。
- 只决定"是否审查"，不改沙箱：`read-only` 下即使 `/review off` 也写不了文件；
  反过来，`/review on` 也不会把会话变成只读。
- 状态栏显示 `· OFF / · 未启用`（Host 级聚合：所有已连接的 Host 都无活跃审查会话）；急停 `DISABLED` 生效时同样显示为关闭。想知道**本会话**是否在审查，用 `/review status`。
- 子代理 / 团队成员是**独立会话**：父会话 `/review on` 不会自动覆盖它们的写入（已知限制）。

### 4.6 急停开关（全局）

- `<stateDir>/DISABLED` 存在时，**所有 Host** 的 gate 全量旁路（插件故障恢复通道，1s 内生效）。
- 该文件需要本机文件写权限；在 `workspace-write`/`read-only` 会话下 Agent 无法创建它（`~/.dsh` 在工作区外）。

## 5. 已知限制（必须如实对外说明）

1. **安装默认不提供审查保护**：在用户主动 `/review on` 之前，插件不拦截任何写入。这是产品选择，不是缺陷；需要强制的部署请在配置里设 `defaultActive: true` 并在会话开始即使用。
2. **工具级模式不防 shell**：会话已启用时，Agent 仍可用 bash/python/sed/脚本直接写文件；界面与 `/review status` 都会标注 "tool-level"，不得宣称安全保证。
3. **严格模式的代价**：构建、测试、安装、写缓存等会失败；这是产品取舍，不是缺陷。严格模式下如果同时没有启用审查，写入会直接被 OS 沙箱拒绝（不会走审批提交）。
4. **子代理/队友会话独立**：`/review on` 只影响当前会话；子代理写入默认不进入审批，需要各自启用（后续版本可做血缘继承）。
5. **管理类工具**：`plugin_manager` 等工具由 DSH 的权限/审批策略约束，其写入不经过本插件的 gate；在工具级模式下若 Agent 被允许使用这类工具，理论上可卸载/禁用本插件。需要强保证时请使用严格模式并限制管理工具。
6. **MCP/第三方工具**：若其进程不经过 DSH 沙箱，严格模式的 OS 沙箱覆盖范围需单独验证；当前 profile 未挂载 MCP。
7. **多 Host**：不同 profile（如 Desktop 与 TUI）可同时使用、各自审查；同一 profile 的两个实例不能并存（后者 `HOST_IN_USE`）。VS Code 的**同一个** Host 仍只接受一个客户端窗口。
8. **版本配套**：0.3.0 的 Host 只写 `hosts/<key>/`，0.2.x 扩展只认旧的根 `ipc.sock`；升级请**先升扩展再升插件**（或一起升）。新扩展兼容旧 Host（legacy 连接）。
9. **平台**：macOS（Seatbelt）已实测；Windows/Linux 未验证。
10. **首次安装风险**：本插件挂载在全局工具流水线，若自身抛错可能拖垮工具调用。已通过 `inject` 声明、挂载自检、kill switch、失败时仅对写工具 fail-closed 等措施缓解（见 M2 事故复盘）。
11. **日志/审计**：不含内容，但含文件路径与哈希；按保留策略（默认 30 天）清理。

## 6. 验证证据

| 内容 | 位置 |
|---|---|
| 工具级全链路 E2E（accept/edited/reject/conflict/重复/无客户端） | `docs/evidence/m2/` |
| `str_replace_editor` E2E（create/str_replace/insert/直通） | `docs/evidence/m3/` |
| 严格模式：4 种 shell 绕过 + fs 沙箱 + 受控提交闭环 | `docs/evidence/m4/strict-mode-evidence.json` |
| 崩溃恢复演练（seeded state） | `docs/evidence/m4/crash-drill.json` |
| 单元/集成测试（`pnpm run test`，含 IPC 鉴权/伪造/超限、恢复、激活、多 Host 隔离） | `test/` |
| VS Code 扩展自检（0.3.0：34/34 通过，含双 Host；报告见 `docs/evidence/ext-selftest.json`） | `packages/vscode-extension/src/self-test.ts` |
