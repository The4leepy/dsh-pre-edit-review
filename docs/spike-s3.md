# S3 Spike 报告 — 严格模式（只读沙箱 + 受控提交）验证

- 日期：2026-11-05
- 环境：DSH Desktop 0.2.1-rc.5 / macOS arm64 / profile `desktop`
- 探针：同 S1（`dpr-spike-probe`），通过自带工具 `spike_probe` 在真实 Host 进程内执行检查
- 结论：**通过（PASS）**。`read-only` per-call policy 同时作用于 `ctx.fs` 与 OS 级 bash 沙箱；`workspace-write` 显式策略可写；CAS 版本校验按预期拒绝陈旧提交。**严格模式所需的三个强制隔离基元全部可用。**

## 0. 能力事实

```json
{ "shellSandboxMode": "workspace-write", "fsSandboxMode": "workspace-write",
  "hasSandboxPolicy": true, "hasShell": true }
```

`ctx.fs.sandboxMode === ctx.shell.sandboxMode === "workspace-write"` ⇒ 该 profile 同时挂载了
`dsh-fs-sandbox`（文件写 fence）与 `dsh-bash-sandbox`（OS 执行世界限制）。

## 1. 六项检查（全部通过）

| # | 检查 | policy | 期望 | 实际 |
|---|---|---|---|---|
| 1 | `ctx.fs.writeText` 新建文件 | `read-only` | 拒绝 `FS_SANDBOX_DENIED` | `file access denied under read-only mode` ✔ |
| 2 | `ctx.fs.writeText` 新建文件 | `workspace-write` | 允许 | 允许，返回 60 字符版本令牌 ✔ |
| 3 | `ctx.fs.writeText` 带陈旧版本 | `workspace-write` + `replaceIfVersion(stale)` | 拒绝 `FS_STALE_VERSION` | `file changed since it was read` ✔ |
| 4 | `ctx.fs.writeText` 对已存在文件 `createIfAbsent` | `workspace-write` | 拒绝 `FS_NOT_OBSERVED` | `cannot overwrite existing ... without reading it first` ✔ |
| 5 | bash `printf ... > file` | `read-only` | 拒绝写入 | `bash: ...: Operation not permitted`，exit 1，`sandbox:{mode:"read-only",denied:true,enforcement:"full"}`，文件不存在 ✔ |
| 6 | bash `printf ... > file` | `workspace-write` | 允许写入 | exit 0，`denied:false`，文件存在 ✔ |

原始证据：`docs/evidence/spike-s1-s3-plugin-evidence.jsonl` 中 `event:"s3-checks"` 一条。

## 2. 结论与设计影响

1. **严格模式的强制隔离成立**：`read-only` 不是"少给几个工具"，而是 OS 层（Seatbelt）拒绝 bash 写入 + fs provider 拒绝 `ctx.fs` 写入。plan.md §5「不能只拦截 write/edit」在此模式下被真正满足。
2. **受控提交路径成立**：提交服务可以用显式 per-call `{ mode:'workspace-write', workspaceRoot }` 写盘，而 Agent 的会话策略仍保持 `read-only` ⇒ "Agent 不能写、审批后能写"无需提升整个会话权限。
3. **CAS 提交成立**：`replaceIfVersion` 对审批期间的外部修改返回 `FS_STALE_VERSION`，天然满足 plan.md 测试 4；`createIfAbsent` 覆盖"审批时新建、提交时已存在"的竞态。
4. 提交失败必须转成结构化冲突错误并**不重试覆盖**（Phase 2 实现）。

## 3. 未验证 / 已知限制

1. 本检查用**显式 per-call policy** 复现严格模式两个方向，**未把本会话整体切到 `read-only` 预设**（避免开发自锁）。计划在 Phase 4 的 E2E 中用可丢弃会话做一次完整的 `/permission read-only` 验证。
2. `enforcement: "full"` 仅在 macOS Seatbelt 后端实测；Windows/Linux 未验证（计划外）。
3. read-only 模式下构建/测试/安装命令会失败，这是严格模式的产品代价，已写进方案与文档。

## 4. 复现

```bash
node packages/spikes/probe/build.mjs
# plugin_manager install_bundle target=<abs>/packages/spikes/probe
# 调用 spike_probe action=shell-mode / action=s3-checks
# plugin_manager remove_bundle target=dpr-spike-probe
```
