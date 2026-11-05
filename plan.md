
建议将项目命名为 DeepSeek Pre-edit Review，定位为 DeepSeek Harness Desktop 与 VS Code 之间的独立代码变更审批系统。

核心原则：Agent 可以提出修改，但绝对不能在用户审批之前修改原始文件。用户拥有最终写入权限。

下面是一份可以直接交给 Agent 执行的项目规划。我把架构、模块划分、技术要求、开发阶段和验收标准都写进去了。

项目规划：DeepSeek Pre-edit Review

1. 项目目标

开发一个 VS Code 扩展及 DeepSeek Harness 插件，实现 Agent 修改代码前的人工审批（Pre-edit Approval）。

目标是恢复并增强 Claude Code 早期的交互体验：

1. Agent 提出代码修改请求。
2. VS Code 自动弹出左右分栏 Diff 审批窗口。
3. 左侧显示原始代码（Original）。
4. 右侧显示 Agent 提出的修改（Proposed）。
5. 用户可以直接编辑右侧 Proposed Content。
6. 用户可以选择 Accept 或 Reject。
7. 只有用户点击 Accept 后，才允许修改原始文件。
8. Reject 后原始文件必须保持不变，并将拒绝结果返回给 Agent。

本项目必须支持多文件修改、逐文件审批和安全写入。

2. 技术架构

采用 VS Code Extension + Harness Plugin + 本地 IPC 通信的架构。

模块 A：VS Code Extension

负责：

* 注册 VS Code 扩展命令。
* 接收 Harness 的待审批请求。
* 打开左右分栏 Diff 审批界面。
* 展示 Original 和 Proposed 内容。
* 允许用户编辑 Proposed 内容。
* 提供 Accept、Reject、Accept All、Reject All。
* 支持逐文件审批。
* 将用户最终确认的内容发送给 Harness。
* 展示审批历史和待处理任务。

技术要求：

* TypeScript。
* VS Code Extension API。
* VS Code Webview API 或自定义编辑器。
* vscode.workspace.openTextDocument。
* vscode.diff。
* vscode.commands。

注意：VS Code 原生 Diff Editor 的右侧文档通常是只读的。不能直接假设 vscode.diff 生成的右侧可以编辑。

建议使用 Custom Editor 或 Webview 构建可编辑的左右分栏审批界面。也可以使用两个独立 TextDocument 实现左右编辑视图。

模块 B：DeepSeek Harness Plugin

负责拦截 Agent 的文件修改操作。

必须覆盖：

* write
* edit
* str_replace_editor
* create_file
* delete_file
* rename_file
* 其他实际存在的文件修改工具

开发前必须检查 DeepSeek Harness Desktop 当前版本的工具注册机制、Plugin API 和生命周期钩子。

优先使用官方支持的 pre-execute hook。

不得假设 CLI、Web 和 Desktop 使用相同的插件加载目录或运行时配置。

拦截流程：

1. 获取 Agent 的修改请求。
2. 读取原始文件内容。
3. 根据修改请求生成完整 Proposed Content。
4. 计算 Diff。
5. 将请求发送到 VS Code。
6. 阻塞当前文件修改操作，等待用户审批。
7. 收到 Accept 后，使用用户最终编辑的 Proposed Content 执行写入。
8. 收到 Reject 后，取消当前操作并将拒绝原因返回 Agent。

关键要求：审批前绝对不能调用原始文件写入工具。

如果 Harness 的插件 API 无法在工具执行前拦截并挂起操作，必须明确报告，不得用事后回滚冒充修改前审批。

模块 C：IPC 通信层

负责 Harness 和 VS Code 之间的通信。

优先采用 macOS Unix Domain Socket。

通信结构：

Harness Plugin
↓
IPC Server
↓
VS Code Extension
↓
Approval UI
↓
IPC Response
↓
Harness Plugin
↓
Atomic File Commit

通信协议使用 JSON-RPC 2.0 或结构化 JSON 消息。

必须支持：

* request_id
* session_id
* workspace_id
* file_path
* original_content
* proposed_content
* diff
* operation_type
* approval_status
* final_content
* error

所有请求必须具有唯一 ID。

增加连接超时、审批超时、客户端断开处理和请求状态恢复。

模块 D：文件安全提交层

这是项目最重要的安全模块。

必须满足：

1. 审批前不修改原始文件。
2. Proposed Content 存储在内存或独立暂存目录。
3. Accept 后才执行文件写入。
4. Reject 后删除暂存内容。
5. 写入前检查原始文件是否发生变化。
6. 如果原始文件在审批期间被其他程序修改，拒绝自动提交并要求重新审批。
7. 写入采用临时文件 + 原子替换。
8. 保留文件权限和必要的文件元数据。
9. 支持多文件事务或明确的逐文件提交策略。
10. 禁止路径穿越、越权写入和工作区外文件修改。

