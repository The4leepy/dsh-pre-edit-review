# 发布指南（GitHub / npm / VS Code Marketplace / DSH 插件索引）

> 目标：把本仓库发布为 **@The4leepy** 的公开项目，并让 DSH 用户能安装。
> 本仓库的贡献者必须只有仓库拥有者一人；发布前请确认提交作者已被统一改写（见 §1.3）。

## 1. GitHub

### 1.1 一次性准备

```bash
git remote add origin git@github.com:The4leepy/dsh-pre-edit-review.git
git branch -M main
```

### 1.2 推送

```bash
git push -u origin main
```

- 仓库公开后，README / README.en.md / LICENSE / SECURITY.md / CONTRIBUTING.md / CI 会自动生效。
- `.github/workflows/ci.yml` 会在 push 与 PR 时运行 `pnpm check` 与构建。
- 建议开启分支保护（只允许 owner 合并）、开启 Dependabot（可选）。

### 1.3 贡献者只有 owner

GitHub 的 Contributors 列表来自提交作者/共同作者。本仓库的提交必须只包含 `The4leepy`：

```bash
git config user.name  The4leepy
git config user.email The4leepy@users.noreply.github.com
# 已存在的历史提交已在发布前改写为上述身份；可用以下命令核对：
git log --format='%an <%ae>' | sort -u
```

- 不要在提交里使用 `Co-authored-by:`（会新增贡献者）。
- 不要合并外部 PR（外部作者的提交会进入 Contributors）。[CONTRIBUTING.md](../CONTRIBUTING.md) 已说明。

### 1.4 Release

```bash
git tag -a v0.2.5 -m "extension 0.2.5 / plugin 0.2.1"
git push origin v0.2.5
```

在 GitHub Release 里附上：

- `packages/vscode-extension/deepseek-pre-edit-review-<version>.vsix`
- 说明安装方式（见 [install.md](install.md)）

## 2. npm（DSH 插件分发包）

插件包名：`dsh-pre-edit-review`（无 scope，公开）。

```bash
cd packages/dsh-plugin
npm publish --dry-run          # 检查打包内容
npm publish --access public    # 需要先 npm login（账号 The4leepy）
npm view dsh-pre-edit-review versions
```

要求：

- `package.json` 不含 `private`，含 `repository`/`license`/`files`（本仓库已配置）；
- 插件无运行时依赖（当前成立：`@deepseek-ai/*` 只做类型引用，bundle 单文件）；
- `engines.dsh` 决定兼容的 DSH 版本；当前为 `>=0.2.1-rc.5 <0.3.0`。

## 3. VS Code Marketplace

```bash
cd packages/vscode-extension
npx @vscode/vsce login The4leepy     # 需要 Azure DevOps PAT（Marketplace 权限）
npx @vscode/vsce publish             # 使用 package.json 版本号（当前 0.2.5）
```

一次性要求：

- 在 <https://marketplace.visualstudio.com/manage> 创建 publisher **The4leepy**（与 package.json 一致）；
- `publisher`、`icon`（128×128 PNG）、`repository`、`license`、`README`、`CHANGELOG` 齐备（本仓库已配置）；
- 首次发布后扩展 ID 为 `The4leepy.deepseek-pre-edit-review`。
- 如不想走 Marketplace，也可只上传 VSIX 到 GitHub Release，用户手动 `code --install-extension`。

> 注意：当前 `engines.vscode` 为 `^1.145.0`；如果希望支持更低的 VS Code 版本，需要先在对应版本上验证再放宽。

## 4. DSH 插件索引（可选，但推荐）

DSH 的插件市场是**用户可配置的 format-1 JSON index**，没有官方投稿入口；第三方通过 npm / 自建索引 / 社区市场分发。

### 4.1 本仓库自带的索引

`market/index.json` 已按 format 1 生成，发布到 GitHub 后，用户可把下面的 URL 加进 DSH 的插件索引：

```
https://raw.githubusercontent.com/The4leepy/dsh-pre-edit-review/main/market/index.json
```

- 索引字段：`format`、`title`（必须含 `en`）、`plugins[].name/versions[].version/publishTimestamp/source/engines`；
- 版本条目在 npm 发布后更新 `publishTimestamp` 与 `version`；
- 本地校验：`node scripts/check-market-index.mjs market/index.json`（仓库内提供，规则与 DSH 校验器对齐）。

### 4.2 社区市场（各自有提交方式，按对应仓库说明操作）

- <https://github.com/Aily-DSH/dsh-plugin-index>
- <https://github.com/REALOIYO/dsh-plugin-market>
- <https://github.com/ysr666/DSH-Store>
- <https://dshbase.com/plugins/dsh-hub-workshop/>
- <https://awesome-dsh-plugin.com/zh/p/loguhan/dsh-workshop/>
- <https://plugin.dshx.dev/item/Zlyraz/dsh-workshop/>

