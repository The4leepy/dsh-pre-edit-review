# 故障排查

先跑：

```bash
scripts/doctor.sh
```

它会检查扩展/插件是否安装、profile 清单、状态目录权限、IPC socket/token、kill switch 状态、VS Code 是否在运行。
日志入口：VS Code `输出` 面板 → **DeepSeek Pre-edit Review**；插件日志在 DSH Host 日志中（含 `[pre-edit-review]` 前缀）。

---

## A. Agent 改文件时什么都没弹，直接报错

**症状**：工具返回 `Pre-edit review needs VS Code ... no review client is connected`，文件未修改。

| 原因 | 处理 |
|---|---|
| VS Code 没开 | 打开 VS Code（扩展已装） |
| 扩展未激活/已禁用 | Reload Window；扩展面板确认 `The-4leepy.deepseek-pre-edit-review` 已启用 |
| `dpr.autoConnect` 被关闭 | 设置里打开，或命令面板执行 `Pre-edit Review: Reconnect to Host` |
| Host 插件未运行（socket 不存在） | 按 [install.md](install.md) 重新安装/启用插件；`scripts/doctor.sh` 看 IPC socket |

Fail-closed 是设计行为：没有客户端时**不会**偷偷直接写。

## B. 状态栏一直显示离线

```bash
ls -la ~/.dsh/pre-edit-review/       # 应有 ipc.sock + token（0600）
```

- 没有 `ipc.sock`：Host 插件没挂载（profile 未启用 / 安装失败 / DSH 未重启）。
- 有 `ipc.sock` 但连不上：Host 重启后旧 socket 残留。插件启动会探测并清理；若仍失败，删除 DSH 后重启：
  `rm ~/.dsh/pre-edit-review/ipc.sock`（Host 下次启动会重建）。
- 扩展 `dpr.stateDir` 与插件 `stateDir` 不一致：改成同一个目录（默认 `~/.dsh/pre-edit-review`）。

## C. 扩展提示鉴权失败（AUTH_FAILED / invalid token）

- token 每次 Host 启动都会重新生成；扩展会自动重读并重连。
- 若持续失败：确认 `~/.dsh/pre-edit-review/token` 权限 0600 且与插件 stateDir 一致；删除该文件后重启 DSH（Host 会重新生成）。
- 伪造/过期决策会被拒绝并保持请求 pending —— 这是预期的安全行为。

## D. **插件把工具调用全卡死了（自锁）**

最坏情况：插件自身缺陷导致每个工具调用都失败。恢复顺序（从轻到重）：

1. **创建急停开关**（若还能执行 bash）：
   `mkdir -p ~/.dsh/pre-edit-review && touch ~/.dsh/pre-edit-review/DISABLED`
   → 1 秒内插件旁路所有审批。
2. **Web GUI → Plugins** 里把 `dsh-pre-edit-review` 关掉/移除（UI 走 Service，不经过工具层，工具全挂时仍可用）。
3. 若无 UI/终端权限：重启 DSH 前，从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 移除该项（或直接删除 `node_modules/dsh-pre-edit-review` 软链并按需操作）。
4. 恢复后运行 `scripts/doctor.sh`，再用 `scripts/install-plugin.sh` 重新安装（脚本会先 arm kill switch）。

> 历史事故：M2 首次安装因缺少 `inject` 声明导致工具全挂，根因与修复见 [m2-status.md](m2-status.md) §5。

## E. Accept 时提示冲突（conflict / FS_STALE_VERSION）

- 审批期间文件被其它程序（编辑器、git、构建）改过 —— 这是**正确行为**，不会覆盖。
- 处理：让 Agent 重新读取并重新提案；或先关闭/保存占用该文件的编辑器再试。
- 若你的编辑器里打开了同一个文件且有未保存修改，先保存再审批，避免内容来源混淆。

## F. 严格模式（read-only）下构建/测试/安装失败

- 这是严格模式的预期代价：OS 沙箱禁止一切写入（含缓存、node_modules）。
- 需要构建时切换：`/review balanced`（workspace-write）或临时放行 `/review bypass`；
- 只读模式下仍可正常读取、运行只读命令与代码审查。

## G. 放行模式忘记关闭

- 状态栏出现 `· 放行` 即表示有会话处于放行；输入 `/review bypass off` 关闭。
- 放行是内存态，Host 重启自动复位；`allowBypass:false` 可整体禁用该命令。

## H. Pending/History 视图不见了

- 视图在活动栏的 **Pre-edit Review** 图标内；若被隐藏：命令面板 `View: Show Pre-edit Review`。
- 队列为空是正常的（模型串行派发，通常只有 1 条 pending）。
- 历史持久化在 VS Code `workspaceState`：换工作区看不到旧历史属预期。

## I. 扩展自检失败

命令面板运行 `Pre-edit Review: Run Self-test`，报告写入 `<workspace>/.spike/ext-selftest.json`。
- 失败通常是 VS Code 版本过低（<1.145）或 `dpr:` FileSystemProvider 注册失败；检查输出面板报错。
- 自检不需要 Host 插件与真实审批。

## J. 卸载不干净

```bash
scripts/uninstall.sh --purge
```

仍残留时手动检查：
- `~/.dsh/profiles/<profile>/package.json`（依赖与 `dsh.profile.bundles`）
- `~/.dsh/profiles/<profile>/node_modules/<plugin>`
- `~/.dsh/pre-edit-review/`
- `code --list-extensions | grep 4leepy`