建议使用 SHA-256 对原始文件进行版本校验。

每个审批请求保存：

* 原始文件 SHA-256。
* Proposed Content SHA-256。
* 最终提交内容 SHA-256。

模块 E：审批 UI

界面必须简洁，接近 Claude Code 的修改审批体验。

布局：

┌────────────────────────────────────────────┐
│ DeepSeek Pre-edit Review                   │
├──────────────────────┬─────────────────────┤
│ Original             │ Proposed            │
│                      │                     │
│ 原始代码             │ 修改后代码          │
│                      │                     │
│                      │ 可直接编辑          │
│                      │                     │
├──────────────────────┴─────────────────────┤
│ Accept │ Reject │ Accept All │ Reject All  │
└────────────────────────────────────────────┘

功能要求：

* 左右分栏。
* 原始内容只读。
* Proposed 内容可编辑。
* 语法高亮。
* 行号显示。
* Diff 高亮。
* 新增行绿色标记。
* 删除行红色标记。
* 修改行支持清晰的差异展示。
* 显示文件路径和修改类型。
* 支持多文件切换。
* 支持逐文件 Accept/Reject。
* 支持全局 Accept All/Reject All。
* 编辑后实时更新 Diff。
* Accept 前显示最终提交内容。
* Reject 后向 Agent 返回拒绝信息。

不允许将普通只读 Diff Viewer 当作最终产品。

3. 完整工作流程

阶段 1：Agent 生成修改

Agent 调用文件修改工具。

Harness Plugin 在执行之前拦截请求。

阶段 2：生成暂存内容

读取原始文件，生成 Proposed Content。

禁止调用实际文件写入操作。

阶段 3：打开 VS Code 审批窗口

VS Code 自动打开审批界面。

左侧 Original，右侧 Proposed。

用户可以直接修改右侧内容。

阶段 4：用户审批

Accept：

* 获取用户最终编辑的内容。
* 返回 Harness。
* 验证原始文件 SHA-256。
* 执行安全写入。
* 向 Agent 返回成功结果。

Reject：

* 删除暂存内容。
* 原始文件保持不变。
* 向 Agent 返回拒绝结果。
* Agent 可以根据拒绝原因重新生成修改方案。

阶段 5：Agent 继续执行

只有成功提交的修改才能被 Agent 视为已完成。

Agent 不得将被拒绝的修改视为已经写入。

4. 多文件修改支持

必须考虑 Agent 一次修改多个文件的情况。

例如：

src/main.py
src/utils.py
tests/test_main.py

每个文件都有独立 Diff。

提供：

* 单文件 Accept。
* 单文件 Reject。
* 全部 Accept。
* 全部 Reject。
* 修改文件数量统计。
* 新增、删除、修改文件分类。

第一阶段可以采用逐文件提交。

但必须避免出现部分文件提交后，其他文件提交失败而导致项目处于不一致状态。

5. 安全要求

这是强制要求，不允许为了方便牺牲。

* 默认拒绝未经审批的写入。
* 不允许审批前修改原文件。
* 不允许通过 Bash、Python、Shell 等命令绕过审批。
* 必须检查所有可能修改文件的工具。
* 默认禁止工作区外写入。
* 拒绝过期审批请求。
* 防止重复 Accept 导致重复提交。
* 防止 IPC 伪造审批响应。
* IPC 必须验证客户端身份。
* 敏感内容不得写入普通日志。
* VS Code 或 Harness 崩溃时，未审批的请求必须保持未提交状态。

特别注意：不能只拦截 write/edit 工具。Agent 可能使用 Bash 的重定向、sed、python、perl、脚本执行等方式修改文件。

如果无法可靠拦截所有文件修改途径，必须采用文件系统权限隔离或独立工作区方案，并明确报告安全边界。

6. 开发阶段

Phase 1：技术可行性验证

首先研究：

* DeepSeek Harness Desktop 版本及其运行时。
* 插件加载机制。
* 工具执行生命周期。
* 是否支持异步挂起 pre-execute hook。
* 文件工具的实际名称。
* Desktop 的配置目录。
* IPC 可用性。

交付：

* 技术可行性报告。
* Harness Plugin API 适配方案。
* 风险清单。

此阶段不允许直接修改 Desktop 内部源码。

Phase 2：最小可行版本 MVP

实现：

* 文件修改拦截。
* 原始文件读取。
* Proposed Content 暂存。
* IPC 通信。
* VS Code 左右分栏。
* 右侧内容编辑。
* Accept。
* Reject。
* Accept 后安全写入。

先支持单文件 write 和 edit。

Phase 3：完善 Diff 审批

