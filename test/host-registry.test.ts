import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  LEGACY_HOST_KEY,
  discoverHostLinks,
  isProcessAlive,
} from '../packages/vscode-extension/src/host-registry.ts'

async function tempRoot(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dpr-host-registry-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

function descriptorFor(hostDir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: basename(hostDir),
    label: basename(hostDir),
    pid: process.pid,
    pluginVersion: '0.3.0',
    startedAt: 1_700_000_000_000,
    stateDir: hostDir,
    socketPath: join(hostDir, 'ipc.sock'),
    tokenPath: join(hostDir, 'token'),
    ...overrides,
  }
}

interface HostOptions {
  key?: string
  label?: string
  descriptor?: Record<string, unknown>
  writeSocket?: boolean
  writeToken?: boolean
  writeMeta?: boolean
}

async function createHost(root: string, directoryName: string, options: HostOptions = {}): Promise<string> {
  const hostDir = join(root, 'hosts', directoryName)
  await mkdir(hostDir, { recursive: true })
  if (options.writeSocket !== false) await writeFile(join(hostDir, 'ipc.sock'), '')
  if (options.writeToken !== false) await writeFile(join(hostDir, 'token'), 'a'.repeat(32))
  if (options.writeMeta !== false) {
    const descriptor = descriptorFor(hostDir, {
      ...(options.key !== undefined ? { key: options.key } : { key: directoryName }),
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...options.descriptor,
    })
    await writeFile(join(hostDir, 'meta.json'), JSON.stringify(descriptor))
  }
  return hostDir
}

/**
 * A descriptor may not route through a symlink that leaves the Host directory:
 * `resolve()` alone would accept it, so the discovery layer must canonicalize.
 */
async function createEscapingHost(root: string, directoryName: string, kind: 'socketPath' | 'tokenPath'): Promise<void> {
  const outsideDir = join(root, 'outside')
  await mkdir(outsideDir, { recursive: true })
  const outsideFile = join(outsideDir, kind === 'socketPath' ? 'ipc.sock' : 'token')
  await writeFile(outsideFile, kind === 'tokenPath' ? 'c'.repeat(32) : '')
  const hostDir = await createHost(root, directoryName)
  const linkPath = join(hostDir, kind === 'socketPath' ? 'socket-link' : 'token-link')
  await symlink(outsideFile, linkPath)
  const descriptor = descriptorFor(hostDir, { [kind]: linkPath })
  await writeFile(join(hostDir, 'meta.json'), JSON.stringify(descriptor))
}

async function createLegacyRoot(root: string): Promise<void> {
  await writeFile(join(root, 'ipc.sock'), '')
  await writeFile(join(root, 'token'), 'b'.repeat(32))
}

test('isProcessAlive treats ESRCH as dead and our own pid as alive', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(Number.NaN), false)
  assert.equal(isProcessAlive(1.5), false)
})

test('discovers two per-Host namespaces sorted by key', async (t) => {
  const root = await tempRoot(t)
  await createHost(root, 'zeta', { label: 'DSH TUI' })
  await createHost(root, 'alpha', { label: 'Desktop' })

  const links = await discoverHostLinks(root)
  assert.deepEqual(
    links.map((link) => link.key),
    ['alpha', 'zeta'],
  )
  const alpha = links[0]
  assert.ok(alpha !== undefined)
  assert.equal(alpha.legacy, false)
  assert.equal(alpha.label, 'Desktop')
  assert.equal(alpha.pid, process.pid)
  assert.equal(alpha.pluginVersion, '0.3.0')
  assert.equal(alpha.hostDir, join(root, 'hosts', 'alpha'))
  assert.equal(alpha.socketPath, join(root, 'hosts', 'alpha', 'ipc.sock'))
  assert.equal(alpha.tokenPath, join(root, 'hosts', 'alpha', 'token'))
  assert.equal(links[1]?.label, 'DSH TUI')
})

test('accepts the legacy root layout as host key legacy', async (t) => {
  const root = await tempRoot(t)
  await createLegacyRoot(root)

  const links = await discoverHostLinks(root)
  assert.equal(links.length, 1)
  const legacy = links[0]
  assert.ok(legacy !== undefined)
  assert.equal(legacy.key, LEGACY_HOST_KEY)
  assert.equal(legacy.legacy, true)
  assert.equal(legacy.label, LEGACY_HOST_KEY)
  assert.equal(legacy.hostDir, root)
  assert.equal(legacy.socketPath, join(root, 'ipc.sock'))
  assert.equal(legacy.tokenPath, join(root, 'token'))
})

