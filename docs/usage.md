# 使用说明

> 0.3.0 起：**安装插件不会自动开始审查**。先在会话里 `/review on`，该会话的写操作才进入审批。

## 1. 一次审批的完整流程

1. 会话已 `/review on`；
2. Agent 调用 `write` / `edit` / `str_replace_editor`；
3. Host 插件在工具执行**之前**拦截，读取原文、生成 proposed 全文，落盘到 staging；
4. VS Code 自动打开左右分栏：
   - 左：Original（真实文件，只读）
   - 右：Proposed（**可编辑**，原生 undo/主题/行号/diff 高亮）
5. 你在右侧按需要改代码，然后：
   - **Accept**：写入的是「你最终看到的内容」（含未保存编辑）；文件被原子替换并做版本校验；
   - **Reject**：原文件不变，Agent 收到拒绝（可附理由）。
6. 审批期间文件被其它程序改动 → Accept 失败并提示冲突，**不会覆盖**；Agent 会收到"重新读取后再提案"。

## 2. 在哪里点 Accept / Reject

| 入口 | 说明 |
|---|---|
| **编辑器标题栏** | diff 激活且有 pending 时，右上角（`⬆️⬇️` 旁）出现 `✓` / `✗` |
| **快捷键** | **macOS**：`⌘+Shift+A` 接受 / `⌘+Shift+Backspace` 拒绝（首选；`Ctrl`/`Option` 组合在某些输入法/系统下收不到字母键）。Windows/Linux：`Ctrl+Alt+A` / `Ctrl+Alt+R`。备用：`⌘+Alt+A`、`⌘+Alt+Backspace`、`⌘+Ctrl+D`、`Ctrl+Alt+Enter`、`Ctrl+Alt+Backspace` |
| **状态栏** | 有待审批时盾牌项高亮，点击打开待审批队列 |
| **活动栏 Pre-edit Review** | Pending Reviews（行内 ✓/✗）、Review History |
| **命令面板** | `Pre-edit Review: Show Pending Reviews` 等 |

> 决策入口是标题栏 ✓/✗ 与队列视图；插件不用 VS Code 原生通知气泡（其停留时间由 VS Code 固定控制、扩展无法修改）。

## 3. 多文件与多 Host

- 模型一次消息里的多个写调用会被逐个拦截、逐个弹出审批（Host 侧串行）。Pending 视图显示当前队列，支持逐文件 Accept/Reject；`Reject All` 清空队列，`Accept All` 是"5 分钟内自动接受"的显式预授权窗口（需先在设置里允许 `dpr.autoAccept`）。
- **多个 Host（例如 Desktop + TUI 两个 profile）**：扩展会同时连接所有发现到的 Host，队列里每行标注所属 Host；Accept/Reject 只作用于签发该请求的 Host。状态栏显示连接的 Host 数；`Accept All` / `Reject All` 在有激活 diff 时只作用于该 Host，否则作用于所有有待审批的 Host（确认框会列出 Host）。
- 旧的单 Host 布局（`~/.dsh/pre-edit-review/ipc.sock`）仍被识别为 `legacy` Host，用于兼容 0.2.x。

## 4. 运行状态

| 状态 | 进入方式 | 效果 |
|---|---|---|
| **未启用（安装默认）** | 默认 / `/review off` | 不拦截任何写入；状态栏 `· 未启用`；`/review status` 显示 `INACTIVE` |
| 已启用（工具级） | 用户在会话执行 `/review on` | 该会话的工具写入需审批；**bash/脚本可绕过**（如实标注） |
| 严格模式 | 用户执行 `/review strict`（会话 `read-only`） | OS 沙箱拒绝一切写入；Agent 唯一写路径是审批提交。代价：构建/安装/测试会失败 |
| 急停开关 | 用户/维护者创建 `~/.dsh/pre-edit-review/DISABLED` | **所有 Host** 旁路审批（仅用于故障恢复） |

**关系说明：**

- `/review on|off` 只决定"是否审查"，不改沙箱策略；`/review strict|balanced` 只改沙箱，不改审查开关。
- 严格模式下如果会话**没有**启用审查：沙箱会直接拒绝写入（不会走审批提交）——需要修改文件时先 `/review on`。
- 启用/关闭是**会话级、内存态**：Host 重启后回到配置默认（0.3.0 安装默认 = 未启用）；`allowPause: false` 禁止关闭；`mode: off` 禁止开启。
- 子代理/团队成员会话是独立会话，需要在各自会话里启用（已知限制）。
- 状态栏的 `· 未启用` 是 **Host 级聚合**：只要该 Host 还有活跃的审查会话就不显示；某会话结束（销毁）后 Host 会剪枝并刷新；急停 `DISABLED` 生效时也会显示关闭。想知道**本会话**是否在审查，用 `/review status`。

模式建议：
- 日常开发（不希望被打断）→ 保持默认未启用，确实要审时在会话里 `/review on`；
- 关键改动/不受信任内容 → `/review on` + `/review strict`；
- 需要批量改代码 → `/review off` 暂停本会话审查（改完 `/review on`）。

## 5. Agent 侧行为（你不需要手动教它）

- 模型提示词已说明：审查开启时修改走 `write`/`edit`；被拒绝要重新提案；冲突要重新读取；不得用 shell 绕过；
- 如果你改过提案，插件会在工具结果后追加提示，要求模型重新读取文件后再继续；
- 严格模式下模型不会因为 `read-only` 提示而拒绝尝试编辑（提示词已引导）。

## 6. 提示消息（为什么不再弹右下角通知）

- VS Code 没有"通知停留 5 秒"的公开 API 或设置（只有 `workbench.notifications.position` / `showInTitleBar`），扩展无法控制原生 toast 的存活时间。
- 因此插件的**所有临时消息**（提交成功、拒绝、冲突、超时、连接变化、操作失败等）改为**右下角状态栏消息**，显示 **5 秒**后自动消失：
  - 配置 `dpr.messageDurationMs`（1000–30000，默认 5000）可调；
  - 颜色：信息=普通、警告=黄、错误=红；完整内容也写入输出面板；
  - 若你更希望用原生通知：`dpr.useNativeNotifications = true`（停留时间回归 VS Code 控制）。
- **需要你操作的对话框不受影响**：Accept All 确认、清空历史确认、拒绝理由输入框都是模态/输入框，不会自动消失。
- Pending/History 视图在为空时用 `viewsWelcome` 常驻说明（新用户不会因为 5 秒太短而错过入口）。

## 7. 历史与审计

- **Review History**：最近 50 条决策（committed/rejected/conflict/expired/cancelled/failed、是否被用户编辑、所属 Host），点击可查看详情；"Clear History" 可清空（二次确认）。
- **`/review history [n]`**：当前 Host 的审计（跨月 JSONL，默认 10 条），只含路径/事件/哈希，不含文件内容。
- 审计文件：`~/.dsh/pre-edit-review/hosts/<hostKey>/audit/YYYY-MM.jsonl`（0600）。

## 8. 常用操作

```text
/review status            # Host key/label、安装默认、本会话是否启用、客户端连接、pending、文件策略、socket
/review on                # 启用本会话审查（之后写入进入审批）
/review off               # 关闭本会话审查（写入直接执行；状态栏显示 · 未启用）
/review strict            # 切到 read-only（不可绕过）
/review balanced          # 切回 workspace-write
/review history 20        # 当前 Host 最近 20 条审批记录
```

## 9. 故障排查

见 [troubleshooting.md](troubleshooting.md)。
