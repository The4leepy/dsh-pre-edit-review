# M1 验收 — Phase 1.5（技术验证 + 接口冻结）

- 日期：2026-11-05
- 状态：**M1 达成**。三个 spike 全部通过；接口冻结并落成代码；30 个单元测试通过；`tsc` 与依赖方向检查通过。

## 1. Spike 结果

| Spike | 结论 | 报告 | 原始证据 |
|---|---|---|---|
| S1 `tools/execute` 短路（修改前拦截） | **PASS** | [spike-s1.md](spike-s1.md) | [evidence/spike-s1-s3-plugin-evidence.jsonl](evidence/spike-s1-s3-plugin-evidence.jsonl) |
| S2 VS Code 可编辑 diff | **PASS** | [spike-s2.md](spike-s2.md) | [evidence/spike-s2-report.json](evidence/spike-s2-report.json) |
| S3 严格模式（只读沙箱 + CAS 提交） | **PASS**（6/6 检查） | [spike-s3.md](spike-s3.md) | 同上 jsonl 的 `s3-checks` |

关键结论：

1. **方案可以落地**：`tools/execute` 短路 + 合成成功值 + `ctx.fs` CAS 提交 + VS Code 可编辑 diff，四段全部实测通过。
2. **严格模式有强制隔离**：`read-only` 策略同时作用于 `ctx.fs`（`FS_SANDBOX_DENIED`）与 bash（Seatbelt：`Operation not permitted`，`enforcement: "full"`），而显式 `workspace-write` 提交可写。
3. **右侧可编辑已被证明**：`WorkspaceEdit` 生效 → 文档变脏 → `save()` 回调 provider `writeFile` 并收到用户最终内容；左侧原文件未被触碰。

## 2. 接口冻结产物

- [interface-freeze.md](interface-freeze.md)：依赖方向、已冻结接口、6 条不变量、Phase 2 实现清单。
- [ADR 0001 — CommitTarget](adr/0001-commit-target.md)：`DirectWorkspaceTarget` 已实现并单测；`GitWorktreeTarget` 预留（同接口、抛 `NOT_IMPLEMENTED`）。
- 代码：
  - `packages/shared/src/{protocol,commit-target,review-record,text,hash}.ts`
  - `packages/dsh-plugin/src/{host,config,classifier,proposal,gate,review-coordinator,index}.ts`
  - `packages/dsh-plugin/src/targets/{direct-workspace,git-worktree,index}.ts`
  - `packages/dsh-plugin/src/staging/store.ts`、`src/ipc/server.ts`
  - `scripts/check-boundaries.mjs`（依赖方向守护）

## 3. 质量门

```
pnpm run typecheck      ✅ clean
pnpm run check:boundaries ✅ ok
pnpm run test           ✅ 30 tests / 0 fail
pnpm run build:plugin   ✅ dist/index.mjs (3.5 kb)
```

单测覆盖：文本语义（含 CRLF/多匹配/replaceAll）、proposal 生成（write/edit/透传/拒绝/超限）、classifier（白名单/diff 启发式/异常 presentCall/正则/未知策略/关闭态）、`DirectWorkspaceTarget`（越界、CRLF 快照、新建、提交策略与观察事件、CAS 失败不写、inspect 只读）。

## 4. 偏差与未验证项（如实）

| 项 | 说明 |
|---|---|
| publisher | `vsce` 要求 `^[a-z0-9][a-z0-9-]*$/i`，`The_4leepy` 含下划线无法打包。实际使用 **`The-4leepy`**（扩展 ID `The-4leepy.deepseek-pre-edit-review`）。若必须用下划线，需要改打包链路或改 publisher。 |
| PTC 内嵌调用 | 未验证（当前 profile 为 native 模式）。Phase 2 增加用例。 |
| 严格模式整会话 E2E | 用显式 per-call policy 证明了两方向，未把开发会话整体切 `read-only`（避免自锁）。Phase 4 用可丢弃会话做完整验证。 |
| Windows/Linux | 未验证；设计不假设 Seatbelt。 |
| 插件骨架行为 | `index.ts` 目前**只挂载不拦截**（gate 在 Phase 2 接入），避免半成品进入真实写入路径。 |

## 5. 环境改动记录（可回滚）

1. 安装并卸载探针 bundle `dpr-spike-probe`（profile `desktop` 已恢复：`package.json`/`cordis.patch.yml`/`node_modules` 均无该条目，遗留软链已手工清理）。
2. 安装并卸载自检扩展 `the-4leepy.deepseek-pre-edit-review`（VS Code 已无该扩展）。
3. 打开了一个 VS Code 窗口（`code -n <workspace>`）用于 S2 自检；未改动用户已有窗口。
4. 会话权限被用户切到 `danger-full-access`（审批 `never`）；本报告中的"显式 per-call 只读策略"验证不依赖该设置。

## 6. Phase 2（M2）下一步

1. `ReviewCoordinator.review()` 全链路：workspaceRoot → `CommitTarget.prepare` → `buildProposal` → `StagingStore.create` → `IpcServer.request` → 决策 → `commit`/失败结果。
2. `installGate()` 接入 `index.ts`；`/review status|on|off` 命令；systemPrompt 段落；`tools/post-execute` 用户编辑附注。
3. VS Code 扩展从自检骨架升级为真实客户端：UDS client、`dpr:` provider（多请求）、Accept/Reject 按钮、断线重连、队列与历史、`writeFile` 只作内容同步。
4. E2E：plan.md 测试 1/2/3/4/7/8（工具级模式）。