也可以在 DSH 里直接安装，无需任何索引：

```text
plugin_manager install_bundle target=dsh-pre-edit-review@0.2.1
```

或（未发布 npm 时）：

```text
plugin_manager install_bundle target=<本地 packages/dsh-plugin 绝对路径>
```

## 5. 发布节奏建议

1. 先 `pnpm run check` + 构建 + 本地安装回归（见 [install.md](install.md) §5）；
2. 推 GitHub，打 tag；
3. `npm publish`（插件）；
4. `vsce publish`（扩展）或只发 Release 的 VSIX；
5. 更新 `market/index.json` 的版本与 `publishTimestamp`，推 GitHub；
6. 到社区市场提交收录。

## 6. 安全

- 不要把 npm token / Azure PAT / SSH 私钥写进仓库或日志；
- 发布前跑 `git grep -n "token\|PAT\|password"` 自查；
- 安全边界与漏洞报告见 [security.md](security.md) 与 [SECURITY.md](../SECURITY.md)。


## 7. 首次发布进度（2026-11-05）

| 渠道 | 状态 | 说明 |
|---|---|---|
| GitHub | ✅ 已发布 | <https://github.com/The4leepy/dsh-pre-edit-review>，`main` 分支、tag `v0.2.5`；Contributors 只有 The4leepy |
| DSH 索引（git 源） | ✅ 可用 | `market/index.json` 以 commit + `packages/dsh-plugin` 固定，用户添加 raw URL 即可安装 |
| npm | ⏳ 待登录 | 需要仓库所有者执行一次 `npm login`，然后 `cd packages/dsh-plugin && npm publish --access public`；发布后把 `market/index.json` 的 source 换回 npm（`node scripts/build-market-index.mjs`） |
| VS Code Marketplace | ⏳ 待 PAT | 需要 publisher `The4leepy` 的 Azure DevOps PAT：`npx @vscode/vsce login The4leepy` 后 `vsce publish`；或只把 VSIX 上传到 GitHub Release |
| GitHub Release（自动） | ✅ 已配置 | 推送 `v*` tag 时 `.github/workflows/release.yml` 自动构建并附加 VSIX + npm tarball |

> 以上两条需要账号凭据，Agent 不会代为登录或保存 token。


## 8. 首次发布结果（2026-11-05，最终）

| 渠道 | 状态 | 细节 |
|---|---|---|
| GitHub 仓库 | ✅ 已发布 | <https://github.com/The4leepy/dsh-pre-edit-review>；`main`；Contributors 仅 `The4leepy` |
| GitHub CI | ✅ 通过 | `CI` 工作流：install → typecheck/boundaries/tests → build |
| GitHub Release | ✅ 自动生成 | tag `v0.2.5` → Release 附带 `deepseek-pre-edit-review-0.2.5.vsix` 与 `dsh-pre-edit-review-0.2.1.tgz` |
| DSH 插件索引（git 源） | ✅ 已实测可装 | `market/index.json` 固定 commit + `path:/packages/dsh-plugin`；用 `plugin_manager install_bundle` 从该 git spec 安装并成功挂载 |
| npm | ⏳ 待账号登录 | 见下方命令；发布后把索引切回 npm 源 |
| VS Code Marketplace | ⏳ 待 PAT | 见下方命令 |

### 需要仓库所有者执行的两条命令

```bash
# 1) npm（包名已确认可用：dsh-pre-edit-review）
npm login                       # 账号 The4leepy
cd packages/dsh-plugin
npm publish --access public
# 发布成功后，回到仓库根目录把索引切到 npm 源并推送：
cd ../.. && node scripts/build-market-index.mjs && git add market/index.json && git commit -m "market: publish 0.2.1 to npm" && git push

# 2) VS Code Marketplace（先在 marketplace.visualstudio.com/manage 创建 publisher "The4leepy"）
npx @vscode/vsce login The4leepy   # 使用 Azure DevOps PAT（Marketplace: Manage 权限）
cd packages/vscode-extension && npx @vscode/vsce publish
```

### 用户的其他安装方式（不依赖 npm）

- GitHub Release 里的 `dsh-pre-edit-review-0.2.1.tgz`：`plugin_manager install_bundle target=<绝对路径>/dsh-pre-edit-review-0.2.1.tgz`
- DSH 索引 raw URL：`https://raw.githubusercontent.com/The4leepy/dsh-pre-edit-review/main/market/index.json`（git 源，当前可用）
- 本地克隆：`plugin_manager install_bundle target=<repo>/packages/dsh-plugin`
