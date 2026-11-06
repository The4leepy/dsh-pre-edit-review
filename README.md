# DeepSeek Pre-edit Review

<!-- badges -->
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/The4leepy.deepseek-pre-edit-review?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=The4leepy.deepseek-pre-edit-review) [![CI](https://github.com/The4leepy/dsh-pre-edit-review/actions/workflows/ci.yml/badge.svg)](https://github.com/The4leepy/dsh-pre-edit-review/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/The4leepy/dsh-pre-edit-review?display_name=tag)](https://github.com/The4leepy/dsh-pre-edit-review/releases/latest)


**非官方社区项目（Unofficial）**：与 DeepSeek 官方无隶属关系。仓库：<https://github.com/The4leepy/dsh-pre-edit-review> ｜ [English README](README.en.md) ｜ [**交接文档（新接手先读）**](HANDOVER.md) ｜ [安全边界](docs/security.md) ｜ [发布指南](docs/publish.md)

Agent 提出的每一次文件修改，都先变成一份 **可编辑的左右分栏 diff**，用户在 VS Code 里改完并点击 **Accept** 之后，文件才真正写入。

> 安全前提：Agent 在审批前不能修改原始文件；严格模式下（会话 `read-only` 沙箱）它连 bash 都写不了。

> **0.3.0 起：安装 ≠ 自动审查。** 插件装好后默认「未启用」，不拦任何写入；在某个会话里
> `/review on` 之后，才对该会话启用"先审批后写"。详见 [docs/usage.md](docs/usage.md)。
>
> **多 Host 同时可用**：Desktop 与 TUI 两个 profile 可以各装一份、各连同一个 VS Code，
> 每个 Host 在 `~/.dsh/pre-edit-review/hosts/<hostKey>/` 下有自己的 socket/token/staging，
> 不再互相抢锁（ADR 0002）。

## 快速开始

```bash
git clone git@github.com:The4leepy/dsh-pre-edit-review.git
cd dsh-pre-edit-review && pnpm install && pnpm run build

scripts/install-extension.sh --build     # 装 VS Code 扩展（先）
scripts/install-plugin.sh                # 装 DSH 插件（先 arm kill switch）
scripts/doctor.sh                        # 体检
# 确认无误后解除急停：rm ~/.dsh/pre-edit-review/DISABLED
# 然后在需要审查的会话里：/review on（0.3.0 默认不拦截写入）
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
| 发布 | GitHub 公开仓库 + CI + Release（VSIX/tgz）、npm `dsh-pre-edit-review@0.2.1`、DSH format-1 索引、VS Code Marketplace `The4leepy.deepseek-pre-edit-review@0.2.5` | ✅ 全部完成，见 [docs/publish.md](docs/publish.md) |
| 0.3.0（ADR 0002） | 默认未启用 + 会话级 `/review on`；按 Host 隔离 socket/token/staging；扩展多 Host 连接与路由；IPC 绑定/令牌发布加固 | 🚧 代码与单测完成，待发布（见 [ADR 0002](docs/adr/0002-opt-in-activation-and-multi-host.md)） |

## 验证记录

- 人工交互测试（2026-11-05，真实 DSH + VS Code）：[docs/interaction-test-2026-11-05.md](docs/interaction-test-2026-11-05.md)

## 架构

```
Agent 工具调用 (write/edit)
      │
      ▼
DSH Host 插件 dsh-pre-edit-review（每个 Host 独立进程 + 独立 hosts/<hostKey>/ 命名空间）
  ├─ SessionActivation     安装默认未启用；会话级 /review on 才进入审批
  ├─ ToolClassifier        哪些调用必须审批（不只靠工具名）
  ├─ CommitTarget.prepare  解析路径 + 读快照（stat→read→stat 防竞态）
  ├─ ProposalBuilder       write/edit → proposed 全文
  ├─ StagingStore          <stateDir>/hosts/<key>/staging（0600/原子写/崩溃对账）
  ├─ IpcServer             per-Host UDS + JSON-RPC，token/nonce 鉴权，多 Host 互不抢锁
  └─ CommitTarget.commit   CAS（replaceIfVersion/createIfAbsent）+ 原子写
      │
      ▼
VS Code 扩展（`The4leepy.deepseek-pre-edit-review`）
  ├─ dpr: FileSystemProvider  →  diff 右侧可编辑
  ├─ vscode.diff              →  左 Original / 右 Proposed
  ├─ HostRegistry             →  发现并同时连接多个 Host，决策路由回签发方
  └─ Accept / Reject / 队列 / 状态栏 / 自动接受窗口
```

依赖方向：`shared`（纯类型）→ plugin / extension；`staging`、`ipc`、`protocol`、`extension` 都不依赖具体 `CommitTarget`（`DirectWorkspaceTarget` 已实现，`GitWorktreeTarget` 预留）。由 `pnpm run check:boundaries` 守护。

## 运行状态与安全模式

| 状态 | 进入方式 | 文件策略 | 说明 |
|---|---|---|---|
| **未启用（安装默认）** | 默认 / `/review off` | `workspace-write` | 不拦截写入；状态栏 `· 未启用`；这是 0.3.0 的默认 |
| 工具级（已启用） | 会话里 `/review on` | `workspace-write` | 拦截 `write`/`edit` 等工具；**bash/脚本可绕过**，文档与 `/review status` 明确标注 |
| 严格 | `/review strict` | `read-only`（OS 沙箱） | 沙箱拒绝一切写入；审批提交是唯一写路径 ⇒ 不可绕过 |
| 急停 | `touch ~/.dsh/pre-edit-review/DISABLED` | 不变 | 所有 Host 全量旁路（故障恢复通道） |

多 Host：Desktop / TUI 等不同 profile 各写 `~/.dsh/pre-edit-review/hosts/<hostKey>/`，可同时连接同一个 VS Code、各自审批；同一 profile 的第二个实例会得到 `HOST_IN_USE`。

## 文档索引

| 文档 | 内容 |
|---|---|
| [**HANDOVER.md**](HANDOVER.md) | **项目交接文档：架构/代码地图/契约/工作流/踩坑/交接清单（新 Agent 先读）** |
| [docs/install.md](docs/install.md) | 安装/升级/卸载、干净机器验收清单 |
| [docs/usage.md](docs/usage.md) | 审批流程、决策入口、运行状态（未启用/工具级/严格/急停）、命令 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见故障与恢复步骤（含多 Host） |
| [docs/security.md](docs/security.md) | 威胁模型、保证矩阵、已知限制 |
| [docs/adr/0002-opt-in-activation-and-multi-host.md](docs/adr/0002-opt-in-activation-and-multi-host.md) | 0.3.0 设计决策：会话级启用 + 按 Host 隔离 |
| [docs/install.md](docs/install.md) | 安装/升级/卸载、干净机器清单 |
| [docs/publish.md](docs/publish.md) | GitHub / npm / Marketplace / DSH 索引发布步骤 |
| [market/index.json](market/index.json) | 自托管 DSH format-1 插件索引 |
| [SECURITY.md](SECURITY.md) / [CONTRIBUTING.md](CONTRIBUTING.md) | 漏洞报告 / 单维护者约定 |
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

> **开发本仓库时的约定**：0.3.0 默认未启用，装上插件也不会自动拦截写入；但联调/跑 E2E 时若在某个会话 `/review on`，该会话就会被审批。需要不受打扰地改代码时，保持默认未启用、`/review off`，或先 `touch ~/.dsh/pre-edit-review/DISABLED`（全局 kill switch）；测试完卸载并清理状态目录。

真实环境安装（需要用户批准）：

```bash
# DSH 插件：通过 plugin_manager install_bundle 指向 packages/dsh-plugin（绝对路径）
# VS Code 扩展：
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension packages/vscode-extension/deepseek-pre-edit-review-0.3.0.vsix --force
```

## 安全边界（务必阅读，完整版见 [docs/security.md](docs/security.md)）

- **默认不审查**：安装后必须先在该会话 `/review on`，插件才开始拦截写操作；未启用时不会静默假装在保护。
- 工具级模式**不防** bash / python / sed / 脚本写入；要"审批前绝对不可写"请切换到严格模式（`/review strict`）。
- 会话已启用但 CLI/headless 场景没有 VS Code 客户端时会 fail-closed（拒绝写入），可用 `/review off`（仅用户可开、只影响当前会话）或配置 `enabled: false` 关闭。
- 崩溃时未审批请求一律保持未提交；重启后 pending 记录标记为 expired，绝不重放提交（按 Host 各自目录）。
- 急停开关：`touch ~/.dsh/pre-edit-review/DISABLED` 后 1 秒内**所有 Host** 的审批旁路（插件故障时的恢复通道）。
- **会话级开关（用户主动选择）**：`/review on` 启用、`/review off` 关闭；只决定是否审查，不改沙箱策略；状态栏显示 `· 未启用`，每次切换都写入审计；仅在内存中生效，Host 重启回到配置默认。`allowPause:false` 只禁止关闭，`mode: off` 禁止开启。
- 通信只接受对既有 `requestId` 的 accept/reject；协议中不存在"写任意文件"的方法；每个 Host 的 token 独立。
