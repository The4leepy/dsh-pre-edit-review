# 安装与升级

> 适用：macOS + DSH 0.2.2-rc.1（其他版本需先跑 `scripts/doctor.sh` 与自检）。
> 架构：VS Code 扩展负责展示/编辑/审批；DSH Host 插件负责拦截与受控提交。
>
> **0.3.0 起每个 Host 有自己的命名空间**：`~/.dsh/pre-edit-review/hosts/<hostKey>/{ipc.sock,token}`，
> 因此 Desktop 与 TUI 两个 profile 可以同时安装、同时连接 VS Code，互不抢锁。

## 0. 前置条件

- DSH 0.2.2-rc.1（或满足插件 `engines.dsh` 的版本）已安装并能正常启动会话；
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

- 有 `dsh` CLI：脚本直接执行 `dsh plugin --profile <profile> add <repo>/packages/dsh-plugin`。
- 也可以直接从发布包安装（**0.3.0 未发布时请用列表里的"本地克隆"方式**，发布后再用注册表版本号）：
  - `plugin_manager install_bundle target=dsh-pre-edit-review@0.3.0`
  - DSH 索引：`https://raw.githubusercontent.com/The4leepy/dsh-pre-edit-review/main/market/index.json`
  - GitHub Release 的 `dsh-pre-edit-review-*.tgz`
  - 本地克隆：`plugin_manager install_bundle target=<repo>/packages/dsh-plugin`
- 没有 `dsh` CLI 时：脚本会 arm kill switch 并打印手动步骤（Web GUI → Plugins 安装本地 bundle，或在会话里执行 `plugin_manager install_bundle target=<绝对路径>`）。
- 安装后建议重启 DSH（或等待 HMR 生效）。
- **同时给 Desktop 和 TUI 装**：各自 profile 各装一次即可；两者的 Host 会各写自己的
  `hosts/<profile>/`，扩展会同时连接。

### 2.1 解除 kill switch（确认无误后）

```bash
scripts/doctor.sh                         # 期望：plugin registered / 每个 host 的 socket+token / extension installed
rm ~/.dsh/pre-edit-review/DISABLED        # 解除急停
```

> kill switch 存在期间所有审批被旁路，**不要长期保留**。
> 解除急停 **不等于** 开始审查：0.3.0 安装默认是"未启用"，需要在会话里 `/review on`
> 才对该会话生效（见 [usage.md](usage.md)）。

## 3. 升级

> **0.3.0 的升级顺序：先升扩展，再升插件**（或两者一起）。旧扩展只认根目录
> `ipc.sock`，无法连接 0.3.0 Host 的 `hosts/<key>/` 命名空间。

```bash
scripts/install-extension.sh --build      # 1) 扩展
scripts/install-plugin.sh                 # 2) 插件（会重新 arm kill switch，确认后手动解除）
```

- 插件版本不兼容时 `plugin_manager` 会拒绝安装并给出 `engines.dsh` 提示；
- 升级后跑一次 `scripts/doctor.sh` 与扩展自检（命令面板：`Pre-edit Review: Run Self-test`）；
- 旧的根目录 `ipc.sock` / `token` 会在 0.3.0 Host 首次启动时**自动清理**（仅当没有 0.2.x Host
  仍在运行时）；旧的 `staging/` / `audit/` 不再被读取，可手动删除（`scripts/uninstall.sh --purge` 也会清掉）。

## 4. 卸载

```bash
scripts/uninstall.sh                      # 移除扩展 + 插件注册（保留状态目录）
scripts/uninstall.sh --purge             # 连同 hosts/、staging/、audit/、token、socket 一起删除
```

- 没有 `dsh` CLI 时，脚本会打印 Web GUI / `plugin_manager` 的移除方式；
- `--purge` 会删除审计与暂存数据，不可恢复；
- 两个 profile 都要删时，对每个 profile 各跑一次（`--profile <name>`）。

## 5. 干净机器验收清单

在一台没有安装过本项目的机器上，按以下顺序逐项确认：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | `pnpm install && pnpm run check` | typecheck / boundaries / 单测全部通过 |
| 2 | `scripts/install-extension.sh --build` | 扩展安装成功，`code --list-extensions` 可见 |
| 3 | 打开 VS Code 窗口（工作区随意） | 活动栏出现 **Pre-edit Review**，状态栏出现盾牌项 |
| 4 | `scripts/install-plugin.sh` | kill switch 已 arm；按提示完成插件注册 |
| 5 | 重启 DSH，开一个新会话 | `/review status` 显示该 Host 的 key、`install default: inactive` |
| 6 | `scripts/doctor.sh` | 无失败项；kill switch 提示为 WARN；能看到 `hosts/<key>/` |
| 7 | 解除 kill switch；先不 `/review on`，让 Agent 改文件 | **不弹审批、直接写入**（默认未启用） |
| 8 | `/review on`，再让 Agent 改一个文件 | VS Code 弹出可编辑 diff；Accept 后文件才变化 |
| 9 | 再让 Agent 改一个文件并 Reject | 原文件不变，Agent 收到拒绝 |
| 10 | `/review strict` 后让 Agent 用 bash 写文件 | 被 OS 沙箱拒绝（`Operation not permitted`） |
| 11 | `/review off` 后让 Agent 直接改文件 | 不再弹审批；状态栏显示 `· 未启用`；`/review on` 恢复 |
| 12 | 同时启动 Desktop 与 TUI 两个 profile | 状态栏显示两个 Host 均已连接；各自会话独立审查 |
| 13 | 退出 VS Code 后让 Agent 改文件（已启用会话） | fail-closed，文件不变，错误提示打开 VS Code |
| 14 | `scripts/uninstall.sh --purge` | 扩展与插件移除、状态目录清空、profile 无残留 |

> 第 3/6/8/11/12 步涉及 VS Code 界面与用户命令，无法完全自动化，需人工目视。

## 6. 目录与文件

| 路径 | 用途 |
|---|---|
| `~/.dsh/profiles/<profile>/package.json` | profile 插件清单（`dsh.profile.bundles`） |
| `~/.dsh/profiles/<profile>/node_modules/dsh-pre-edit-review` | 插件包（npm 安装或本地 link） |
| `~/.dsh/pre-edit-review/DISABLED` | 全局急停开关 |
| `~/.dsh/pre-edit-review/hosts/<hostKey>/meta.json` | Host 发现描述（pid/版本/路径，0600，不含 token） |
| `~/.dsh/pre-edit-review/hosts/<hostKey>/ipc.sock` | 该 Host 与扩展的 UDS（0600） |
| `~/.dsh/pre-edit-review/hosts/<hostKey>/token` | 该 Host 的 IPC 鉴权 token（0600，每次启动重新生成） |
| `~/.dsh/pre-edit-review/hosts/<hostKey>/staging/` | 待审批记录（0600） |
| `~/.dsh/pre-edit-review/hosts/<hostKey>/audit/*.jsonl` | 审计日志（0600，只含路径/事件/哈希） |
