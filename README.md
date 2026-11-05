# DeepSeek Pre-edit Review

Agent 提出的每一次文件修改，都先变成一份 **可编辑的左右分栏 diff**，用户在 VS Code 里改完并点击 **Accept** 之后，文件才真正写入。

> 安全前提：Agent 在审批前不能修改原始文件；严格模式下（会话 `read-only` 沙箱）它连 bash 都写不了。

## 快速开始

```bash
scripts/install-extension.sh --build     # 装 VS Code 扩展（先）
scripts/install-plugin.sh                # 装 DSH 插件（先 arm kill switch）
scripts/doctor.sh                        # 体检
# 确认无误后解除急停：rm ~/.dsh/pre-edit-review/DISABLED
```

详细步骤：[docs/install.md](docs/install.md)｜日常使用：[docs/usage.md](docs/usage.md)｜出问题：[docs/troubleshooting.md](docs/troubleshooting.md)

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1.5 / M1 | 可行性 spike（S1/S2/S3）+ 接口冻结 | ✅ 完成，见 [docs/m1-status.md](docs/m1-status.md) |
| Phase 2 / M2 | Host 全链路 + `/review` 命令 + VS Code 客户端 + E2E（59 单测 / 18 项扩展自检 / 6 场景 E2E） | ✅ 完成，见 [docs/m2-status.md](docs/m2-status.md) |
| M2.1 UX | 审批按钮常驻：编辑器标题栏 ✓/✗（M2.2 起为唯一决策入口） | ✅ 完成 |
| M2.2 UX | 去除重复入口；状态栏单一高亮指示；通知改为每会话首次一次性引导（无按钮） | ✅ 完成，见 [docs/m2-status.md](docs/m2-status.md#10-m22-ux-再调整用户反馈2026-11-05) |
| Phase 3 / M3 | 多文件队列视图、历史面板、批量拒绝、`str_replace_editor` 提案、`/review history` | ✅ 完成，见 [docs/m3-status.md](docs/m3-status.md) |
| Phase 4 / M4 | 严格模式整会话 E2E、IPC nonce/帧上限、崩溃对账与演练、`docs/security.md` 定稿 | ✅ 完成，见 [docs/m4-status.md](docs/m4-status.md) |
| Phase 5 / M5 | 安装/卸载/体检脚本、打包整理（LICENSE/CHANGELOG）、安装/使用/排障文档 + 干净机器清单 | ✅ 完成，见 [docs/m5-status.md](docs/m5-status.md) |

## 架构

```
Agent 工具调用 (write/edit)
      │
      ▼
DSH Host 插件 dsh-pre-edit-review
  ├─ ToolClassifier        哪些调用必须审批（不只靠工具名）
  ├─ CommitTarget.prepare  解析路径 + 读快照（stat→read→stat 防竞态）
  ├─ ProposalBuilder       write/edit → proposed 全文
  ├─ StagingStore          ~/.dsh/pre-edit-review（0600/原子写/崩溃对账）
  ├─ IpcServer             UDS + JSON-RPC，token/nonce 鉴权
  └─ CommitTarget.commit   CAS（replaceIfVersion/createIfAbsent）+ 原子写
      │
      ▼
VS Code 扩展（`The-4leepy.deepseek-pre-edit-review`）
  ├─ dpr: FileSystemProvider  →  diff 右侧可编辑
  ├─ vscode.diff              →  左 Original / 右 Proposed
  └─ Accept / Reject / 队列 / 状态栏 / 自动接受窗口
```

依赖方向：`shared`（纯类型）→ plugin / extension；`staging`、`ipc`、`protocol`、`extension` 都不依赖具体 `CommitTarget`（`DirectWorkspaceTarget` 已实现，`GitWorktreeTarget` 预留）。由 `pnpm run check:boundaries` 守护。

## 两种安全模式

| 模式 | 文件策略 | 保证等级 |
|---|---|---|
| 工具级（默认） | `workspace-write` | 拦截 `write`/`edit` 等工具；**bash/脚本可绕过**，文档与 `/review status` 明确标注 |
| 严格 | `read-only`（`/review strict`） | OS 沙箱拒绝一切写入；审批提交是唯一写路径 ⇒ 不可绕过 |

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | 安装/升级/卸载、干净机器验收清单 |
| [docs/usage.md](docs/usage.md) | 审批流程、决策入口、四种运行状态、命令 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 十类常见故障与恢复步骤 |
| [docs/security.md](docs/security.md) | 威胁模型、保证矩阵、已知限制 |
| [docs/m1-status.md](docs/m1-status.md) … [m5-status.md](docs/m5-status.md) | 各阶段验收 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

## 仓库结构

```
packages/
  shared/             协议 v1、CommitTarget、ReviewRecord、文本语义（纯类型 + 纯函数）
  dsh-plugin/         DSH Host 插件（npm 包 + cordis.patch.yml bundle）
  vscode-extension/   VS Code 扩展（本地 VSIX）
  spikes/probe/       M1 的临时探针（保留作为 S1/S3 证据与回归工具）
scripts/              build / boundary guard / e2e client / install
docs/                 可行性报告、spike 报告、接口冻结、ADR、阶段验收、evidence/
test/                 node --test 单测
```

## 开发

```bash
pnpm install                      # 若 ~/.npm 被沙箱限制：npm_config_cache=/tmp/… pnpm --store-dir /tmp/…
pnpm run check                    # typecheck + boundary guard + unit tests
pnpm run build                    # 插件 bundle + 扩展 bundle
pnpm run package:extension        # 产出 packages/vscode-extension/*.vsix
```

> **开发本仓库时的约定**：不要在日常开发中把 `dsh-pre-edit-review` 装进你自己的 profile——那会让 Agent 每次改项目代码都弹审批。需要联调/跑 E2E 时，先 `touch ~/.dsh/pre-edit-review/DISABLED`（kill switch），安装、测试、卸载后再删除状态目录。

真实环境安装（需要用户批准）：

```bash
# DSH 插件：通过 plugin_manager install_bundle 指向 packages/dsh-plugin（绝对路径）
# VS Code 扩展：
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension packages/vscode-extension/deepseek-pre-edit-review-0.1.0.vsix --force
```

## 安全边界（务必阅读，完整版见 [docs/security.md](docs/security.md)）

- 工具级模式**不防** bash / python / sed / 脚本写入；要"审批前绝对不可写"请切换到严格模式（`/review strict`）。
- 插件安装在 profile 后对该 profile 的**所有会话**生效；CLI/headless 场景没有 VS Code 客户端时会 fail-closed（拒绝写入），可用 `/review off`（仅用户可开、只影响当前会话）或配置 `enabled: false` 关闭。
- 崩溃时未审批请求一律保持未提交；重启后 pending 记录标记为 expired，绝不重放提交。
- 急停开关：`touch ~/.dsh/pre-edit-review/DISABLED` 后 1 秒内所有审批旁路（插件故障时的恢复通道）。
- **暂停审批（用户主动选择）**：在会话里输入 `/review off` 暂停、`/review on` 恢复。暂停后该会话的文件写入**直接执行、不再弹审批**（沙箱策略不变，`read-only` 仍然禁写）；状态栏显示 `· 已关闭`，每次切换都写入审计。仅在内存中生效，Host 重启自动恢复审批。`allowPause:false` 可整体禁用该命令。
- 通信只接受对既有 `requestId` 的 accept/reject；协议中不存在"写任意文件"的方法。
