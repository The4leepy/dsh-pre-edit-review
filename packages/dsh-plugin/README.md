# dsh-pre-edit-review（DSH Host 插件）

拦截 Agent 的文件写入，把 proposed 内容交给 VS Code 审批，只有用户 Accept 后才通过 `CommitTarget` 写入。

## 安装

```bash
# 在 DSH 会话里：
# plugin_manager install_bundle target=<repo>/packages/dsh-plugin
# 或（CLI 可用时）：dsh plugin --profile desktop add <repo>/packages/dsh-plugin
```

安装后本 profile 的所有会话生效；VS Code 扩展需同时安装并通过 UDS 连接（见根 README）。

## 配置（`cordis.patch.yml` 条目 `pre-edit-review` 的 config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后所有调用直通 |
| `mode` | `review` | `review` / `off` |
| `reviewTools` | `["write","edit","str_replace_editor"]` | 进入审批的工具名 |
| `exemptTools` | `[]` | 永不审批的工具名 |
| `unknownToolPolicy` | `deny` | 未知但"像写入"的工具：拒绝还是暂停 |
| `mutationNamePatterns` | 一组正则 | 名字启发式（默认匹配 write/edit/create/delete/rename/…） |
| `approvalTimeoutMs` | `600000` | 审批超时（超时=拒绝，不写盘） |
| `maxFileBytes` | `2097152` | 超过则拒绝进入审批 |
| `fallback` | `deny` | 无 VS Code 客户端时：`deny` 或 `dsh-approval`（走 DSH 自身审批通道，不能编辑内容） |
| `clientConnectTimeoutMs` | `3000` | 等待客户端连接的时间 |
| `enableAutoAccept` / `autoAcceptMax` | `true` / `20` | 允许扩展侧"预授权窗口"自动接受 |
| `stateDir` | `~/.dsh/pre-edit-review` | staging/audit/token/socket 目录（日志与 socket 均为 0600） |
| `noticeOnUserEdit` | `true` | 用户改过提案时，在工具结果后追加提示让模型重新读取 |
| `allowPause` | `true` | 是否允许 `/review off` 暂停审批（会话级、仅用户可开） |

## 会话命令

| 命令 | 作用 |
|---|---|
| `/review` | 状态：开关、客户端连接、pending 数、当前文件策略 |
| `/review on` / `off` | 运行时开关（影响该 profile 的会话） |
| `/review strict` | 切到 `read-only` 会话策略（唯一不可绕过模式） |
| `/review balanced` | 切回 `workspace-write` |
| `/review history [n]` | 最近 n 条审批记录（默认 10，最多 50；只含路径/事件/哈希，无内容） |
| `/review off` / `/review off|on` | **暂停审批**：该会话的写操作直接执行、不再审批（用户主动开启；沙箱策略不变；内存态，重启复位；每次切换写审计）。`allowPause:false` 可禁用该命令 |

## 安全与失败语义

完整威胁模型与保证矩阵见 [docs/security.md](../../docs/security.md)。

- 任何异常、超时、取消、客户端断开、CAS 冲突 ⇒ **返回 `isError` 且不写盘**，绝不静默覆盖。
- 审批期间文件被外部修改 ⇒ `FS_STALE_VERSION` ⇒ 冲突错误，要求模型重新读取后重新提案。
- 提交使用 `replaceIfVersion` / `createIfAbsent`；写入是临时文件 + 原子 rename，保留文件权限。
- `str_replace_editor` 的 `view`、以及前置条件必然失败的调用（文件不存在/已存在、匹配不唯一、参数非法）会**直通**给真实工具，由工具产生其原生错误，不消耗审批。
- 只接受对既有 `requestId` 的决策；重复决策幂等丢弃（返回 `already-decided`）。
- 崩溃恢复：启动时把 pending 记录标记为 expired，不重放提交。
- 暂停审批只能由**用户在会话命令**里开启（Agent 无法通过任何工具/IPC 打开）；它只跳过审批，不改变沙箱：`read-only` 下仍然无法写文件。

## 开发

```bash
pnpm run build:plugin   # esbuild → dist/index.mjs（无运行时依赖）
pnpm run check          # typecheck + boundary guard + unit tests
```
