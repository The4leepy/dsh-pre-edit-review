# 故障排查

先跑：

```bash
scripts/doctor.sh
```

它会检查扩展/插件是否安装、profile 清单、每个 Host 的状态目录权限、socket/token、
kill switch 状态、VS Code 是否在运行。
日志入口：VS Code `输出` 面板 → **DeepSeek Pre-edit Review**；插件日志在 DSH Host 日志中（含 `[pre-edit-review]` 前缀）。

---

## A. Agent 改文件时什么都没弹，直接写进去了

**0.3.0 起这是预期行为**：安装默认"未启用"，只有会话 `/review on` 之后才拦截。

| 原因 | 处理 |
|---|---|
| 该会话还没启用审查（默认） | 在会话里输入 `/review on`，再让 Agent 改 |
| 其它会话 `/review off` 了，但你问的是那个会话 | 那个会话是独立状态；在它里面 `/review on` |
| 子代理/队友会话 | 子代理是独立会话，需各自启用（已知限制） |
| `mode: off` 写死在 profile 配置 | `/review on` 会明确报错；改 profile 的 `cordis.patch.yml` |
| kill switch 存在 | `ls ~/.dsh/pre-edit-review/DISABLED`；确认后删除 |

## A2. Agent 改文件报错 "no review client is connected"（文件未修改）

**症状**：工具返回 `Pre-edit review needs VS Code ... no review client is connected`，文件未修改。

| 原因 | 处理 |
|---|---|
| VS Code 没开 | 打开 VS Code（扩展已装） |
| 扩展未激活/已禁用 | Reload Window；扩展面板确认 `The4leepy.deepseek-pre-edit-review` 已启用 |
| `dpr.autoConnect` 被关闭 | 设置里打开，或命令面板执行 `Pre-edit Review: Reconnect to Host` |
| Host 插件未运行（该 Host 无 socket） | 按 [install.md](install.md) 重新安装/启用插件；`scripts/doctor.sh` 看 `hosts/<key>/ipc.sock` |

Fail-closed 是设计行为：没有客户端时**不会**偷偷直接写。
注意：只有**该会话已 `/review on`** 时才会出现这个错误；未启用时写入不会进入审批。

## B. 状态栏一直显示离线 / 只连上部分 Host

```bash
ls -la ~/.dsh/pre-edit-review/hosts/            # 每个 Host 一个目录
ls -la ~/.dsh/pre-edit-review/hosts/<key>/      # 应有 ipc.sock、token、meta.json
cat ~/.dsh/pre-edit-review/hosts/<key>/meta.json # 看 pid / pluginVersion / 路径
```

- `hosts/` 为空：Host 插件没挂载（profile 未启用 / 安装失败 / DSH 未重启），或仍是 0.2.x 的旧布局（根目录 `ipc.sock`）。0.3.0 Host 启动时会自动清掉**已死**的旧根目录 socket/token，但不会动仍在运行的旧 Host。
- 有 socket 但连不上：Host 重启后旧 socket 残留。Host 启动会探测并清理；仍失败时删掉该 Host 的 socket 后重启 DSH：
  `rm ~/.dsh/pre-edit-review/hosts/<key>/ipc.sock`（下次启动会重建）。
- 只连上一个 Host：确认另一个 profile 也装了 0.3.0 插件并重启过；检查它的 `hosts/<other>/meta.json` 与进程是否活着（`ps -p <pid>`）。
- 扩展 `dpr.stateDir` 指向的不是根目录（应为 `~/.dsh/pre-edit-review`）。

## C. 扩展提示鉴权失败（AUTH_FAILED / invalid token）

- token 是**每个 Host 自己的**，每次该 Host 启动都会重新生成；扩展会自动重读并重连。
- 若持续失败：确认 `hosts/<key>/token` 存在且权限 0600（`meta.json` 只记录它的路径，不含 token 本身）；删除该 token 后重启 DSH（Host 会重新生成）。
- **同一 profile 的两个实例**：后启动的 Host 会报 `HOST_IN_USE`（不会覆盖 token）；应该只保留一个。不同 profile（Desktop/TUI）不会互相影响。
- 伪造/过期决策会被拒绝并保持请求 pending —— 这是预期的安全行为。

## D. **插件把工具调用全卡死了（自锁）**

最坏情况：插件自身缺陷导致每个工具调用都失败。恢复顺序（从轻到重）：

1. **创建急停开关**（若还能执行 bash）：
   `mkdir -p ~/.dsh/pre-edit-review && touch ~/.dsh/pre-edit-review/DISABLED`
   → 1 秒内**所有 Host** 旁路所有审批。
