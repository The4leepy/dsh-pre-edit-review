import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import { resolveHostKey, resolveHostPaths } from '../packages/dsh-plugin/src/paths.ts'
import type { HostContext } from '../packages/dsh-plugin/src/host.ts'

function ctxWith(get: (name: string) => unknown): HostContext {
  return { get } as unknown as HostContext
}

function withEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env['DSH_PROFILE']
  if (value === undefined) delete process.env['DSH_PROFILE']
  else process.env['DSH_PROFILE'] = value
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env['DSH_PROFILE']
    else process.env['DSH_PROFILE'] = previous
  }
}

test('host key precedence: config → profileContext → DSH_PROFILE → default', () => {
  const config = normalizeConfig({ hostKey: 'from-config' })
  assert.equal(resolveHostKey(config, ctxWith(() => ({ name: 'from-profile' }))), 'from-config')

  const withoutConfig = normalizeConfig({})
  withEnv('from-env', () => {
    assert.equal(resolveHostKey(withoutConfig, ctxWith(() => ({ name: 'from-profile' }))), 'from-profile')
    assert.equal(resolveHostKey(withoutConfig, ctxWith(() => undefined)), 'from-env')
    assert.equal(resolveHostKey(withoutConfig), 'from-env')
    // An unset profile service falls through even when the lookup throws.
    const throwing = ctxWith(() => {
      throw new Error('cannot get property "profileContext" without inject')
    })
    assert.equal(resolveHostKey(withoutConfig, throwing), 'from-env')
  })
  withEnv(undefined, () => {
    assert.equal(resolveHostKey(withoutConfig, ctxWith(() => undefined)), 'default')
    assert.equal(resolveHostKey(withoutConfig), 'default')
  })
})

test('host keys are sanitized into file-name-safe slugs', () => {
  assert.equal(resolveHostKey(normalizeConfig({ hostKey: 'DSH TUI' })), 'DSH_TUI')
  // A path-like key can never escape the hosts directory.
  const escaped = resolveHostKey(normalizeConfig({ hostKey: '../etc/passwd' }))
  assert.match(escaped, /^[A-Za-z0-9._-]{1,64}$/)
  assert.equal(escaped.includes('/'), false)
  assert.notEqual(escaped, '..')
  assert.equal(resolveHostKey(normalizeConfig({}), ctxWith(() => ({ name: 'desktop' }))), 'desktop')
  withEnv('   ', () => {
    assert.equal(resolveHostKey(normalizeConfig({})), 'default')
  })
})

test('host paths follow the documented per-Host layout', () => {
  const root = '/tmp/dpr-root'
  const paths = resolveHostPaths(normalizeConfig({ stateDir: root, hostKey: 'desktop' }))
  assert.equal(paths.root, root)
  assert.equal(paths.hostKey, 'desktop')
  assert.equal(paths.hostLabel, 'desktop')
  assert.equal(paths.hostDir, `${root}/hosts/desktop`)
  assert.equal(paths.socketPath, `${root}/hosts/desktop/ipc.sock`)
  assert.equal(paths.tokenPath, `${root}/hosts/desktop/token`)
  assert.equal(paths.stagingDir, `${root}/hosts/desktop/staging`)
  assert.equal(paths.auditDir, `${root}/hosts/desktop/audit`)
  assert.equal(paths.metaPath, `${root}/hosts/desktop/meta.json`)
  // The kill switch is global, not per Host.
  assert.equal(paths.killSwitchPath, `${root}/DISABLED`)
})

test('hostLabel is display-only and defaults to the resolved host key', () => {
  const labelled = resolveHostPaths(normalizeConfig({ hostKey: 'desktop', hostLabel: 'Desktop App' }))
  assert.equal(labelled.hostKey, 'desktop')
  assert.equal(labelled.hostLabel, 'Desktop App')
  // A label is not sanitized: it never becomes a path segment.
  const spaced = resolveHostPaths(normalizeConfig({ hostKey: 'desktop', hostLabel: 'DSH Desktop (local)' }))
  assert.equal(spaced.hostLabel, 'DSH Desktop (local)')
  assert.equal(spaced.hostDir.endsWith('/hosts/desktop'), true)
})

test('an explicit socketPath overrides only the socket', () => {
  const paths = resolveHostPaths(
    normalizeConfig({ stateDir: '/tmp/dpr-root', hostKey: 'desktop', socketPath: '/tmp/expert/custom.sock' }),
  )
  assert.equal(paths.socketPath, '/tmp/expert/custom.sock')
  assert.equal(paths.tokenPath, '/tmp/dpr-root/hosts/desktop/token')
  assert.equal(paths.stagingDir, '/tmp/dpr-root/hosts/desktop/staging')
  assert.equal(paths.auditDir, '/tmp/dpr-root/hosts/desktop/audit')
})
