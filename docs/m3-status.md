# M3 验收 — Phase 3（多文件队列 / 历史 / str_replace_editor / UI 打磨）

- 日期：2026-11-05
- 状态：**M3 达成**。Host 支持 `str_replace_editor` 提案与 `/review history`；VS Code 扩展 0.2.0 增加活动栏 Pending/History 视图、徽标、批量拒绝、历史持久化；扩展自检 27/27 通过；`str_replace_editor` 全链路 E2E 通过。
- 基线：M2.2（扩展 0.1.2，用户调整后的"单一决策入口 + 一次性引导"UX）之上的增量。

## 1. 交付物

### Host 插件

| 模块 | 内容 |
|---|---|
| `proposal.ts` | 新增 `str_replace_editor` 提案：`view` 直通；`create`（文件已存在则直通）；`str_replace`（按**原始字节**匹配、要求唯一、`new_str` 省略=删除、`null`=错误）；`insert`（`insert_line` 0..行数、多行插入）。前置条件不满足时一律直通，让真实工具产生其原生错误。 |
| `proposal.ts` / `commit-target` | `FileSnapshot` 增加可选 `rawContent`（保留行尾的原文），供按原始字节匹配的工具使用；旧快照兼容。 |
| `review-coordinator.ts` | `str_replace_editor` 合成成功值改为与真实工具一致：`New file created successfully at: <path>` / `The file <path> has been edited successfully.` |
| `config.ts` | 默认 `reviewTools` 增加 `str_replace_editor`。 |
| `history.ts` | 审计 JSONL 读取（跨月文件、倒序、跳过坏行、限制条数）与格式化。 |
| `index.ts` | `/review history [n]`（默认 10，最多 50）；命令提示词同步更新。 |

### VS Code 扩展 0.2.0

| 内容 | 说明 |
|---|---|
| 活动栏视图容器 | `dpr`（自带原创 `media/icon.svg`：盾牌 + 勾） |
| Pending 视图 | 待审批队列：路径 + `mode · tool`，tooltip 含绝对路径/打开时间/operation，点击打开对应 diff；行内 ✓ Accept / ✗ Reject |
| History 视图 | 最近 50 条决策（committed/rejected/conflict/expired/cancelled/failed），带状态图标与 `edited` 标记；标题栏"清空历史"（二次确认） |
| 视图标题栏 | Pending：Accept All（自动接受窗口）/ Reject All（清空队列并关闭自动接受）；History：Clear History |
| 徽标 | `TreeView.badge` 显示待审批数，归零自动清除 |
| 新增命令 | `dpr.acceptItem` / `dpr.rejectItem` / `dpr.openItem` / `dpr.rejectAll` / `dpr.clearHistory`；命令面板隐藏内部项 |
| 历史持久化 | `context.workspaceState` key `dpr.history`，同 requestId 覆盖，损坏数据容错为空表 |
| 事件接线 | `ReviewSession.onSettled`（accept/reject/auto-accept/conflict/expiry/host-cancel）→ 写历史 + 刷新两个视图；`onStateChanged` → 状态栏 + 视图 + 徽标 |
| 兼容 | 保留 M2.1 的编辑器标题栏 ✓/✗、快捷键、M2.2 的单一状态栏指示器与一次性引导，不回归 |

## 2. 验证

### 2.1 单元/集成测试：**70 passed / 0 failed**

新增：
- `test/proposal-editor.test.ts`（8）：`view`/相对路径直通、`create`（含已存在直通、CRLF）、`str_replace` 唯一匹配/原始字节/省略=删除/歧义直通/`null` 直通、`insert` 起点/末尾/越界/非整数、超限拒绝、`hasProposalBuilder`。
- `test/history.test.ts`（3）：坏行跳过与倒序、格式化（含空历史）、跨月文件与条数限制。
- 同步更新旧的 `proposal.test.ts` 中"MVP 只支持 write/edit"的断言。

全部：`tsc` 通过、`check:boundaries` 通过、插件 bundle 60.8 KB、扩展 bundle 377.4 KiB。

### 2.2 扩展自检（真实 VS Code 1.145.0）：**27 / 27 PASS**

证据：`docs/evidence/ext-selftest.json`。新增 9 步覆盖：历史存储写入/读回、Pending 视图行与清空、第三个请求的 rejectAll 命令（pending 1→0）与决策发送、树/历史 provider 刷新。

### 2.3 `str_replace_editor` 全链路 E2E（真实插件 + 假客户端）

为验证而**临时**在 profile 挂载 `@deepseek-ai/dsh-tool-str-replace-editor`（验证后已移除，profile 恢复原状）。证据：`docs/evidence/m3/`。

