#!/usr/bin/env node
/**
 * Dependency-direction guard (ADR 0001 + docs/interface-freeze.md).
 *
 * Rules:
 * 1. The VS Code extension never imports the Host plugin or a CommitTarget.
 * 2. Staging and IPC never import a concrete CommitTarget.
 * 3. Only `packages/dsh-plugin/src/targets/**` may call `ctx.fs.writeText`.
 * 4. The protocol layer never imports a CommitTarget implementation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const failures = []

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      out.push(...walk(full))
    } else if (entry.endsWith('.ts') || entry.endsWith('.mjs') || entry.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

function scan(dir, check) {
  let files
  try {
    files = walk(join(root, dir))
  } catch {
    return
  }
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/')
    const text = readFileSync(file, 'utf8')
    const problem = check(rel, text)
    if (problem !== undefined) failures.push(`${rel}: ${problem}`)
  }
}

scan('packages/vscode-extension/src', (rel, text) => {
  if (/from\s+['"][^'"]*dsh-plugin/.test(text)) return 'VS Code extension must not import the Host plugin'
  if (/from\s+['"][^'"]*targets\//.test(text)) return 'VS Code extension must not import a CommitTarget'
  return undefined
})

for (const dir of ['packages/dsh-plugin/src/staging', 'packages/dsh-plugin/src/ipc']) {
  scan(dir, (rel, text) => {
    if (/from\s+['"][^'"]*targets\//.test(text)) return 'staging/IPC must not import a concrete CommitTarget'
    if (text.includes('ctx.fs.writeText')) return 'staging/IPC must not write files'
    return undefined
  })
}

scan('packages/dsh-plugin/src', (rel, text) => {
  if (rel.startsWith('packages/dsh-plugin/src/targets/')) return undefined
  if (text.includes('ctx.fs.writeText')) return 'only CommitTarget implementations may call ctx.fs.writeText'
  return undefined
})

scan('packages/shared/src', (rel, text) => {
  if (/from\s+['"][^'"]*targets\//.test(text)) return 'shared must not import a CommitTarget implementation'
  return undefined
})

if (failures.length > 0) {
  console.error('boundary violations:\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
console.log('boundaries ok')
