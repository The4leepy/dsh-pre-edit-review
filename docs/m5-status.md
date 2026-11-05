# M5 验收 — Phase 5（打包与交付）

- 日期：2026-11-05
- 状态：**M5 达成，项目全部阶段（M1–M5）完成**。
- 本阶段目标：让另一台机器/另一个人按文档即可安装、验证、使用与卸载；把"首次安装可能自锁"的风险固化成脚本顺序。

## 1. 交付物

### 1.1 安装/维护脚本

| 脚本 | 作用 | 关键安全点 |
|---|---|---|
| `scripts/install-extension.sh` | 安装（或 `--build` 重新构建+打包）VSIX | 自动找 `code` CLI（PATH 或 macOS app 路径） |
| `scripts/install-plugin.sh` | 安装/启用 DSH 插件 | **先 arm kill switch 再安装**；没有 `dsh` CLI 时打印 Web GUI / `plugin_manager` 的准确步骤（exit 2） |
| `scripts/uninstall.sh` | 移除扩展 + 插件注册；`--purge` 删状态目录 | 插件仍未注销时保留软链并提示，不制造坏注册 |
| `scripts/doctor.sh` | 体检 | 报告扩展/插件/state dir/权限/socket/token/kill switch；有 FAIL 时 exit 1 |
| `scripts/_common.sh` | 共享路径/CLI 探测 | 支持 `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DPR_STATE_DIR` 覆盖 |

### 1.2 文档

- **[install.md](install.md)**：前置条件、安装顺序、升级、卸载、**干净机器验收清单**（12 步）。
- **[usage.md](usage.md)**：审批流程、四个决策入口、多文件、四种运行状态（工具级/严格/放行/急停）、命令速查。
- **[troubleshooting.md](troubleshooting.md)**：A–J 十类故障（无客户端、离线、鉴权失败、插件自锁恢复、冲突、严格模式构建失败、放行忘记关闭、视图消失、自检失败、卸载残留）。
- **[security.md](security.md)**：安全边界定稿（Phase 4）。

### 1.3 打包整理

- `LICENSE`（Apache-2.0，仓库根 + 扩展包内各一份）；`CHANGELOG.md` 覆盖 M1–M5。
- 插件版本 **0.2.0**，`license: Apache-2.0`，`files` 明确列出产物。
- 扩展版本 **0.2.1**，`license: Apache-2.0`；VSIX 9 个文件、约 107 KB（含 `media/icon.svg`、`package.nls*`）。
- 根 `package.json` 版本 0.2.1；`pnpm run check` / `build` / `package:extension` 可用。

## 2. 本机验证（完整安装→使用→卸载循环）

证据：`docs/evidence/m5/install-cycle.json`

| 步骤 | 结果 |
|---|---|
| `scripts/install-extension.sh` | ✅ 安装 0.2.1 |
| `scripts/install-plugin.sh`（无 `dsh` CLI） | ✅ 先 arm kill switch，再打印手动安装路径（exit 2 为设计） |
| `plugin_manager install_bundle`（按文档手动步骤） | ✅ 插件 0.2.0 注册并生效 |
| `scripts/doctor.sh`（已安装态） | ✅ 无失败；kill switch 为预期 WARN |
| 扩展自检（真实 VS Code 1.145.0） | ✅ **27 / 27** |
| 解除 kill switch 后一次真实审批（假客户端 accept） | ✅ reviewed → committed；文件内容正确；审计 `review/committed` |
| `scripts/uninstall.sh --purge --yes` | ✅ 扩展移除、状态目录清空、打印插件手动注销步骤 |
| `plugin_manager remove_bundle` + `scripts/doctor.sh` | ✅ 无失败，profile 干净 |
| 恢复用户环境 | ✅ 扩展 0.2.1 重新安装；插件不安装；状态目录不存在 |

## 3. 质量门（最终）

| 项 | 结果 |
|---|---|
| 单元/集成测试 | **86 / 86** |
| `tsc` / `check:boundaries` | 通过 |
| 插件 bundle | 68,368 bytes |
| 扩展 VSIX | `deepseek-pre-edit-review-0.2.1.vsix`（9 文件，约 107 KB） |
| 扩展自检 | 27 / 27 |

## 4. 已知限制 / 未完成

1. **没有第二台干净机器**：清单在本机按顺序执行（卸载→重装→使用→卸载），跨机器/跨用户尚未实测。
2. **打包版 Desktop 无 `dsh` CLI**：`install-plugin.sh` 无法全自动安装，只负责"安全前置 + 精确指引"；有 CLI 的环境可一键完成。
3. VSIX 未签名、未发布 Marketplace（`publisher` 为 `The-4leepy`，`vsce` 不接受下划线）。
4. Windows/Linux 未验证；Git Worktree 隔离（ADR 0001 预留）未实现。
5. 扩展自检/部分 UI 行为（徽标、放行状态、标题栏按钮）仍需人工目视。

## 5. 项目最终状态

- 8 条验收测试全部通过（见 [m4-status.md](m4-status.md) §3）。
- 安全边界：工具级（明确不防 shell）/ 严格只读（OS 沙箱，唯一强保证）/ 放行（用户主动，会话级）。
- 代码与文档入口：根 [README.md](../README.md)、[CHANGELOG.md](../CHANGELOG.md)。

### 后续可选工作（不在本期范围）

- Git Worktree 隔离实现（`GitWorktreeTarget` 已预留接口）。
- Windows/Linux 适配与验证（Seatbelt → Landlock/ACL 差异）。
- Marketplace 发布与自动化 CI（当前只有本地脚本与单测）。
- 多文件批处理增强（同一轮多文件一次性展示，需读取会话日志）。
