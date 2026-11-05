# 安装与升级

> 适用：macOS + DSH Desktop 0.2.1-rc.5（其他版本需先跑 `scripts/doctor.sh` 与自检）。
> 架构：VS Code 扩展负责展示/编辑/审批；DSH Host 插件负责拦截与受控提交；两者通过 `~/.dsh/pre-edit-review/ipc.sock` 通信。

## 0. 前置条件

- DSH Desktop 已安装并能正常启动会话；
- VS Code ≥ 1.145（扩展 `engines.vscode: ^1.145.0`）；
- 本仓库已构建：`pnpm install`（首次）→ `pnpm run build`；
- 可用 `scripts/doctor.sh` 随时体检。

## 1. 安装 VS Code 扩展（先装扩展）

```bash
scripts/install-extension.sh --build     # 构建 bundle + 打 VSIX + 安装
# 或使用已有包：
scripts/install-extension.sh
```

- 产物：`packages/vscode-extension/deepseek-pre-edit-review-<version>.vsix`（本地、未签名，用 `--force` 覆盖升级）。
- 安装后 **Reload Window** 一次，扩展才激活并连接 Host。

## 2. 安装 DSH Host 插件（关键安全顺序）

> **必须先把急停开关（kill switch）准备好，再安装插件。**
> 插件一旦挂载就位于全局工具流水线；如果第一次安装时它自身有问题，kill switch 能保证工具调用不被卡死。

```bash
scripts/install-plugin.sh                # 会先 arm kill switch，再安装
```

- 有 `dsh` CLI：脚本直接执行 `dsh plugin --profile desktop add <repo>/packages/dsh-plugin`。
- 打包版 Desktop 没有 `dsh` CLI 时：脚本会 arm kill switch 并打印手动步骤（Web GUI → Plugins 安装本地 bundle，或在会话里执行 `plugin_manager install_bundle target=<绝对路径>`）。
- 安装后建议重启 DSH Desktop（或等待 HMR 生效）。

### 2.1 解除 kill switch（确认无误后）

```bash
scripts/doctor.sh                         # 期望：plugin registered / IPC socket 存在 / extension installed
rm ~/.dsh/pre-edit-review/DISABLED        # 解除急停，审批开始生效
```

> kill switch 存在期间所有审批被旁路（等价放行），**不要长期保留**。

## 3. 升级

```bash
scripts/install-extension.sh --build      # 扩展
scripts/install-plugin.sh                 # 插件（会重新 arm kill switch，确认后手动解除）
```

- 插件版本不兼容时 `plugin_manager` 会拒绝安装并给出 `engines.dsh` 提示；
- 升级后跑一次 `scripts/doctor.sh` 与扩展自检（命令面板：`Pre-edit Review: Run Self-test`）。

## 4. 卸载

```bash
scripts/uninstall.sh                      # 移除扩展 + 插件注册（保留状态目录）
scripts/uninstall.sh --purge             # 连同 staging/audit/token/socket 一起删除
```

- 没有 `dsh` CLI 时，脚本会打印 Web GUI / `plugin_manager` 的移除方式；
- `--purge` 会删除审计与暂存数据，不可恢复。

## 5. 干净机器验收清单

在一台没有安装过本项目的机器上，按以下顺序逐项确认：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | `pnpm install && pnpm run check` | typecheck / boundaries / 单测全部通过 |
| 2 | `scripts/install-extension.sh --build` | 扩展安装成功，`code --list-extensions` 可见 |
| 3 | 打开 VS Code 窗口（工作区随意） | 活动栏出现 **Pre-edit Review**，状态栏出现盾牌项 |
| 4 | `scripts/install-plugin.sh` | kill switch 已 arm；按提示完成插件注册 |
| 5 | 重启 DSH，开一个新会话 | 会话里输入 `/review status` 能看到状态 |
| 6 | `scripts/doctor.sh` | 无失败项；kill switch 提示为 WARN |
| 7 | 解除 kill switch，让 Agent 改一个文件 | VS Code 弹出可编辑 diff；Accept 后文件才变化 |
| 8 | 再让 Agent 改一个文件并 Reject | 原文件不变，Agent 收到拒绝 |
| 9 | `/review strict` 后让 Agent 用 bash 写文件 | 被 OS 沙箱拒绝（`Operation not permitted`） |
| 10 | `/review bypass` 后让 Agent 直接改文件 | 不再弹审批；状态栏显示 `· 放行` |
| 11 | 退出 VS Code 后让 Agent 改文件 | fail-closed，文件不变，错误提示打开 VS Code |
| 12 | `scripts/uninstall.sh --purge` | 扩展与插件移除、状态目录清空、profile 无残留 |

> 第 3/6/10 步涉及 VS Code 界面与用户命令，无法完全自动化，需人工目视。

## 6. 目录与文件

| 路径 | 用途 |
|---|---|
| `~/.dsh/profiles/desktop/package.json` | profile 插件清单（`dsh.profile.bundles`） |
| `~/.dsh/profiles/desktop/node_modules/dsh-pre-edit-review` | 插件包软链（本地安装） |
| `~/.dsh/pre-edit-review/ipc.sock` | Host ↔ 扩展的 UDS（0600） |
| `~/.dsh/pre-edit-review/token` | IPC 鉴权 token（0600） |
| `~/.dsh/pre-edit-review/staging/` | 待审批记录（0600，Accept/Reject 后保留为历史） |
| `~/.dsh/pre-edit-review/audit/*.jsonl` | 审计日志（0600，只含路径/事件/哈希） |
| `~/.dsh/pre-edit-review/DISABLED` | 急停开关 |