增加：

* 语法高亮。
* 行级 Diff。
* 实时 Diff 更新。
* 多文件审批。
* Accept All。
* Reject All。
* 审批历史。

Phase 4：安全加固

增加：

* SHA-256 版本校验。
* 原子写入。
* IPC 身份验证。
* 超时处理。
* 崩溃恢复。
* Bash 和脚本写入拦截。
* 文件权限检查。

Phase 5：打包和部署

交付：

* VS Code VSIX 安装包。
* Harness Plugin 安装包。
* macOS 安装脚本。
* 配置说明。
* 使用说明。
* 故障排查文档。

7. 验收测试

以下测试全部通过才算完成。

测试 1：普通文件修改

Agent 修改一个 Python 文件。

预期：原始文件不变，VS Code 自动弹出 Diff 审批窗口。

测试 2：编辑 Proposed Content

用户在右侧增加一行代码。

预期：Diff 实时更新，Accept 后写入的是用户最终编辑的版本，而不是 Agent 最初提交的版本。

测试 3：Reject

用户拒绝修改。

预期：原始文件 SHA-256 不变。

测试 4：审批期间文件发生变化

其他程序修改了原始文件。

预期：Accept 失败，提示文件冲突，禁止覆盖。

测试 5：Agent 尝试 Bash 写入

Agent 使用 Python、sed 或 Shell 重定向修改文件。

预期：不能绕过审批机制。

测试 6：多文件修改

Agent 同时修改三个文件。

预期：每个文件均有独立审批界面，支持逐文件及全部审批。

测试 7：客户端断开

VS Code 在审批期间关闭。

预期：没有任何未经批准的文件写入。

测试 8：重复提交

用户重复点击 Accept 或 IPC 重复发送确认消息。

预期：同一个 request_id 只能提交一次。

8. 技术选型

建议：

* VS Code Extension：TypeScript。
* UI：VS Code Webview 或 Custom Editor。
* Harness Plugin：根据 Desktop 实际插件运行时选择 TypeScript 或 Python。
* IPC：macOS Unix Domain Socket。
* 数据协议：JSON-RPC 2.0。
* Diff 算法：diff-match-patch 或 jsdiff。
* 文件完整性：SHA-256。
* 文件提交：临时文件 + 原子替换。
* 测试：Vitest + VS Code Extension Test。

所有依赖必须评估维护状态和许可证。

9. Agent 执行要求

请先进行技术调研，不要直接开始大规模编码。

执行顺序：

1. 检查当前 DeepSeek Harness Desktop 版本。
2. 检查其官方 Plugin API。
3. 验证是否存在真正的修改前拦截机制。
4. 验证能否暂停 Agent 工具执行并等待外部审批。
5. 输出技术可行性报告。
6. 设计接口和项目目录。
7. 获得可行性确认后开始实现 MVP。
8. 每个阶段运行自动化测试。
9. 记录所有未实现功能和安全限制。

禁止：

* 用事后 Diff 冒充修改前审批。
* 用文件回滚冒充审批。
* 在原始文件上直接生成 Proposed Content。
* 假设 Desktop 和 CLI 的 Plugin API 完全一致。
* 未验证 Harness API 就编造接口。
* 为实现功能而直接修改 Desktop 应用内部文件。

最终目标：实现一个可靠的、可编辑的、真正修改前审批的 VS Code Agent Diff Review 系统。

给 Agent 的额外执行指令

我建议你把下面这段放在项目规划之后，作为 Agent 的最高优先级约束：

在整个项目开发过程中，安全性优先于功能完整性。

特别强调：不能先修改原文件，再通过 Git、备份文件或回滚机制模拟审批。必须在文件写入操作发生之前拦截 Agent，并将完整的 Proposed Content 暂存。

如果 DeepSeek Harness Desktop 当前版本不支持异步挂起工具调用，请停止直接集成方案的开发，先研究是否可以通过工具代理（Tool Proxy）、独立工作区或文件系统隔离实现。

任何时候，只要无法确定某个工具是否可能修改原始文件，就必须默认阻止该工具执行，直到确认其安全性。

请优先提交 Phase 1 的技术可行性报告，不要未经验证就开始编写大量代码。

我的技术建议

有一个架构决策尤其重要：不要让 Harness 直接拥有原始工作区的写入权限。

更可靠的长期方案是：

* Harness 在独立暂存区生成修改。
* VS Code 读取暂存内容并提供编辑界面。
* 用户 Accept 后，由受控 Commit Service 将内容写入原始工作区。

这样即使 Agent 尝试通过 Python、Bash、Shell 等方式绕过 write/edit 审批，也不会直接破坏原始文件。

建议把这个架构作为最终目标，而不是只依赖拦截几个文件编辑工具。