| # | 场景 | 结果 |
|---|---|---|
| ED1 | `create` 新文件，客户端 accept | committed；文件内容 = Agent 内容；工具返回 `New file created successfully at: …` |
| ED2 | `str_replace` 唯一匹配，客户端 **accept-edited**（模拟用户改稿） | committed；文件 = 用户版本；模型收到"用户改过提案"通知；审计 `edited: true` |
| ED3 | `insert` 多行插入，客户端 accept | committed；最终内容 `alpha\nINSERTED\nBETA\n\nE2E-USER-EDIT\n` 正确 |
| ED4 | `view` | **直通**：返回带行号内容，未产生审批记录 |
| ED5 | `str_replace` 歧义匹配 | **直通**：真实工具返回 `Multiple occurrences of old_str …`，文件未变、无审批记录 |
| K1 | kill switch 打开时 `create` | **直通**：直接写入，未产生审批记录 |

审计（3 条）：`review/committed edited=false / edited=true / edited=false`。

## 3. 与 plan.md 验收测试对照

| # | 测试 | 状态 |
|---|---|---|
| 1 | 普通修改：原文件不变 + 弹出审批 | ✅ |
| 2 | 编辑 Proposed：写入用户版本 | ✅（含 `str_replace_editor`） |
| 3 | Reject：原文件不变 | ✅ |
| 4 | 审批期间外部修改：冲突 | ✅（M2） |
| 5 | Bash 不可绕过 | ⏳ Phase 4（严格模式整会话 E2E） |
| 6 | 多文件：独立/全部审批 | ✅（扩展队列 + 视图 + Accept All/Reject All；Host 为串行到达，实际队列通常为 1，视图支持 N） |
| 7 | 客户端断开：无未批准写入 | ✅ |
| 8 | 重复提交：只提交一次 | ✅ |

## 4. 未验证 / 已知限制

1. **视图/历史面板的实际渲染**未目视验证（自动化只能断言 provider 与命令）；需要一次真实窗口确认徽标、行内按钮、标题栏按钮。
2. `str_replace_editor` 只有在 composition 挂载该工具时才可用；Desktop 默认未挂载，本文档记录了临时挂载方式（验证已还原）。
3. 多文件仍受 Host 串行派发限制：模型一次消息里的多个写调用会逐个到达审批，UI 队列可显示多条（实际通常 1 条）。
4. 自动接受窗口（Accept All）仍只在扩展 mock 中验证过。
5. Windows/Linux 未验证。

## 5. 环境现状

- `desktop` profile：插件已卸载；临时挂载的 `tool-str-replace-editor` 已移除；`~/.dsh/pre-edit-review` 已清理。
- VS Code：扩展 **0.2.0** 已安装；VS Code 当前未运行。
- teammate `vscode-phase3` 已完成并停止。

## 6. Phase 4（M4）下一步

1. 严格模式整会话 E2E：`/review strict`（read-only）下验证 bash/python/sed/脚本四种绕过均被 OS 沙箱拒绝，且审批提交仍可写。
2. 安全加固测试：伪造 nonce/token、重复/过期决策、断连风暴、崩溃对账、路径穿越/符号链接。
3. 崩溃恢复演练：审批中途 kill Host → 重启后 pending→expired、无提交。
4. 安全边界文档定稿 + `/review status` 文案核对。


## 7. M3.1 — 放行模式（review bypass，用户主动开启）

**需求**：用户希望在主动选择的情况下，Agent 可以直接修改代码、不走审批流程（不必每次点接受）。

**设计**：
- 命令：`/review bypass` 切换、`/review bypass on|off` 明确开关；`/review status` 显示当前会话是否放行。
- **只能由用户开启**：唯一写入口是会话命令 handlers（Host 从用户输入路由），Agent 的工具、IPC 协议、配置都不能打开它；`allowBypass:false` 可整体禁用。
- **会话级**：一个会话放行不影响其他会话；扩展状态栏显示 `· 放行 / · bypass`。
- **内存态**：Host 重启后自动复位为"审批开启"（fail safe）。
- **只跳过审批，不改沙箱**：`read-only` 会话即使放行也依然无法写文件。
- **可审计**：每次切换写 `review/bypass-on|off` 审计事件（只含 sessionId）。
- 协议增量：`hello` 结果新增可选 `bypass` 字段 + 服务端通知 `review/mode {bypass}`（向后兼容的加性字段，未升级协议版本号；两端同仓库发布）。

**验证**：
- 新增 `test/bypass.test.ts`（5 例）：registry 会话隔离/清除、`review/mode` 校验、`allowBypass` 默认与关闭、gate 对放行会话直通、另一会话仍走审批。
- 全套 **75 / 75** 通过；`tsc`、边界检查、插件 bundle（63.8 KB）、扩展 0.2.1 构建通过。
- 扩展自检 **27 / 27** 通过（VS Code 1.145.0）。

**未验证**：`/review bypass` 命令需用户实际输入一次（Agent 无法触发用户命令）；扩展状态栏 `· 放行` 的视觉效果需目视。

**开发约定（重要）**：本仓库日常开发期间**不安装** `dsh-pre-edit-review` 插件，避免 Agent 改项目代码时反复弹审批；联调/E2E 时先 arm `DISABLED` kill switch，结束后卸载并清理状态目录。
