# 接口冻结（M1）— DeepSeek Pre-edit Review

> Phase 1.5 出口物。以下接口一旦冻结，Phase 2+ 的实现必须实现它们而不是重新设计。
> 代码位置：`packages/shared/src/*.ts`（被 Host 插件与 VS Code 扩展在构建期内联，不产生运行时依赖）。

## 1. 依赖方向（强制）

```
                     ┌──────────────────────────────┐
                     │ packages/shared (纯类型/纯函数) │
                     └──────────────┬───────────────┘
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
 ToolClassifier              StagingStore                  protocol v1
 ProposalBuilder              ReviewCoordinator             (IPC)
        │                           │                            │
        └──────────► CommitTarget ◄──┘                            │
                          │                                      │
              DirectWorkspaceTarget / GitWorktreeTarget(stub)     │
                                                                  ▼
                                                        VS Code Extension
```

规则（CI 用 `scripts/check-boundaries.mjs` 守护）：
- `packages/vscode-extension/**` 不得 import `packages/dsh-plugin/**` 或任何 `targets/*`。
- `packages/dsh-plugin/src/staging/**` 与 `src/ipc/**` 不得 import `src/targets/**`；只允许 import `@dpr/shared` 的类型。
- 协议消息只携带 `targetKind` 元数据，不携带任何 target 句柄。

## 2. 已冻结的接口

| 接口 | 文件 | 状态 |
|---|---|---|
| `CommitTarget` / `FileSnapshot` / `CommitPrecondition` / `CommitResult` / `CommitConflict` | `packages/shared/src/commit-target.ts` | 冻结 |
| `ReviewRecord` / `ReviewState` / 状态机 `canTransition` | `packages/shared/src/review-record.ts` | 冻结 |
| protocol v1：方法表、参数/结果类型、JSON-RPC 校验、NDJSON framing | `packages/shared/src/protocol.ts` | 冻结 |
| 文本语义 `applyLiteralEdit` / `detectLineEndings` / `restoreLineEndings` | `packages/shared/src/text.ts` | 冻结（与 dsh-fs-local 对齐，单测锁定） |
| sha256 / randomHex | `packages/shared/src/hash.ts` | 冻结 |

## 3. 关键不变量

1. **只有 `CommitTarget.commit` 可以写用户工作区。** 其它任何模块不得调用 `ctx.fs.writeText`（CI grep 守护）。
2. **未收到 `decision` 前不得提交。** `ReviewCoordinator` 只能由 IPC 的 `decision` 处理器触发提交。
3. **提交必须带 precondition。** 由 `FileSnapshot.version` 派生；禁止无条件写入。
4. **record 先落盘、后展示。** `StagingStore.create()` 成功后才发送 `review/request`。
5. **终态不可变。** 重复 decision 返回 `already-decided`，不重复提交。
6. **协议无提交方法。** 扩展只能对既有 `requestId` 做 accept/reject，无法让 Host 写任意文件。

## 4. Phase 2 实现清单（按本冻结接口）

- `src/host.ts`：`ctx` 服务的最小 duck-type 视图。
- `src/classifier.ts`：实现 `classify()`（见方案 §4.4）。
- `src/proposal.ts`：`write` / `edit` / `str_replace_editor` 的 proposed 全文计算；不可计算时返回 `passthrough`（交给真实工具产生原生错误）。
- `src/targets/direct-workspace.ts`：`prepare/commit/inspect`。
- `src/targets/git-worktree.ts`：抛 `NOT_IMPLEMENTED`，接口与工厂与 Direct 同形。
- `src/staging/store.ts`：记录持久化（`0600`）+ 状态机 + 启动对账。
- `src/ipc/server.ts`：UDS server、token/nonce 鉴权、心跳、断连取消。
- `src/review-coordinator.ts`：编排 gate → proposal → staging → IPC → commit。
- `src/gate.ts`：`tools/execute` prepend 监听器。
- `src/index.ts`：`apply(ctx, config)` 装配 + `/review` 命令 + systemPrompt 段落。
- `packages/vscode-extension/`：FileSystemProvider(`dpr:`) + `vscode.diff` + 决策按钮 + 队列/历史。

## 5. 尚未冻结（Phase 2 开始时确定，不阻塞）

- 插件 `Config` schema 字段名（本方案 §4.6 已给出草案）。
- staging 记录在磁盘上的文件名规则（`<requestId>.json`）。
- 审计 JSONL 的字段集。
- VS Code 扩展 command id 前缀（拟 `dpr.*`）。
