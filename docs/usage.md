# 使用说明

## 1. 一次审批的完整流程

1. Agent 调用 `write` / `edit` / `str_replace_editor`；
2. Host 插件在工具执行**之前**拦截，读取原文、生成 proposed 全文，落盘到 staging；
3. VS Code 自动打开左右分栏：
   - 左：Original（真实文件，只读）
   - 右：Proposed（**可编辑**，原生 undo/主题/行号/diff 高亮）
4. 你在右侧按需要改代码，然后：
   - **Accept**：写入的是「你最终看到的内容」（含未保存编辑）；文件被原子替换并做版本校验；
   - **Reject**：原文件不变，Agent 收到拒绝（可附理由）。
5. 审批期间文件被其它程序改动 → Accept 失败并提示冲突，**不会覆盖**；Agent 会收到"重新读取后再提案"。

## 2. 在哪里点 Accept / Reject

| 入口 | 说明 |
|---|---|
| **编辑器标题栏** | diff 激活且有 pending 时，右上角（`⬆️⬇️` 旁）出现 `✓` / `✗` |
| **快捷键** | `Ctrl+Alt+A` 接受 / `Ctrl+Alt+R` 拒绝（推荐，避开与其他扩展冲突）；备用 `Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace` |
| **状态栏** | 有待审批时盾牌项高亮，点击打开待审批队列 |
| **活动栏 Pre-edit Review** | Pending Reviews（行内 ✓/✗）、Review History |
| **命令面板** | `Pre-edit Review: Show Pending Reviews` 等 |

> 通知气泡只是提示，会消失；**正式决策入口是标题栏与队列视图**（不要依赖通知中心）。

## 3. 多文件

模型一次消息里的多个写调用会被逐个拦截、逐个弹出审批（Host 侧串行）。Pending 视图会显示当前队列，支持逐文件 Accept/Reject；`Reject All` 清空队列，`Accept All` 是"5 分钟内自动接受"的显式预授权窗口（需先在设置里允许 `dpr.autoAccept`）。

## 4. 四种运行状态

| 状态 | 进入方式 | 效果 |
|---|---|---|
| 工具级（默认） | 默认 | 仅拦截工具写入；**bash/脚本可绕过**，状态栏无特殊标记 |
| 严格模式 | 用户执行 `/review strict`（会话 `read-only`） | OS 沙箱拒绝一切写入；Agent 唯一写路径是审批提交。代价：构建/安装/测试会失败 |
| 放行模式 | 用户执行 `/review bypass` | 该会话写操作直接执行、不弹审批；状态栏显示 `· 放行`；沙箱不变；Host 重启复位 |
| 急停开关 | 用户/维护者创建 `~/.dsh/pre-edit-review/DISABLED` | 插件旁路所有审批（仅用于故障恢复） |

模式建议：
- 日常开发希望被打断 → 默认工具级；
- 关键仓库/不受信任 Agent → 严格模式（`/review strict`）；
- 明确信任 Agent、成批改代码 → 放行模式（`/review bypass`），改完建议 `off`。

## 5. Agent 侧行为（你不需要手动教它）

- 模型提示词已说明：修改走 `write`/`edit`；被拒绝要重新提案；冲突要重新读取；不得用 shell 绕过；
- 如果你改过提案，插件会在工具结果后追加提示，要求模型重新读取文件后再继续；
- 严格模式下模型不会因为 `read-only` 提示而拒绝尝试编辑（提示词已引导）。

## 6. 历史与审计

- **Review History**：最近 50 条决策（committed/rejected/conflict/expired/cancelled/failed、是否被用户编辑），点击可查看详情；"Clear History" 可清空（二次确认）。
- **`/review history [n]`**：Host 侧审计（跨月 JSONL，默认 10 条），只含路径/事件/哈希，不含文件内容。
- 审计文件：`~/.dsh/pre-edit-review/audit/YYYY-MM.jsonl`（0600）。

## 7. 常见操作

```text
/review status            # 当前开关、客户端连接、pending 数、文件策略、是否放行
/review on | off          # 运行时开关（本 profile 会话）
/review strict            # 切到 read-only（不可绕过）
/review balanced          # 切回 workspace-write
/review bypass on | off   # 放行模式
/review history 20        # 最近 20 条审批记录
```

## 8. 故障排查

见 [troubleshooting.md](troubleshooting.md)。
