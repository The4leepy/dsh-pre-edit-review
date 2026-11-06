import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHostDescriptor, removeHostDescriptor, writeHostDescriptor } from '../packages/dsh-plugin/src/registry.ts'
import { isHostDescriptor, type HostDescriptor } from '../packages/shared/src/host.ts'

function descriptor(stateDir: string, overrides: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    key: 'desktop',
    label: 'Desktop App',
    pid: 4321,
    pluginVersion: '0.3.0',
    startedAt: 1_700_000_000_000,
    stateDir,
    socketPath: join(stateDir, 'ipc.sock'),
    tokenPath: join(stateDir, 'token'),
    ...overrides,
  }
}

async function tempHostDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dpr-registry-'))
  return join(root, 'hosts', 'desktop')
}

test('writeHostDescriptor publishes 0600 JSON that validates via the shared contract', async () => {
  const hostDir = await tempHostDir()
  const metaPath = join(hostDir, 'meta.json')
  await writeHostDescriptor(metaPath, descriptor(hostDir))

  const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf8'))
  assert.equal(isHostDescriptor(parsed), true)
  assert.equal((parsed as HostDescriptor).key, 'desktop')
  assert.equal((parsed as HostDescriptor).stateDir, hostDir)
  const info = await stat(metaPath)
  assert.equal(info.mode & 0o777, 0o600)
})

test('the descriptor write is atomic and leaves no temp files', async () => {
  const hostDir = await tempHostDir()
  const metaPath = join(hostDir, 'meta.json')
  await writeHostDescriptor(metaPath, descriptor(hostDir))
  await writeHostDescriptor(metaPath, descriptor(hostDir, { pid: 9999, startedAt: 1_700_000_100_000 }))

  const entries = await readdir(hostDir)
  assert.deepEqual(entries, ['meta.json'])
  const parsed = JSON.parse(await readFile(metaPath, 'utf8')) as HostDescriptor
  assert.equal(parsed.pid, 9999)
  assert.equal((await stat(metaPath)).mode & 0o777, 0o600)
})

test('an invalid descriptor is rejected and never written', async () => {
  const hostDir = await tempHostDir()
  const metaPath = join(hostDir, 'meta.json')
  await assert.rejects(
    () => writeHostDescriptor(metaPath, descriptor(hostDir, { pid: 0 })),
    /invalid HostDescriptor/,
  )
  await assert.rejects(
    () => writeHostDescriptor(metaPath, descriptor(hostDir, { key: '../escape' })),
    /invalid HostDescriptor/,
  )
  assert.deepEqual(await readdir(hostDir).catch(() => []), [])
})

test('removeHostDescriptor is ENOENT-tolerant', async () => {
  const hostDir = await tempHostDir()
  const metaPath = join(hostDir, 'meta.json')
  await writeHostDescriptor(metaPath, descriptor(hostDir))
  assert.equal(await removeHostDescriptor(metaPath), true)
  await assert.rejects(() => stat(metaPath), /ENOENT/)
  assert.equal(await removeHostDescriptor(metaPath), false)
})

test('ownership-checked removal never deletes a newer instance descriptor', async () => {
  const hostDir = await tempHostDir()
  const metaPath = join(hostDir, 'meta.json')
  const older = descriptor(hostDir, { pid: 1111, startedAt: 1_700_000_000_000 })
  const newer = descriptor(hostDir, { pid: 2222, startedAt: 1_700_000_500_000 })
  await writeHostDescriptor(metaPath, older)
  // Simulate HMR/restart overlap: the newer instance replaced the descriptor.
  await writeHostDescriptor(metaPath, newer)

  assert.equal(await removeHostDescriptor(metaPath, older), false)
  const stillThere = JSON.parse(await readFile(metaPath, 'utf8')) as HostDescriptor
  assert.equal(stillThere.pid, newer.pid)
  assert.equal(stillThere.startedAt, newer.startedAt)

  assert.equal(await removeHostDescriptor(metaPath, newer), true)
  await assert.rejects(() => stat(metaPath), /ENOENT/)
})

test('ownership-checked removal is a no-op when the descriptor is gone or malformed', async () => {
  const hostDir = await tempHostDir()
  const metaPath = join(hostDir, 'meta.json')
  const owner = descriptor(hostDir)
  assert.equal(await removeHostDescriptor(metaPath, owner), false)

  await mkdir(hostDir, { recursive: true })
  await writeFile(metaPath, '{not json', 'utf8')
  assert.equal(await removeHostDescriptor(metaPath, owner), false)
  assert.equal(await readFile(metaPath, 'utf8'), '{not json')
})

test('readHostDescriptor validates the on-disk descriptor', async () => {
  const hostDir = await tempHostDir()
  const metaPath = join(hostDir, 'meta.json')
  await writeHostDescriptor(metaPath, descriptor(hostDir))
  const parsed = await readHostDescriptor(metaPath)
  assert.equal(parsed?.key, 'desktop')
  await writeFile(metaPath, JSON.stringify({ key: 'desktop' }), 'utf8')
  assert.equal(await readHostDescriptor(metaPath), undefined)
  assert.equal(await readHostDescriptor(join(hostDir, 'missing.json')), undefined)
})
