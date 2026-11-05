# M4 验收 — Phase 4（安全加固）

- 日期：2026-11-05
- 状态：**M4 达成**。严格模式整会话 E2E、IPC 加固、崩溃恢复演练、安全边界文档全部完成；`plan.md` 验收测试 5 通过。
- 环境：DSH Desktop 0.2.1-rc.5 / macOS arm64；验证后 profile 与状态目录均已还原。

## 1. 交付物

### 1.1 严格模式整会话 E2E（plan.md 测试 5）

用一次性探针把当前会话切到 `read-only`，随后实测：

| 绕过手法 | 结果 |
|---|---|
| bash 重定向 `printf > file` | ❌ `Operation not permitted`，文件未创建 |
| Python `Path.write_text` | ❌ `PermissionError: Operation not permitted` |
| `sed -i` 原地修改 | ❌ `Operation not permitted`，文件内容保持 `original` |
| `sh -c` 脚本写入 | ❌ `Operation not permitted`，文件未创建 |
| `write` 工具（kill switch 旁路审批，仅留沙箱） | ❌ `[sandbox: file access denied under read-only mode]` |
| 指向工作区外的符号链接（显式 workspace-write） | ❌ `FS_SANDBOX_DENIED`（realpath containment） |

闭环验证：
- **无客户端**时严格模式 `write` → fail-closed，记录 `expired`（code `NO_CLIENT`），文件未创建；
- **有客户端 Accept** 时严格模式 `write` → 审批通过后由 CommitTarget 以显式 `workspace-write` 策略写盘 → `committed`，staging `mode=strict`，审计 `review/committed`，文件内容正确。

> 结论：严格模式下"审批前不可写、审批后可写"成立，且拦截来自 OS/文件系统沙箱而非工具名过滤。

### 1.2 IPC 加固

- **decision nonce 绑定**：不匹配 → `-32001` 拒绝，请求保持 pending（可被合法决策补齐）。
- **单帧上限 8 MiB**：超限断开连接，防止恶意/故障客户端撑爆内存。
- 既有：token 握手、`0700` 目录 + `0600` socket/token、单客户端、断连取消。
- 新增测试 `test/ipc-security.test.ts`（5 例）：伪造 nonce、未知/重放决策、坏 JSON、超大帧、token/socket 权限。

### 1.3 崩溃恢复

- 新增 `packages/dsh-plugin/src/recovery.ts`：启动时只读对账
  - `pending` → `expired`；
  - `decided` → 与磁盘 SHA-256 比对：一致 → `committed`；不一致 → `conflict`；**绝不重试提交**；
  - 终态记录不动。
- `ReviewRecord` 增加可选 `workspaceRoot`（用于对账），旧记录兼容。
- 单元测试 `test/recovery.test.ts`（6 例）。
- **实机演练**：向状态目录预置 4 条模拟崩溃记录，再挂载插件观察启动对账：
  - `pending` → `expired`（`RECOVERED_PENDING`）
  - `decided` 且磁盘已落盘 → `committed`（`RECOVERED_COMMITTED`）
  - `decided` 且内容不一致 → `conflict`（`RECOVERED_MISMATCH`）
  - 终态 `committed` → 不动
  - 磁盘 fixture 未被修改（无重放写）。

### 1.4 文档

- **[docs/security.md](security.md)**：威胁模型、信任边界、保证矩阵（三种模式）、关键机制、已知限制、验证证据索引。
- README / 插件 README 更新安全边界与放行模式说明。

## 2. 质量门

| 项 | 结果 |
|---|---|
| 单元/集成测试 | **86 / 86**（M3 的 75 + IPC 安全 5 + 恢复 6） |
| `tsc` / `check:boundaries` | 通过 |
| 插件 bundle | 66.8 KB（新增 recovery、nonce、frame cap） |
| 扩展 | 0.2.1（M3.1 放行指示；本轮未改） |
| 扩展自检 | 27 / 27（VS Code 1.145.0） |

## 3. plan.md 验收测试对照（最终）

| # | 测试 | 状态 |
|---|---|---|
| 1 | 普通文件修改：原文件不变 + 弹出审批 | ✅ |
| 2 | 编辑 Proposed：写入用户最终版本 | ✅（含 `str_replace_editor`） |
| 3 | Reject：原文件 SHA-256 不变 | ✅ |
| 4 | 审批期间文件变化：Accept 失败、不覆盖 | ✅ |
| 5 | Bash 写入不能绕过 | ✅（严格模式；工具级模式如实声明不可防） |
| 6 | 多文件：独立/全部审批 | ✅（队列视图 + Accept All/Reject All） |
| 7 | 客户端断开：无未批准写入 | ✅ |
| 8 | 重复提交：只提交一次 | ✅ |

## 4. 已知限制 / 未验证

1. **未真的 kill Host**：崩溃演练用"预置崩溃态记录 + 重新挂载"模拟，语义等价；没有在审批进行中强制杀死 DSH 进程（会打断会话）。
2. **探针 checks 的 shell 部分曾用错策略**：`sandbox_probe checks` 的 shell 检查使用 deployment fallback 而非会话策略，该次结果无效；已用**真实工具**（bash/python/sed/sh）复测，证据见 `docs/evidence/m4/strict-mode-evidence.json` 的 `probeCaveat`。
3. Windows/Linux 未验证；MCP 子进程写未验证。
4. 管理类工具（`plugin_manager` 等）不受本插件 gate 约束，见 `docs/security.md` §5.3。

## 5. 环境现状

- `desktop` profile：插件与探针均已卸载，`package.json` / `cordis.patch.yml` / `node_modules` 无残留。
- `~/.dsh/pre-edit-review` 状态目录已删除。
- VS Code：扩展 **0.2.1** 保留；VS Code 当前未运行。
- 临时挂载的 `tool-str-replace-editor` 已在 M3 还原。

## 6. Phase 5（M5）下一步

1. VSIX 与插件包整理：版本号、README、CHANGELOG、LICENSE、`files`/`.vscodeignore` 检查。
2. 安装/卸载脚本：`scripts/install-plugin.sh`、`install-extension.sh`、`uninstall.sh`（含 kill switch 安全顺序）。
3. 文档：安装配置、使用说明、故障排查、放行模式/严格模式取舍。
4. 干净机器验证清单（含"先 arm kill switch 再安装"的强制流程）。