test('legacy layout coexists with per-Host namespaces; the Host descriptor wins on a key clash', async (t) => {
  const root = await tempRoot(t)
  await createHost(root, 'alpha')
  await createHost(root, 'zeta')
  await createLegacyRoot(root)

  const keys = (await discoverHostLinks(root)).map((link) => link.key)
  assert.deepEqual(keys, ['alpha', LEGACY_HOST_KEY, 'zeta'])

  // A real per-Host namespace whose key happens to be "legacy" wins over the
  // root-layout link so the key stays unique.
  await createHost(root, 'legacy', { label: 'Real legacy profile' })
  const links = await discoverHostLinks(root)
  const legacyLinks = links.filter((link) => link.key === LEGACY_HOST_KEY)
  assert.equal(legacyLinks.length, 1)
  assert.equal(legacyLinks[0]?.legacy, false)
  assert.equal(legacyLinks[0]?.label, 'Real legacy profile')
})

test('legacy root layout requires both the socket and the token', async (t) => {
  const root = await tempRoot(t)
  await writeFile(join(root, 'ipc.sock'), '')
  assert.deepEqual(await discoverHostLinks(root), [])
  await writeFile(join(root, 'token'), 'c'.repeat(32))
  assert.equal((await discoverHostLinks(root)).length, 1)
})

test('rejects a descriptor whose socketPath escapes the host directory', async (t) => {
  const root = await tempRoot(t)
  await mkdir(join(root, 'outside'), { recursive: true })
  await writeFile(join(root, 'outside', 'ipc.sock'), '')
  await createHost(root, 'alpha', {
    descriptor: { socketPath: join(root, 'outside', 'ipc.sock') },
  })
  assert.deepEqual(await discoverHostLinks(root), [])
})

test('rejects a descriptor whose tokenPath escapes the host directory', async (t) => {
  const root = await tempRoot(t)
  await writeFile(join(root, 'token'), 'd'.repeat(32))
  await createHost(root, 'alpha', {
    descriptor: { tokenPath: join(root, 'token') },
  })
  assert.deepEqual(await discoverHostLinks(root), [])
})

test('rejects a descriptor whose paths use traversal segments', async (t) => {
  const root = await tempRoot(t)
  await writeFile(join(root, 'token'), 'e'.repeat(32))
  await createHost(root, 'alpha', {
    descriptor: { tokenPath: join(root, 'hosts', 'alpha', '..', '..', 'token') },
  })
  assert.deepEqual(await discoverHostLinks(root), [])
})

test('rejects an absolute path outside the state directory', async (t) => {
  const root = await tempRoot(t)
  await createHost(root, 'alpha', {
    descriptor: { socketPath: '/etc/passwd', tokenPath: '/etc/hosts' },
  })
  assert.deepEqual(await discoverHostLinks(root), [])
})

test('rejects a descriptor whose key differs from its directory name', async (t) => {
  const root = await tempRoot(t)
  await createHost(root, 'desktop', { key: 'other' })
  assert.deepEqual(await discoverHostLinks(root), [])
})

test('rejects a descriptor whose directory name is not a valid host key', async (t) => {
  const root = await tempRoot(t)
  await createHost(root, 'bad name', { key: 'bad name' })
  assert.deepEqual(await discoverHostLinks(root), [])
})

test('skips missing sockets and missing tokens', async (t) => {
  const root = await tempRoot(t)
  await createHost(root, 'no-token', { writeToken: false })
  await createHost(root, 'no-socket', { writeSocket: false })
  await createHost(root, 'ok')
  const links = await discoverHostLinks(root)
  assert.deepEqual(
    links.map((link) => link.key),
    ['ok'],
  )
})

test('skips malformed meta.json, missing meta.json, and non-directory entries', async (t) => {
  const root = await tempRoot(t)
  await createHost(root, 'bad-json', { writeMeta: false })
  await writeFile(join(root, 'hosts', 'bad-json', 'meta.json'), '{ not json')
  await createHost(root, 'no-meta', { writeMeta: false })
  await createHost(root, 'ok')
  await writeFile(join(root, 'hosts', 'stray-file'), 'not a host')
  const keys = (await discoverHostLinks(root)).map((link) => link.key)
  assert.deepEqual(keys, ['ok'])
})

test('prunes descriptors whose pid is not alive', async (t) => {
  const root = await tempRoot(t)
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  assert.ok(pid !== undefined)
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
  assert.equal(isProcessAlive(pid), false)

  await createHost(root, 'dead', { descriptor: { pid } })
  await createHost(root, 'alive')
  const keys = (await discoverHostLinks(root)).map((link) => link.key)
  assert.deepEqual(keys, ['alive'])
})

test('an empty or missing state directory discovers no Hosts', async (t) => {
  const root = await tempRoot(t)
  assert.deepEqual(await discoverHostLinks(root), [])
  assert.deepEqual(await discoverHostLinks(join(root, 'does-not-exist')), [])
})


test('rejects a descriptor whose socketPath is a symlink escaping the host directory', async (t) => {
  const root = await tempRoot(t)
  await createEscapingHost(root, 'alpha', 'socketPath')
  assert.deepEqual(await discoverHostLinks(root), [])
})

test('rejects a descriptor whose tokenPath is a symlink escaping the host directory', async (t) => {
  const root = await tempRoot(t)
  await createEscapingHost(root, 'alpha', 'tokenPath')
  assert.deepEqual(await discoverHostLinks(root), [])
})
