import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOSTS_DIR_NAME, isHostDescriptor, isHostKey, sanitizeHostKey } from '../packages/shared/src/host.ts'

test('HOSTS_DIR_NAME is the documented directory name', () => {
  assert.equal(HOSTS_DIR_NAME, 'hosts')
})

test('isHostKey accepts file-name-safe slugs only', () => {
  assert.equal(isHostKey('desktop'), true)
  assert.equal(isHostKey('dsh-tui'), true)
  assert.equal(isHostKey('a.b_c-1'), true)
  assert.equal(isHostKey('.'), false)
  assert.equal(isHostKey('..'), false)
  assert.equal(isHostKey(''), false)
  assert.equal(isHostKey('with/slash'), false)
  assert.equal(isHostKey('../escape'), false)
  assert.equal(isHostKey('has space'), false)
  assert.equal(isHostKey('x'.repeat(65)), false)
  assert.equal(isHostKey(42), false)
  assert.equal(isHostKey(undefined), false)
})

test('sanitizeHostKey normalises arbitrary labels into a safe key', () => {
  assert.equal(sanitizeHostKey('desktop'), 'desktop')
  assert.equal(sanitizeHostKey('DSH TUI'), 'DSH_TUI')
  assert.equal(sanitizeHostKey('../etc/passwd'), 'etc_passwd')
  assert.equal(sanitizeHostKey('   '), 'default')
  assert.equal(sanitizeHostKey(''), 'default')
  assert.equal(sanitizeHostKey(undefined), 'default')
  assert.equal(sanitizeHostKey(null), 'default')
  assert.equal(sanitizeHostKey('-leading'), 'leading')
  assert.equal(sanitizeHostKey('..'), 'default')
  assert.equal(sanitizeHostKey('.'), 'default')
  assert.equal(sanitizeHostKey('x'.repeat(80)), 'x'.repeat(64))
})

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'desktop',
    label: 'desktop',
    pid: 1234,
    pluginVersion: '0.3.0',
    startedAt: 1_700_000_000_000,
    stateDir: '/Users/me/.dsh/pre-edit-review/hosts/desktop',
    socketPath: '/Users/me/.dsh/pre-edit-review/hosts/desktop/ipc.sock',
    tokenPath: '/Users/me/.dsh/pre-edit-review/hosts/desktop/token',
    ...overrides,
  }
}

test('isHostDescriptor accepts a well-formed descriptor', () => {
  assert.equal(isHostDescriptor(descriptor()), true)
})

test('isHostDescriptor rejects malformed or unsafe descriptors', () => {
  assert.equal(isHostDescriptor(null), false)
  assert.equal(isHostDescriptor({}), false)
  assert.equal(isHostDescriptor(descriptor({ key: '../escape' })), false)
  assert.equal(isHostDescriptor(descriptor({ label: '' })), false)
  assert.equal(isHostDescriptor(descriptor({ pid: 0 })), false)
  assert.equal(isHostDescriptor(descriptor({ pid: '1234' })), false)
  assert.equal(isHostDescriptor(descriptor({ stateDir: 'relative/dir' })), false)
  assert.equal(isHostDescriptor(descriptor({ socketPath: 'ipc.sock' })), false)
  assert.equal(isHostDescriptor(descriptor({ tokenPath: undefined })), false)
  assert.equal(isHostDescriptor(descriptor({ instanceId: 'abc123' })), true)
  assert.equal(isHostDescriptor(descriptor({ instanceId: 42 })), false)
  assert.equal(isHostDescriptor(descriptor({ startedAt: Number.NaN })), false)
})
