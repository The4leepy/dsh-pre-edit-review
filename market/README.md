# DeepSeek Pre-edit Review — plugin index

A [format-1](https://github.com/DeepSeek-Harness) DSH plugin-market index for
`dsh-pre-edit-review`. Add this URL in DSH (Discover / plugin index settings):

```
https://raw.githubusercontent.com/The4leepy/dsh-pre-edit-review/main/market/index.json
```

The index is generated from `packages/dsh-plugin/package.json`; regenerate after every npm release
(`node scripts/build-market-index.mjs`). Validate with `node scripts/check-market-index.mjs market/index.json`.
