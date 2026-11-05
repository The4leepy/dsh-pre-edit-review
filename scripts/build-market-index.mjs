#!/usr/bin/env node
/**
 * Regenerate market/index.json (DSH plugin-market format 1) from the plugin
 * package manifest. Run after every npm release.
 *
 * Usage: node scripts/build-market-index.mjs [--publish-timestamp <unixSeconds>]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const timestampIndex = args.indexOf('--publish-timestamp')
const publishTimestamp =
  timestampIndex === -1 ? Math.floor(Date.now() / 1000) : Number(args[timestampIndex + 1])

if (!Number.isInteger(publishTimestamp) || publishTimestamp <= 0) {
  console.error('publish timestamp must be a positive integer (Unix seconds)')
  process.exit(1)
}

const plugin = JSON.parse(readFileSync('packages/dsh-plugin/package.json', 'utf8'))
const repo = 'https://github.com/The4leepy/dsh-pre-edit-review'

const index = {
  format: 1,
  title: { en: 'DeepSeek Pre-edit Review', 'zh-cn': 'DeepSeek 修改前审阅' },
  description: {
    en: 'Unofficial plugin index: review agent file changes as an editable diff before they are written.',
    'zh-cn': '非官方插件索引：Agent 改文件前先进入可编辑 diff 审批。',
  },
  metadata: {
    categories: {
      safety: { title: { en: 'Safety', 'zh-cn': '安全' } },
      review: { title: { en: 'Code review', 'zh-cn': '代码审阅' } },
    },
    labels: { 'pre-edit': { title: { en: 'Pre-edit approval', 'zh-cn': '修改前审批' } } },
  },
  plugins: [
    {
      name: plugin.name,
      title: { en: 'Pre-edit Review for DeepSeek Harness', 'zh-cn': 'DeepSeek 修改前审阅' },
      description: {
        en: 'Intercept agent file writes, stage them, and only commit after the user accepts an editable diff in VS Code. Ships the DSH Host plugin; pair it with the The4leepy.deepseek-pre-edit-review VS Code extension.',
        'zh-cn':
          '拦截 Agent 的文件写入，暂存后交由用户在 VS Code 的可编辑 diff 中审批；接受后才写入。需配合 The4leepy.deepseek-pre-edit-review 扩展使用。',
      },
      author: 'The4leepy',
      homepage: `${repo}#readme`,
      repository: { url: repo },
      icon: `${repo.replace('github.com', 'raw.githubusercontent.com')}/main/packages/vscode-extension/media/icon.png`,
      metadata: {
        category: 'safety',
        keywords: ['deepseek', 'deepseek-harness', 'dsh', 'dsh-plugin', 'code-review', 'diff', 'agent', 'approval', 'safety'],
        labels: ['pre-edit'],
      },
      versions: [
        {
          version: plugin.version,
          publishTimestamp,
          source: { type: 'npm' },
          engines: { dsh: plugin.engines?.dsh ?? '>=0.2.1-rc.5 <0.3.0' },
        },
      ],
    },
  ],
}

writeFileSync('market/index.json', `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`market index written for ${plugin.name}@${plugin.version} (publishTimestamp=${publishTimestamp})`)
