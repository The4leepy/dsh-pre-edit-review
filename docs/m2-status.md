# M2 验收 — Phase 2（MVP 全链路 + VS Code 客户端）

- 日期：2026-11-05
- 状态：**M2 达成**。Host 全链路（拦截→提案→暂存→IPC→决策→CAS 提交）与 VS Code 客户端均已实现并通过验证；plan.md 测试 1/2/3/4/7/8 通过。
- 事故说明：本次安装曾因缺少 `inject` 导致 profile 工具全挂，已修复并新增三重防线，详见 §5。

## 1. 交付物

### Host 插件（`packages/dsh-plugin`）

| 模块 | 内容 |
|---|---|
| `index.ts` | 挂载 gate / `/review` 命令 / systemPrompt 段落 / post-execute 通知；**`export const inject = ['fs','tools']`**；挂载自检 `checkHostCapabilities()`（能力缺失时只记日志、不装 gate） |
| `gate.ts` | `tools/execute` prepend 拦截；kill switch；安全定义查找（registry 异常不会拖垮非写工具）；分类异常时仅对写工具 fail-closed |
| `review-coordinator.ts` | 全链路：cwd→prepare→proposal→staging→等待客户端→IPC 决策→CAS 提交→合成结果；拒绝/超时/断连/冲突全部 fail-closed |
| `ipc/server.ts` | UDS + NDJSON JSON-RPC；token 鉴权；决策在应答内完成（扩展能拿到真实提交结果）；超时/断连取消；EADDRINUSE 区分"崩溃残留"与"另一实例在听" |
| `kill-switch.ts` | `~/.dsh/pre-edit-review/DISABLED` 文件热生效（1s 缓存），存在即全量放行 |
| `staging/store.ts` | 0600 原子写；状态机；崩溃对账（pending→expired，绝不重放提交）；审计 JSONL |
| `commands.ts`（内嵌） | `/review`、`/review on|off|strict|balanced` |
| 构造 | 无任何 `@deepseek-ai/*` 运行时依赖，esbuild 单文件 54.7 KB |

### VS Code 扩展（`packages/vscode-extension`）

- `ipc-client.ts`：token 重试、`hello`、3s 退避重连、decision RPC、通知处理。
- `review-session.ts`：pending 队列；`dpr:` 可编辑 diff（含新文件空左栏）；Accept/Reject/ShowPending/AcceptAll；断开清理；AUTO-ACCEPT 状态。
- `fs-provider.ts`：可写内存 provider（不设 `isReadonly`）；`writeFile` 只做内容同步，绝不作为同意信号。
- `i18n.ts`：中/英双语（按 `vscode.env.language`）。
- `extension.ts`：6 个命令 + 快捷键（`ctrl+alt+enter` accept / `ctrl+alt+backspace` reject）+ 状态栏。
- `self-test.ts`：进程内 mock Host 自检（真实 `IpcClient` + 真实 diff + 命令调用）。
- 产物：`deepseek-pre-edit-review-0.1.0.vsix`（约 81 KB，publisher `The-4leepy`）。

## 2. 验证结果

### 2.1 单元/集成测试（59 passed / 0 failed）

| 测试文件 | 覆盖 |
|---|---|
| `test/text.test.ts` | 行尾归一/恢复、字面替换语义（与 `dsh-fs-local` 对齐） |
| `test/proposal.test.ts` | write/edit 提案、CRLF、透传、拒绝、超限 |
| `test/classifier.test.ts` | 白名单、diff 启发式、抛异常 presentCall、正则、未知策略 |
| `test/direct-workspace.test.ts` | 越界、CRLF 快照、新建、提交策略、CAS 失败不写、inspect 只读 |
| `test/staging.test.ts` | 0600、状态机、崩溃过期、审计不含内容 |
| `test/coordinator-helpers.test.ts` | 路径参数映射、合成成功值、语言提示 |
| `test/ipc.test.ts` | 握手/错误 token/无客户端/超时/重复决策/断连（真实 UDS） |
| `test/coordinator.test.ts` | accept/reject/编辑/冲突/无客户端/透传（真实 store + FakeHost） |
| `test/gate.test.ts` | kill switch、review 短路、coordinator 异常 fail-closed、registry 异常不锁死其他工具、挂载自检 |

### 2.2 VS Code 扩展自检（真实 VS Code 1.145.0，18/18 PASS）

证据：`docs/evidence/ext-selftest.json`

关键步骤：mock Host 握手 → `review/request` → 打开 `dpr:` diff → 语言识别 typescript → `WorkspaceEdit` 插入 → `dpr.accept` → mock 收到含编辑内容的 decision（nonce 匹配）→ provider `writeFile` 收到最终 46 字符 → diff 标签关闭；第二个请求（新文件）走 reject，左栏为空 `dpr:` 文档，目标文件从未创建。

### 2.3 Host 全链路 E2E（真实插件 + 假客户端，6/6 PASS）

