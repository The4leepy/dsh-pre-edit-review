# ADR 0001 — CommitTarget 抽象与 Git Worktree 预留

- 状态：Accepted（Phase 1.5 / M1）
- 关联：方案 §4.1、用户要求 7/8/9

## 背景

系统的安全边界是：Agent 在审批前不能改用户工作区；审批后由**受控提交服务**写入。
写入目标可能是：

1. 当前的直接工作区（本期实现）；
2. 未来的独立 Git worktree（Agent 在其中自由写，审批后合并回原 checkout）。

UI、IPC、协议、StagingStore 不应因目标变化而重写，因此引入 `CommitTarget`。

## 决策

1. 定义 `CommitTarget`（`packages/shared/src/commit-target.ts`）：
   - `prepare(host, requestedPath, signal): Promise<FileSnapshot>` —— 只读，解析根 + 读快照；
   - `commit(host, snapshot, finalContent, precondition, signal): Promise<CommitResult>` —— 原子写，precondition 失败必须抛；
   - `inspect(host, snapshot, signal): Promise<ReconcileVerdict>` —— 崩溃对账只读比较。
2. 本期实现 `DirectWorkspaceTarget`：
   - `prepare`：`ctx.fs.resolve(path, {cwd})` → `ctx.fs.contains(rootTarget, target)` 校验，越界抛 `CommitConflict('OUT_OF_SCOPE')`；`stat → readText → stat` 保证版本与内容一致；返回 `FileSnapshot`。
   - `commit`：`ctx.fs.writeText(target, finalContent, precondition, signal, {mode:'workspace-write', workspaceRoot})`；成功后 `ctx.emit('fs/observed', ...)`；`FS_STALE_VERSION`/`FS_NOT_OBSERVED`/`FS_SANDBOX_DENIED` 映射为 `CommitConflict`，**绝不重试覆盖**。
   - 行尾：`FileSnapshot.lineEndings` 记录原文件风格；提交前由 coordinator 用 `restoreLineEndings` 恢复。
3. `GitWorktreeTarget` 预留：同接口、同工厂，方法抛 `NOT_IMPLEMENTED`。
4. 依赖方向：`protocol` / `staging` / `vscode-extension` 不 import `targets/*`。
5. **切换方式（未来）**：
   - Agent cwd 通过 `ctx.worktrees.create(agent)` 切到 worktree（DSH 已有 `create_worktree` 工具/服务）；
   - `prepare` 的 `absolutePath` 指向原 checkout，`FileSnapshot.version` 改由 worktree 内文件计算；
   - `commit` 不再直接写原 checkout，而是"写 worktree + 生成 patch/合并到原 checkout"；
   - 协议只需新增/透传 `targetKind: 'git-worktree'`，扩展 UI 不变。
6. 本期不做 worktree 生命周期（创建/清理/分支管理）。

## 后果

- 优点：UI/IPC/Staging 与写入解耦；未来切换只需新增 target 实现。
- 代价：`FileSnapshot` 需要同时容纳"展示内容"与"目标版本"，`DirectWorkspaceTarget` 额外做包含校验。
- 风险：worktree 模式下 `displayPath/absolutePath` 的语义（worktree 路径 vs 原路径）需要在实现时明确并补 ADR 0002。

## 守护

`scripts/check-boundaries.mjs` 检查：
- `packages/vscode-extension/src/**` 不含 `dsh-plugin` / `targets/`；
- `packages/dsh-plugin/src/staging/**`、`src/ipc/**` 不含 `targets/`；
- 插件源码中除 `targets/*.ts` 外不出现 `ctx.fs.writeText` 调用。