2. **Web GUI → Plugins** 里把 `dsh-pre-edit-review` 关掉/移除（UI 走 Service，不经过工具层，工具全挂时仍可用）。
3. 若无 UI/终端权限：重启 DSH 前，从 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 移除该项。
4. 恢复后运行 `scripts/doctor.sh`，再用 `scripts/install-plugin.sh` 重新安装（脚本会先 arm kill switch）。

> 历史事故：M2 首次安装因缺少 `inject` 声明导致工具全挂，根因与修复见 [m2-status.md](m2-status.md) §5。

## E. Accept 时提示冲突（conflict / FS_STALE_VERSION）

- 审批期间文件被其它程序（编辑器、git、构建）改过 —— 这是**正确行为**，不会覆盖。
- 处理：让 Agent 重新读取并重新提案；或先关闭/保存占用该文件的编辑器再试。
- 若你的编辑器里打开了同一个文件且有未保存修改，先保存再审批，避免内容来源混淆。

## F. 严格模式（read-only）下构建/测试/安装失败

- 这是严格模式的预期代价：OS 沙箱禁止一切写入（含缓存、node_modules）。
- 需要构建时切换：`/review balanced`（workspace-write），或临时 `/review off` 关闭本会话审查；
- 只读模式下仍可正常读取、运行只读命令与代码审查。
- 若严格模式下**未启用审查**就想改文件：沙箱会直接拒绝（不会走审批提交），先 `/review on`。

## G. 忘了开启 / 忘了关闭审查

- 默认是未启用：需要审查时在会话里 `/review on`；状态栏在没有任何活跃审查会话时显示 `· 未启用`。
- 关闭：`/review off`；`allowPause: false` 可禁止关闭。
- 启用/关闭都是内存态，Host 重启自动回到默认；每次切换都写审计（`review/activated` / `review/deactivated`）。

## G2. 5 秒提示没看清 / 想改回弹窗

- 临时消息在右下角状态栏显示 **5 秒**（`dpr.messageDurationMs` 可调 1–30 秒），内容同时写入输出面板 → **DeepSeek Pre-edit Review**。
- 想用原生通知：设置 `dpr.useNativeNotifications = true`；但 VS Code 原生通知的停留时间扩展无法控制（约 10 秒，且无法设为 5 秒）。
- 需要用户操作的确认框（Accept All / 清空历史）不受此设置影响。

## H. Pending/History 视图不见了

- 视图在活动栏的 **Pre-edit Review** 图标内；若被隐藏：命令面板 `View: Show Pre-edit Review`。
- 队列为空是正常的（即使连了多个 Host，模型也是串行派发）。
- 历史持久化在 VS Code `workspaceState`：换工作区看不到旧历史属预期；0.2.x 时代的历史条目没有 Host 字段，仍可读。

## I. 扩展自检失败

命令面板运行 `Pre-edit Review: Run Self-test`，报告写入 `<workspace>/.spike/ext-selftest.json`。
> 自动自检是**显式开启**的：只有工作区里存在 `.spike/auto-selftest` 文件时才会在激活后自动运行（仅凭 `.spike/` 目录不会触发，自检会打开多个 diff 编辑器）。
- 失败通常是 VS Code 版本过低（<1.145）或 `dpr:` FileSystemProvider 注册失败；检查输出面板报错。
- 自检不需要 Host 插件与真实审批（会在临时目录里起 mock Host）。

## J. 卸载不干净

```bash
scripts/uninstall.sh --purge
```

仍残留时手动检查：
- `~/.dsh/profiles/<profile>/package.json`（依赖与 `dsh.profile.bundles`）
- `~/.dsh/profiles/<profile>/node_modules/<plugin>`
- `~/.dsh/pre-edit-review/`（`hosts/`、旧的根目录 socket/token、staging/、audit/、DISABLED）
- `code --list-extensions | grep 4leepy`

## K. 两个 profile（Desktop + TUI）同时用

- 0.3.0 起这是**支持**的：每个 Host 有自己的 `hosts/<hostKey>/`，扩展同时连接。
- 若只有一边能连：确认两边插件都是 0.3.0（0.2.x 只写根目录，会与 0.3.0 的命名空间互不可见）；重启两边 DSH；`scripts/doctor.sh` 应列出两个 host。
- **同一个 profile** 开两个实例不支持：后启动者日志出现 `HOST_IN_USE`，它的会话写入不会进入审批（保持未启用状态即可正常工作）。
- 升级顺序：先升扩展（Marketplace/VSIX），再升两个 profile 的插件。
- 若你给插件配了显式的 `socketPath` 且不在 `~/.dsh/pre-edit-review/hosts/<hostKey>/` 内，扩展会拒绝该 Host（路径逃逸防护）；把它放回 host 目录即可。
