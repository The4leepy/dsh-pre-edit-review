# 交互测试报告（2026-11-05，人工联调）

- 环境：DSH Desktop **0.2.1-rc.5**、VS Code **1.145.0**、扩展 **0.2.4**、Host 插件 **0.2.1**（repo bundle，profile `desktop`）、macOS arm64
- 模式：默认工具级（`workspace-write`）；测试期间切换过 pause / 严格模式
- 结论：**交互链路全部通过**。测试中发现并修复了 1 个真实缺陷（快捷键失效）；另有 2 条操作注意事项与 1 条版本建议。

## 1. 测试矩阵

| # | 场景 | 操作 | 结果 |
|---|---|---|---|
| 1 | 单文件 Accept（无编辑） | `write` 新文件 → 标题栏 ✓ / `Ctrl+Alt+A` | committed，磁盘内容 = Agent 提案；审计 `review/committed` |
| 2 | Accept + 用户编辑 | 在右栏修改后接受 | 写入**用户最终版本**；扩展回传 `finalContent`；模型收到"用户改过提案"提示；审计 `edited: true` |
| 3 | Reject | 标题栏 ✗ / `Ctrl+Alt+R`，填原因 | 文件未变；模型收到拒绝 + 原因；审计 `review/rejected` |
| 4 | Pending / History 视图 | 活动栏查看队列与历史、行内 ✓/✗、徽标计数 | 正常；待审批→0 后徽标清除 |
| 5 | **快捷键** | `Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace` | ❌ 失效 → 修复后 `Ctrl+Alt+A` / `Ctrl+Alt+R` ✅（详见 §2.A） |
| 6 | `/review off`（pause，已合并 bypass） | 暂停本会话审阅后写入 | 直接落盘、**无审阅、无 staging 记录**；审计 `review/paused`；扩展日志 `review paused by the Host` |
| 7 | 严格模式 | `/review strict` 后 bash 写入 | 被 OS 沙箱拒绝：`Operation not permitted`，文件未创建 |
| 8 | 严格模式 + 审批提交 | 严格模式下 `write` → 接受 | **提交成功**（受控提交用显式 workspace-write）；提交后会话仍为 read-only（再写仍被拒）；staging `mode: strict` |
| 9 | Auto-Accept 窗口 | 设置允许 + Arm Accept All → 连发 3 次写入 | 4 秒内自动提交 3 个文件；**未打开 diff**；审计 3 条 committed；状态栏 `AUTO-ACCEPT` |
| 10 | Reject All | 发起审阅 → Pending 视图标题栏 Reject All | 队列清空；文件未创建；模型收到拒绝；审计 `review/rejected` |
| 11 | History / Clear History | 查看历史 → Clear History（二次确认） | 记录显示正常，清空成功 |

## 2. 发现的问题与处理

### A. 快捷键失效（已修复，扩展 0.2.2 / 0.2.3）

- **现象**：`Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace` 无反应；用户观察按下后出现"拆分编辑器"效果。
- **根因（两层）**：
  1. keybinding 的 `when` 使用 `resourceScheme == 'dpr'`，在 diff 编辑器路径下不成立；
  2. 已安装的 MySQL 扩展 `cweijan.vscode-mysql-client2` 绑定了 `ctrl+alt+enter → mysql.runSQLInNew`（"Run SQL in new editor"），与我们的组合冲突。
- **修复**：
  - 主快捷键改为 `Ctrl+Alt+A`（接受）/ `Ctrl+Alt+R`（拒绝），无冲突；
  - 保留 `Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace` 作为备用；
  - `when` 简化为 `dpr.hasPending`；
  - 标题栏按钮的 `dpr.activeProposal` 判定增加 `TabInputTextDiff`（左侧原文被聚焦时按钮不消失）。
- **验证**：用户确认 `Ctrl+Alt+A` 生效。

### B. 严格模式被并发切换覆盖（操作注意）

测试时 `/review strict` 生效 12 秒后，被另一窗口执行的 `/permission workspace-write` 覆盖。**结论**：严格模式是会话级策略；多窗口/多 Agent 同时测试时不要并行切换权限，否则会互相覆盖（日志中有完整 `sandbox/mode` 事件可追溯）。

### C. 旧窗口的协议提示（已消失）

升级前窗口（扩展 0.2.3）日志出现 `ignoring unknown server notification: review/mode`；升级到 0.2.4 后正常识别并进入暂停态，无需处理。

### D. 版本号不一致（建议）

插件 `0.2.1` 与扩展 `0.2.4` 不一致，建议最终打包时统一（如都标 0.3.0），避免用户困惑。

### E. 严格模式下 bash 的预期副作用

只读沙箱下 bash 工具写临时脚本也会受限，个别命令可能报 `Operation not permitted` 或出现临时文件相关 stderr——这是严格模式的预期代价，不是产品缺陷。

## 3. 回归检查

```
tsc          ✅ clean
boundaries   ✅ ok
unit tests   ✅ 86 / 86 passed
extension    ✅ 27 / 27 self-test steps（VS Code 1.145.0）
```

## 4. 环境现状

- `desktop` profile：插件已安装并启用；VS Code 扩展 0.2.4 已连接；
- 演示文件在 `.spike-demo/`（已 gitignore，可随时删除）；
- Host 审计与 staging 在 `~/.dsh/pre-edit-review/`（0600；可保留作证据或删除）；
- 仓库工作树干净，本轮修复已提交（`f4f05c5`、`4bb1c37` 等）。

## 5. 结论

修改前审批的核心交互（可编辑 diff、Accept/Reject、快捷键、队列/历史、暂停、严格模式、自动接受窗口、批量拒绝）已在真实 DSH + 真实 VS Code 环境完成端到端验证；**严格模式"审批前不可写、审批后可提交"的行为与安全目标一致**。