证据：`docs/evidence/m2/`（客户端回执 + 汇总 + 审计）

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | 无客户端 | `expired`，返回错误，文件未创建 | `no-client` staging 记录 |
| 2 | accept（write 新建） | `committed`，文件=Agent 内容，工具返回成功 | `s2-accept.json` |
| 3 | accept-edited（edit） | `committed`，文件=用户版本；模型收到"用户改过提案"通知 | `s3-accept-edited.json` |
| 4 | reject | `rejected`，文件保持 ORIGINAL，错误含用户理由 | `s4-reject.json` |
| 5 | 审批期间外部修改 | `conflict`（FS_STALE_VERSION），外部内容保留、未覆盖 | `s5-conflict.json` |
| 6 | 重复 Accept | 第一次 `committed`，第二次 `already-decided`，只写一次 | `s6-double.json` |

staging 最终状态：`committed ×3 / rejected ×1 / conflict ×1 / expired ×1`；审计只含 path/事件/哈希，不含内容。

### 2.4 Kill switch 验证

插件挂载 + `DISABLED` 文件存在时，`write` 完全不被拦截（内容为 Agent 原文、无 staging 记录）；删除文件后立即恢复审批。这是本次事故后的标准安装流程：**先 arm kill switch 再安装**。

## 3. 与 plan.md 验收测试对照

| # | 测试 | 状态 |
|---|---|---|
| 1 | 普通文件修改：原文件不变 + 弹出审批 | ✅（扩展自检 + Host E2E） |
| 2 | 编辑 Proposed：写入用户最终版本 | ✅（E2E #3 + 扩展自检） |
| 3 | Reject：原文件 SHA-256 不变 | ✅（E2E #4） |
| 4 | 审批期间文件变化：Accept 失败 | ✅（E2E #5） |
| 5 | Bash 写入不能绕过 | ⏳ Phase 4（严格模式整会话 E2E；机制已在 S3 证明） |
| 6 | 多文件：独立/全部审批 | ⏳ Phase 3（当前串行队列，扩展已支持多 pending） |
| 7 | 客户端断开：无未批准写入 | ✅（单测断连 + E2E #1 的 fail-closed） |
| 8 | 重复提交：只提交一次 | ✅（E2E #6） |

## 4. 未验证 / 已知限制

1. **真实扩展 ↔ 真实插件的同一会话联调**未做：两侧分别用协议一致的 mock 验证（扩展对 mock Host、插件对假客户端）。需要一次人工点击演示（见 §6）。
2. `/review` 命令已注册（挂载日志确认），但未通过真实命令通道执行过。
3. 自动接受（AcceptAll）只在扩展 mock 中验证，未与真实插件串测。
4. 仅 macOS；Windows/Linux 未验证。
5. 扩展重连/多窗口/关闭标签页的 UI 行为在真实窗口中只覆盖了自检路径。

## 5. 事故复盘（2026-11-05，profile 自锁）

- **现象**：安装插件后，该 profile 的所有工具调用报 `cannot get property "tools" without inject`，包括 bash/提问/plugin_manager，无法自救。
- **根因**：`index.ts` 漏了 `export const inject = ['fs','tools']`；gate 监听器第一行 `ctx.tools.get(...)` 抛错 → `tools/execute` waterfall 整体失败 → 每个工具返错。
- **恢复**：用户通过 Web GUI Plugins 页面关闭 bundle（UI 走 Service，不经过工具层）。
- **修复**：
  1. `export const inject = ['fs','tools']`；
  2. 挂载前 `checkHostCapabilities()` 自检，能力缺失则**不安装 gate**（插件惰性，只记日志）；
  3. gate 内定义查找 try/catch，registry 异常时仍按名称/策略判断 ⇒ 非写工具（bash）永远可走，保住恢复通道；
  4. `DISABLED` 文件 kill switch（1s 生效）；
  5. 新增 `test/gate.test.ts`（10 个用例）覆盖上述路径，安装前先 arm kill switch。
- **教训**：任何会挂到 `tools/execute` 的插件，必须先证明"最坏情况下不拖垮工具层"，再装进真实 profile。

## 6. 人工联调演示（待用户执行，约 1 分钟）

```bash
# 1) 装插件（保持 VS Code 关闭）
#    DSH 会话里：plugin_manager install_bundle target=<repo>/packages/dsh-plugin
# 2) 打开装了扩展的 VS Code 并保持窗口
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" /Users/wuyizhang/code/save_vs_code_pre-edit_review
# 3) 让我（Agent）改一个文件，VS Code 会弹出可编辑 diff：
#    点 Accept（或先改右栏再 Accept）→ 文件落盘；点 Reject → 文件不变
```

## 7. 环境现状

- `desktop` profile：**已卸载** `dsh-pre-edit-review`（`package.json`/`cordis.patch.yml`/`node_modules` 均无残留），工具调用正常。
- `~/.dsh/pre-edit-review` 状态目录已删除（无残留 staging 内容）。
- VS Code：扩展仍安装（`The-4leepy.deepseek-pre-edit-review`），VS Code 当前未运行。
- 两个 teammate（`vscode-spike`、`vscode-client`）已完成并停止。

## 8. Phase 3（M3）下一步

1. 多文件：待办/历史 TreeView、批量 Accept All（窗口式预授权）、逐文件状态。
2. `str_replace_editor` 提案支持（view/create/str_replace/insert）。
3. 真实联调后的 UI 打磨（关闭/回滚/脏文档提示、语法高亮细节、i18n 文案）。
4. 审批历史持久化（workspaceState）与 `/review history`。
