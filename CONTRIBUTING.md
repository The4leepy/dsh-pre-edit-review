# Contributing

This is a personal project with a deliberate single-maintainer model:

- **The contributor list must stay exactly one person: [@The4leepy](https://github.com/The4leepy).**
  External pull requests are not merged (that would add authors/contributors). Issues and bug reports
  with reproductions are welcome.
- Security issues: see [SECURITY.md](SECURITY.md), do not open a public issue.

If you want to build on this project, please fork it instead of contributing changes upstream.

## Development notes

```bash
pnpm install
pnpm run check   # typecheck + boundaries + tests
pnpm run build
```

- The plugin is a DSH profile bundle: `packages/dsh-plugin` (npm package + `cordis.patch.yml`).
- The extension is a local VSIX: `packages/vscode-extension`.
- Never install the plugin into your dev profile without arming the kill switch first; see
  [docs/install.md](docs/install.md).
