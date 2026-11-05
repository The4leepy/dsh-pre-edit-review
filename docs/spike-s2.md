# S2 Spike 报告 — VS Code「可编辑左右分栏 diff」验证

- 日期：2026-11-05
- 环境：VS Code **1.145.0**（macOS arm64）、扩展 `The-4leepy.deepseek-pre-edit-review@0.1.0`（本地 VSIX 安装）
- 方法：扩展激活后自动执行自检（`vscode.diff` + 自定义 `FileSystemProvider`），把结构化结果写入 `.spike/s2-report.json`
- 结论：**通过（PASS）**。自定义 scheme 作为 diff **右侧（modified）**时是**可编辑文档**：`WorkspaceEdit` 生效、文档变 dirty、`document.save()` 回调 provider `writeFile` 并收到用户编辑后的**完整最终内容**；左侧原文件保持不变。

## 1. 要回答的问题

VS Code 原生 diff 右栏是否能编辑？自定义 `FileSystemProvider`（不设 `isReadonly`）作为 modified 侧时，用户编辑能否回传给扩展？
（这是官方文档没有写死、必须实测的一点；`TextDocumentContentProvider` 方案则按设计只读，已排除。）

## 2. 自检步骤与结果（全部 ok）

| 步骤 | 结果 |
|---|---|
| trigger | 激活后 ~1.5s 自动运行 |
| create-original | 写入 `.spike/s2-original.txt`（18 字符，`line1\nline2\nline3\n`） |
| register-fs-provider | 注册 `dpr:` scheme；未设置 `isReadonly`；种子内容 `line1\nline2 changed\nline3\n` |
| open-diff | `vscode.diff(file:…/.spike/s2-original.txt, dpr:/s2/proposal.txt, "S2 Editable Diff", {preview:false})` |
| document-found | proposal 文档出现在 `visibleTextEditors` 中，`isDirty=false` |
| document-scheme | `uri.scheme === "dpr"` |
| document-readonly | `TextDocument.isReadOnly` 不在公共 API（运行时探测为 undefined）；编辑能力由 `applyEdit` 证明 |
| **writable-file-system** | `vscode.workspace.fs.isWritableFileSystem("dpr") === true` |
| **apply-edit** | 在文档末尾插入 `S2-USER-EDIT`，`workspace.applyEdit` 返回 **true** |
| **edit-visible-in-document** | 文档长度 26→38，`endsWithMarker=true`，`isDirty=true`（等同用户输入） |
| active-editor | 活动编辑器即 `dpr:/s2/proposal.txt`（位于 diff 标签页内） |
| diff-tab | diff 标签页 `input.kind === "diff"`，`original=file:…`、`modified=dpr:…` |
| **document-save** | `document.save()` 返回 true，保存后 `isDirty=false` |
| **provider-writeFile** | provider 的 `writeFile` 被调用 1 次，收到 38 字符，**内容 = 用户最终编辑文本** |
| read-back | `workspace.fs.readFile` 读回一致 |
| original-untouched | 左侧原文件仍为 18 字符 `line1\nline2\nline3\n` |

原始报告：`docs/evidence/spike-s2-report.json`。

## 3. 结论与设计影响

1. **采用主方案**：`FileSystemProvider`（scheme `dpr:`，不设 `isReadonly`）+ `vscode.diff`（右=proposal，左=真实文件）。
   - 原生编辑体验：undo/redo、选区、多光标、主题、行号、diff 高亮全部直接可用；
   - 右侧语法高亮：打开后用 `vscode.languages.setTextDocumentLanguage()` 按扩展名设置（Phase 2 实现）。
2. **决策通道 = 按钮，不是保存**：由于「无法拦截保存」，Accept/Reject 必须由扩展自己的按钮/命令触发；`writeFile` 只作为「内容已同步」信号，绝不把它当同意。
3. **用户未保存也有最终内容**：Accept 时从 `TextDocument.getText()` 取（含未保存编辑），随后 `save()` 清理 dirty 状态再关标签页，避免 VS Code 的"是否保存"弹窗。
4. 关闭/清理策略：Reject 时先 `revert`（走 provider `readFile` 回滚脏状态）再关闭，避免弹窗（Phase 2 实现）。
5. 原文件在审批期间完全不被触碰（左侧只是 `file:` 只读展示）。

## 4. 已知限制 / 待办

1. `TextDocument.isReadOnly` 不是公共 API；可编辑性以 `applyEdit`/`writeFile` 为证据，不在产品代码里依赖该字段。
2. diff 标签页的 `activeTextEditor` 指向 proposal 文档，符合预期；但"关闭指定标签页"需用 `vscode.window.tabGroups.close(tab)`（Phase 2）。
3. 本 spike 扩展只有自检命令，没有 IPC；Phase 2 在此骨架上接 UDS 客户端与审批队列。
4. **publisher 偏差**：`vsce` 拒绝下划线，`The_4leepy` 无法打包，实际使用 `The-4leepy`（扩展 ID `The-4leepy.deepseek-pre-edit-review`）。已向用户报告，若必须用 `The_4leepy` 需换打包方式或改 publisher。
5. VS Code 窗口由自检脚本以 `code -n <workspace>` 打开；未改动用户已有窗口。

## 5. 复现

```bash
cd packages/vscode-extension && node build.mjs
../../node_modules/.bin/vsce package --no-dependencies --allow-missing-repository
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension deepseek-pre-edit-review-0.1.0.vsix --force
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" -n <workspace>
# 约 7s 后读取 <workspace>/.spike/s2-report.json
```
