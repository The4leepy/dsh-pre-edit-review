import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StagingStore } from '../packages/dsh-plugin/src/staging/store.ts'
import type { ReviewRecord } from '../packages/shared/src/review-record.ts'

async function tempStore(): Promise<StagingStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-staging-'))
  const store = new StagingStore({ dir })
  await store.init()
  return store
}

function record(requestId: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    requestId,
    nonce: 'n'.repeat(32),
    protocolVersion: 1,
    createdAt: 1000,
    expiresAt: 61_000,
    sessionId: 'session-1',
    sessionLabel: 'ws#session',
    toolName: 'write',
    callId: 'call-1',
    operation: 'update',
    targetKind: 'direct-workspace',
    displayPath: 'src/a.ts',
    absolutePath: '/ws/src/a.ts',
    before: 'a\n',
    beforeSha256: 'a'.repeat(64),
    proposed: 'b\n',
    proposedSha256: 'b'.repeat(64),
    lineEndings: 'LF',
    mode: 'tool-level',
    state: 'pending',
    ...overrides,
  }
}

test('create/get/list round-trip with owner-only permissions', async () => {
  const store = await tempStore()
  await store.create(record('r1'))
  await store.create(record('r2', { createdAt: 2000 }))
  const r1 = await store.get('r1')
  assert.equal(r1?.displayPath, 'src/a.ts')
  const list = await store.list()
  assert.deepEqual(
    list.map((entry) => entry.requestId),
    ['r1', 'r2'],
  )
  const info = await stat(join(store.dir, 'staging', 'r1.json'))
  assert.equal(info.mode & 0o777, 0o600)
})

test('transitions enforce the state machine', async () => {
  const store = await tempStore()
  await store.create(record('r1'))
  const decided = await store.transition('r1', 'decided', {
    decision: { status: 'accept', by: 'user', decidedAt: 1500 },
  })
  assert.equal(decided.state, 'decided')
  const committed = await store.transition('r1', 'committed', { commit: { at: 1600 } })
  assert.equal(committed.state, 'committed')
  await assert.rejects(() => store.transition('r1', 'pending'), /illegal review transition/)
  await assert.rejects(() => store.transition('missing', 'committed'), /not found/)
})

test('expirePending marks only pending records', async () => {
  const store = await tempStore()
  await store.create(record('r1'))
  await store.create(record('r2'))
  await store.transition('r2', 'rejected', {
    decision: { status: 'reject', by: 'user', decidedAt: 1200 },
  })
  const expired = await store.expirePending()
  assert.deepEqual(
    expired.map((entry) => entry.requestId),
    ['r1'],
  )
  assert.equal((await store.get('r1'))?.state, 'expired')
  assert.equal((await store.get('r2'))?.state, 'rejected')
})

test('audit appends JSONL and never stores file content', async () => {
  const store = await tempStore()
  await store.audit({ event: 'review/committed', displayPath: 'src/a.ts', edited: false })
  await store.audit({ event: 'review/rejected', displayPath: 'src/a.ts' })
  const month = new Date().toISOString().slice(0, 7)
  const file = join(store.dir, 'audit', `${month}.jsonl`)
  const text = await readFile(file, 'utf8')
  const lines = text.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].event, 'review/committed')
  assert.equal(text.includes('a\n'), false)
})
