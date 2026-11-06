import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_STATE_DIR, expandHome, normalizeConfig } from '../packages/dsh-plugin/src/config.ts'

test('defaultActive defaults to false in the schema and in the shipped bundle', async () => {
  assert.equal(normalizeConfig({}).defaultActive, false)
  assert.equal(normalizeConfig({ defaultActive: false }).defaultActive, false)
  assert.equal(normalizeConfig({ defaultActive: true }).defaultActive, true)
  assert.throws(() => normalizeConfig({ defaultActive: 'off' }), /defaultActive must be a boolean/)

  const patch = await readFile(new URL('../packages/dsh-plugin/cordis.patch.yml', import.meta.url), 'utf8')
  const yaml = patch.replace(/^\s*#.*$/gm, '')
  assert.match(yaml, /enabled:\s*true/)
  assert.match(yaml, /mode:\s*review/)
  assert.match(yaml, /defaultActive:\s*false/)
})

test('socketPath is an optional explicit override, not a root default', () => {
  assert.equal(normalizeConfig({}).socketPath, undefined)
  assert.equal(normalizeConfig({ stateDir: '/tmp/dpr-state' }).socketPath, undefined)
  assert.equal(normalizeConfig({ socketPath: '' }).socketPath, undefined)
  assert.equal(normalizeConfig({ socketPath: '   ' }).socketPath, undefined)
  assert.equal(normalizeConfig({ socketPath: '/tmp/custom.sock' }).socketPath, '/tmp/custom.sock')
  assert.equal(normalizeConfig({ socketPath: '~/custom.sock' }).socketPath, join(homedir(), 'custom.sock'))
  assert.equal(
    normalizeConfig({ socketPath: 'relative/custom.sock' }).socketPath,
    expandHome('relative/custom.sock'),
  )
})

test('hostKey and hostLabel are trimmed, empty means unset', () => {
  assert.equal(normalizeConfig({}).hostKey, undefined)
  assert.equal(normalizeConfig({}).hostLabel, undefined)
  assert.equal(normalizeConfig({ hostKey: '  desktop  ' }).hostKey, 'desktop')
  assert.equal(normalizeConfig({ hostLabel: '  Desktop App  ' }).hostLabel, 'Desktop App')
  assert.equal(normalizeConfig({ hostKey: '   ' }).hostKey, undefined)
  assert.equal(normalizeConfig({ hostLabel: '' }).hostLabel, undefined)
  assert.throws(() => normalizeConfig({ hostKey: 42 }), /hostKey must be a string/)
})

test('stateDir keeps its default and expands ~', () => {
  assert.equal(normalizeConfig({}).stateDir, expandHome(DEFAULT_STATE_DIR))
  assert.equal(normalizeConfig({ stateDir: '/tmp/custom-state' }).stateDir, '/tmp/custom-state')
})

test('allowPause defaults to true and can be disabled (legacy allowBypass accepted)', () => {
  assert.equal(normalizeConfig({}).allowPause, true)
  assert.equal(normalizeConfig({ allowPause: false }).allowPause, false)
  assert.equal(normalizeConfig({ allowBypass: false }).allowPause, false)
})
