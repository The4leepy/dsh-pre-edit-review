import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DirectWorkspaceTarget } from '../packages/dsh-plugin/src/targets/direct-workspace.ts'
import { CommitConflict } from '../packages/shared/src/commit-target.ts'
import type { CommitTargetHost } from '../packages/shared/src/commit-target.ts'
import type { FsTargetView } from '../packages/dsh-plugin/src/host.ts'

interface WriteCall {
  path: string
  content: string
  expected: unknown
  policy: unknown
}

class FakeHost implements CommitTargetHost {
  readonly files = new Map<string, string>()
  readonly versions = new Map<string, string>()
  readonly writes: WriteCall[] = []
  readonly observations: Array<{ path: string; version: unknown; actor: unknown }> = []
  private counter = 0
  private readonly root: string

  constructor(root: string = '/ws') {
    this.root = root
  }

  async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetView> {
    const abs = path.startsWith('/') ? path : join(options?.cwd ?? this.root, path)
    return { targetKey: abs, displayPath: abs }
  }

  contains(parent: unknown, child: unknown): boolean {
    const p = parent as FsTargetView
    const c = child as FsTargetView
    return c.targetKey === p.targetKey || c.targetKey.startsWith(`${p.targetKey}/`)
  }

  async stat(target: unknown): Promise<{ version: unknown; size?: number } | undefined> {
    const key = (target as FsTargetView).targetKey
    const version = this.versions.get(key)
    return version === undefined ? undefined : { version, size: this.files.get(key)?.length }
  }

  async readText(target: unknown): Promise<string> {
    const key = (target as FsTargetView).targetKey
    const content = this.files.get(key)
    if (content === undefined) throw new Error('not found')
    return content
  }

  async writeText(
    target: unknown,
    content: string,
    expected?: { kind: string; version?: unknown },
    _signal?: AbortSignal,
    policy?: unknown,
  ): Promise<{ operation: 'create' | 'update'; version: unknown; before: string | null; after: string }> {
    const key = (target as FsTargetView).targetKey
    const exists = this.files.has(key)
    if (expected?.kind === 'createIfAbsent' && exists) throw Object.assign(new Error('exists'), { code: 'FS_NOT_OBSERVED' })
    if (expected?.kind === 'replaceIfVersion') {
      if (!exists) throw Object.assign(new Error('missing'), { code: 'FS_STALE_VERSION' })
      if (this.versions.get(key) !== expected.version) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
    }
    const before = exists ? (this.files.get(key) as string) : null
    this.files.set(key, content)
    const version = `v${++this.counter}`
    this.versions.set(key, version)
    this.writes.push({ path: key, content, expected, policy })
    return { operation: exists ? 'update' : 'create', version, before, after: content }
  }

  processPath(target: unknown): string {
    return (target as FsTargetView).targetKey
  }

  observe(target: unknown, version: unknown, actor: unknown): void {
    this.observations.push({ path: (target as FsTargetView).targetKey, version, actor })
  }

  async workspaceRoot(): Promise<string> {
    return this.root
  }
}

test('prepare rejects paths outside the workspace root', async () => {
  const host = new FakeHost('/ws')
  const target = new DirectWorkspaceTarget()
  await assert.rejects(
    () => target.prepare(host, '/etc/passwd', new AbortController().signal),
    (error: unknown) => error instanceof CommitConflict && error.code === 'OUT_OF_SCOPE',
  )
})

test('prepare reads a CRLF snapshot as normalised content plus the original line endings', async () => {
  const host = new FakeHost('/ws')
  host.files.set('/ws/src/a.ts', 'a\r\nb\r\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const snapshot = await new DirectWorkspaceTarget().prepare(host, 'src/a.ts', new AbortController().signal)
  assert.equal(snapshot.displayPath, 'src/a.ts')
  assert.equal(snapshot.content, 'a\nb\n')
  assert.equal(snapshot.lineEndings, 'CRLF')
  assert.equal(snapshot.exists, true)
  assert.equal(snapshot.version, 'v0')
  assert.match(String(snapshot.sha256), /^[0-9a-f]{64}$/)
})

test('prepare marks a missing file as a new file', async () => {
  const host = new FakeHost('/ws')
  const snapshot = await new DirectWorkspaceTarget().prepare(host, 'src/new.ts', new AbortController().signal, {
    mode: 'strict',
  })
  assert.equal(snapshot.exists, false)
  assert.equal(snapshot.isNewFile, true)
  assert.equal(snapshot.content, null)
  assert.equal(snapshot.mode, 'strict')
})

test('commit writes once with the explicit workspace-write policy and records the observation', async () => {
  const host = new FakeHost('/ws')
  host.files.set('/ws/src/a.ts', 'a\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const target = new DirectWorkspaceTarget()
  const snapshot = await target.prepare(host, 'src/a.ts', new AbortController().signal)
  const result = await target.commit(
    host,
    snapshot,
    'a\nb\n',
    { kind: 'replaceIfVersion', version: snapshot.version },
    new AbortController().signal,
    { marker: 'exec' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.operation, 'update')
  assert.equal(result.after, 'a\nb\n')
  assert.equal(host.writes.length, 1)
  assert.deepEqual(host.writes[0].policy, { mode: 'workspace-write', workspaceRoot: '/ws' })
  assert.equal(host.observations.length, 1)
  assert.equal(host.observations[0].version, result.versionAfter)
})

test('commit maps a stale precondition to CommitConflict without a second write', async () => {
  const host = new FakeHost('/ws')
  host.files.set('/ws/src/a.ts', 'a\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const target = new DirectWorkspaceTarget()
  const snapshot = await target.prepare(host, 'src/a.ts', new AbortController().signal)
  await assert.rejects(
    () =>
      target.commit(
        host,
        snapshot,
        'changed\n',
        { kind: 'replaceIfVersion', version: 'stale' },
        new AbortController().signal,
      ),
    (error: unknown) => error instanceof CommitConflict && error.code === 'FS_STALE_VERSION',
  )
  assert.equal(host.writes.length, 0)
})

test('inspect reports the current hash without writing', async () => {
  const host = new FakeHost('/ws')
  host.files.set('/ws/src/a.ts', 'a\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const target = new DirectWorkspaceTarget()
  const snapshot = await target.prepare(host, 'src/a.ts', new AbortController().signal)
  const inspected = await target.inspect(host, snapshot, new AbortController().signal)
  assert.equal(inspected.exists, true)
  assert.equal(inspected.sha256, snapshot.sha256)
  assert.equal(host.writes.length, 0)

  host.files.delete('/ws/src/a.ts')
  host.versions.delete('/ws/src/a.ts')
  const missing = await target.inspect(host, snapshot, new AbortController().signal)
  assert.equal(missing.exists, false)
  assert.equal(missing.sha256, null)
})
