# S1 Spike 报告 — `tools/execute` 短路（修改前拦截）验证

- 日期：2026-11-05
- 环境：DSH Desktop 0.2.1-rc.5 / macOS arm64 / profile `desktop`
- 探针：`packages/spikes/probe`（`dpr-spike-probe@0.0.1`，通过 `plugin_manager install_bundle` 安装到 profile，验证后已卸载）
- 结论：**通过（PASS）**。`tools/execute` waterfall 可以拦截真实 `write` 调用、不执行工具 body、自行写盘，并向 registry 返回合成的成功结果；registry 用 write 工具的 output schema 校验并正常渲染，模型侧看到普通成功。

## 1. 假设

| # | 假设 | 结果 |
|---|---|---|
| H1 | profile 可安装第三方 bundle 并即时生效 | ✅ `application: applied`，无需重启 |
| H2 | `tools/execute` 的 prepend 监听器可以不调用 `next()` 直接返回 `ToolExecutionResult` | ✅ 工具 body 未执行（文件内容被替换为探针写入的内容） |
| H3 | 合成成功值会通过该工具 output schema 校验并被正常 `render` | ✅ 无 schema 错误，模型看到 `Created file` |
| H4 | 探针自行 `ctx.fs.writeText` + `ctx.emit('fs/observed')` 后，Agent 后续对同一文件的 `edit` 不报 stale | ✅ 后续 `edit` 成功 |
| H5 | 只拦截命中路径，其余写入正常透传 | ✅ 工作区根部写入内容与 Agent 提交一致 |
| H6 | 路径判定用 realpath/`targetKey` 前缀匹配可靠 | ✅ `.spike/` 内命中、根目录文件不命中 |

## 2. 方法

1. 探针注册 `ctx.on('tools/execute', handler, { prepend: true })`。
   命中条件：`exec.name === 'write'` 且 `ctx.fs.resolve(args.file_path).targetKey` 落在 `<workspace>/.spike/` 下。
2. 命中时：
   - `ctx.fs.stat(target)` 取版本；
   - `ctx.fs.writeText(target, "S1-SHORT-CIRCUIT-OK\n", { kind: 'replaceIfVersion' | 'createIfAbsent' }, exec.signal, { mode: 'workspace-write', workspaceRoot })`；
   - `ctx.emit('fs/observed', target, { kind: 'present', version }, exec)`；
   - 返回 `{ isError: false, value: { path, operation, before, after } }`（write 工具的 output schema 要求）。
3. Agent 调用 `write` 写入 `.spike/s1-target.txt`，内容为 `AGENT-ORIGINAL-CONTENT`（23 字节）。
4. 观察：工具结果、磁盘内容、探针证据、后续 `edit` 行为、非命中路径写入。

## 3. 证据

探针证据文件：`docs/evidence/spike-s1-s3-plugin-evidence.jsonl`

```json
{"event":"s1-short-circuit","toolName":"write","callId":"call_01_uw1ViOPzQJQLORB827aZ4755",
 "requestedPath":"/Users/.../.spike/s1-target.txt","agentContentLength":23,
 "synthetic":{"path":"/Users/.../.spike/s1-target.txt","operation":"create","before":null,
              "after":"S1-SHORT-CIRCUIT-OK\n"},"outcomeOperation":"create"}
```

| 检查项 | 期望 | 实际 |
|---|---|---|
| 工具结果 | 正常成功（无 schema/registry 错误） | `Created file` |
| `.spike/s1-target.txt` 内容 | 探针内容 | `S1-SHORT-CIRCUIT-OK` ✔（**不是** `AGENT-ORIGINAL-CONTENT`） |
| 证据记录 | 1 条命中记录 | ✔ |
| `.spike-passthrough.txt`（根目录） | 透传，内容为 Agent 原文 | `PASSTHROUGH-CONTENT-OK` ✔ |
| 命中记录数量 | 只有 1 条（透传写入不产出证据） | 3 条总计：mounted/ready/s1-short-circuit ✔ |
| read → edit 同一文件 | 成功（证明 `fs/observed` 版本回填正确） | 成功改为 `S1-FOLLOW-UP-EDIT-OK` ✔ |

## 4. 结论与设计影响

- **方案 E 的核心机制成立**：不需要改写 `exec.arguments`（官方不支持），靠 `tools/execute` 短路即可让"用户编辑后的内容"落盘。
- 合成成功值必须符合目标工具的 output schema；`write` = `{ path, operation, before, after }`，`edit` = `{ path, before, after }`，`str_replace_editor` = `string`。
- **必须补发 `fs/observed`**，否则后续 `edit`/`write` 会因版本过期失败（本 spike 已证明不补会坏、补了正常）。
- 监听器顺序用 `{ prepend: true }`：保证在其他 wrapper（如 timeout policy）之前拿到调用。

## 5. 未验证 / 已知限制

1. **PTC 模式内嵌调用**未验证：当前 `desktop` profile 为 native 模式（工具逐个暴露），`run_code` 未启用。计划在 Phase 2 加一个 PTC 用例。
2. 探针只拦截了 `write`；`edit` 的提案计算属 Phase 2（S1 只证机制，不证全部工具）。
3. 探针把工具结果 `content` 交给 registry 用工具自己的 render 生成（无法自定义文案）；若需要告知模型"用户修改了提案"，改用 `tools/post-execute` 追加 content（Phase 2 实现，已列入接口）。
4. 本 spike 安装在用户 profile 上，属计划内行为（假设 4）；验证后已 `remove_bundle`，profile 恢复无该 bundle（`package.json`/`cordis.patch.yml`/`node_modules` 均已清理）。

## 6. 复现步骤

```bash
# 1. 构建探针
node packages/spikes/probe/build.mjs
# 2. 安装（需 approval；本次环境 plugin_manager）
#    plugin_manager install_bundle target=/abs/path/packages/spikes/probe
# 3. 让 Agent 调用 write 写 <workspace>/.spike/s1-target.txt
# 4. 读取 .spike/plugin-evidence.jsonl 与文件内容
# 5. 调用 spike_probe action=s1-report 获取证据
# 6. 卸载
#    plugin_manager remove_bundle target=dpr-spike-probe
```
