# 安全边界（Security Model）

> 状态：Phase 4 定稿（2026-11-05）。适用于 DSH Desktop 0.2.1-rc.5 + 本仓库 0.2.1 扩展 / 插件。
> 本文档描述**保证什么、不保证什么、以及在什么模式下**。任何对外表述不得超出这里写明的边界。

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
| 用户 | 唯一授权来源 | Accept/Reject、`/review off`（本会话暂停审批）、kill switch |
| Agent / 工具 / 子进程 | 不可信 | 受 gate + 沙箱约束 |

## 3. 保证矩阵

| 能力 | 工具级模式（默认） | 严格模式（会话 `read-only`） | 暂停审批（用户开启） |
|---|---|---|---|
| `write`/`edit`/`str_replace_editor` 先审批后写 | ✅ | ✅ | ❌（直接写） |
| 未审批绝不写原文件 | ✅ | ✅ | ❌ |
| 审批期间文件变化 → 冲突不覆盖 | ✅（CAS） | ✅ | — |
| bash/python/sed/脚本写绕过 | ❌ **可绕过（已声明）** | ✅ OS 沙箱拒绝 | — |
| 工作区外写入 | ✅ 拒绝（realpath containment） | ✅ | 取决于文件策略 |
| 无 VS Code 客户端时 | ✅ fail-closed 拒绝 | ✅ fail-closed | 不受影响 |
| 重复/伪造决策 | ✅ 拒绝 | ✅ 拒绝 | — |
| 崩溃恢复不重放提交 | ✅ | ✅ | — |

**结论：只有严格模式宣称"审批前不可写"；工具级模式是便捷模式，不宣称安全保证；暂停审批是用户明确承担风险的直写模式。**

## 4. 关键机制

### 4.1 修改前拦截（gate）

- 挂载在 `tools/execute` 的 prepend 监听器；命中审批名单（默认 `write|edit|str_replace_editor`）时不调用 `next()`，工具 body 不执行。
- 分类器不只看工具名：`presentCall` 返回 diff 卡片的工具也会进入审批；名字像写入的未知工具默认 **deny**。
- 审批通过后由 CommitTarget 以 **显式 per-call `workspace-write` 策略** 写盘；即使会话是 `read-only` 也能写入（这是严格模式闭环的关键），但路径仍被 containment 限制在工作区内。
- 无法生成提案（前置条件必然失败、`view`、相对路径等）时 **直通**给真实工具，由工具产生原生错误，不消耗审批。

### 4.2 写入安全

- `replaceIfVersion` / `createIfAbsent` 的 CAS 提交；版本不符 → `FS_STALE_VERSION` → 冲突错误，**绝不重试覆盖**。
- 临时文件 + 原子 rename，保留原文件权限；符号链接写穿目标而非替换链接。
- 路径以 realpath 判定；工作区外一律拒绝（跨符号链接、`..`、绝对路径逃逸）。
- 提交成功后补发 `fs/observed`，保证后续 Agent 读取/编辑的版本一致。

### 4.3 IPC 安全

- UDS 位于 `0700` 目录，socket 与 token 文件均为 `0600`；首包必须是带 token 的 `hello`，否则断开。
- 每个审批请求有一次性 `nonce`；decision 必须携带匹配 nonce，否则 `-32001` 拒绝且请求保持 pending。
- 单帧上限 8 MiB，超限断开连接（防内存滥用）。
- 协议**不存在**"写任意文件/任意提交"的方法；decision 只能作用于既有 requestId。
- 单客户端；断开即取消所有 pending（不写盘）。

### 4.4 失败与崩溃语义

- 任何异常、超时、取消、断连、客户端缺失 ⇒ 返回 `isError` 且**不写盘**（fail-closed）。
- 崩溃恢复（启动时，只读检查）：
  - `pending` → `expired`；
  - `decided` → 与磁盘当前 SHA-256 比对：一致 → `committed`（说明崩溃前已落盘），不一致 → `conflict`（保留证据，**绝不重试提交**）；
  - 终态记录不动。
- 审计 JSONL 只记录路径、事件、哈希、决策来源，不含文件内容。

### 4.5 暂停审批（`/review off`）

- 只能由**用户在会话命令**里开启（`/review off`）；Agent 的工具、IPC、配置都无法打开。
- 会话级、内存态（Host 重启复位）、`allowBypass:false` 可整体禁用、每次切换写审计。
- 只跳过审批，不改沙箱：`read-only` 下即使暂停审批也写不了文件。
- 状态栏显示 `· 已关闭`，不会静默生效。

### 4.6 急停开关

- `<stateDir>/DISABLED` 存在时 gate 全量放行（插件故障恢复通道，1s 内生效）。
- 该文件需要本机文件写权限；在 `workspace-write`/`read-only` 会话下 Agent 无法创建它（`~/.dsh` 在工作区外）。

## 5. 已知限制（必须如实对外说明）

1. **工具级模式不防 shell**：Agent 可用 bash/python/sed/脚本直接写文件；界面与 `/review status` 都会标注"tool-level"，不得宣称安全保证。
2. **严格模式的代价**：构建、测试、安装、写缓存等会失败；这是产品取舍，不是缺陷。
3. **管理类工具**：`plugin_manager` 等工具由 DSH 的权限/审批策略约束，其写入不经过本插件的 gate；在工具级模式下若 Agent 被允许使用这类工具，理论上可卸载/禁用本插件。需要强保证时请使用严格模式并限制管理工具。
4. **MCP/第三方工具**：若其进程不经过 DSH 沙箱，严格模式的 OS 沙箱覆盖范围需单独验证；当前 profile 未挂载 MCP。
5. **平台**：macOS（Seatbelt）已实测；Windows/Linux 未验证。
6. **首次安装风险**：本插件挂载在全局工具流水线，若自身抛错可能拖垮工具调用。已通过 `inject` 声明、挂载自检、kill switch、失败时仅对写工具 fail-closed 等措施缓解（见 M2 事故复盘）。
7. **日志/审计**：不含内容，但含文件路径与哈希；按保留策略（默认 30 天）清理。

## 6. 验证证据

| 内容 | 位置 |
|---|---|
| 工具级全链路 E2E（accept/edited/reject/conflict/重复/无客户端） | `docs/evidence/m2/` |
| `str_replace_editor` E2E（create/str_replace/insert/直通） | `docs/evidence/m3/` |
| 严格模式：4 种 shell 绕过 + fs 沙箱 + 受控提交闭环 | `docs/evidence/m4/strict-mode-evidence.json` |
| 崩溃恢复演练（seeded state） | `docs/evidence/m4/crash-drill.json` |
| 单元/集成测试（86 个，含 IPC 鉴权/伪造/超限、恢复、暂停审批） | `test/` |
| VS Code 扩展自检（27 步） | `docs/evidence/ext-selftest.json` |
