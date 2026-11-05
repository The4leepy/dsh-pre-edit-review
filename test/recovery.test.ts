import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StagingStore } from '../packages/dsh-plugin/src/staging/store.ts'
import { reconcileStaging } from '../packages/dsh-plugin/src/recovery.ts'
import type { CommitTarget, CommitTargetHost, FileSnapshot } from '../packages/shared/src/commit-target.ts'
import type { ReviewRecord } from '../packages/shared/src/review-record.ts'

function record(requestId: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    requestId,
    nonce: 'n'.repeat(32),
    protocolVersion: 1,
    createdAt: 1000,
    expiresAt: 61_000,
    sessionId: 'session-1',
    sessionLabel: 'ws#s',
    workspaceRoot: '/ws',
    toolName: 'write',
    callId: 'call-1',
    operation: 'update',
    targetKind: 'direct-workspace',
    displayPath: 'a.ts',
    absolutePath: `/ws/${requestId}.ts`,
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

async function storeWith(records: ReviewRecord[]): Promise<StagingStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-recovery-'))
  const store = new StagingStore({ dir })
  await store.init()
  for (const entry of records) await store.create(entry)
  return store
}

function targetFor(hashes: Record<string, string | null>): CommitTarget {
  return {
    kind: 'direct-workspace',
    prepare: async () => {
      throw new Error('prepare must not run during reconciliation')
    },
    commit: async () => {
      throw new Error('commit must never run during reconciliation')
    },
    inspect: async (_host: CommitTargetHost, snapshot: FileSnapshot) => ({
      exists: hashes[snapshot.absolutePath] !== null,
      sha256: hashes[snapshot.absolutePath] ?? null,
      version: undefined,
    }),
  }
}

const host = {} as CommitTargetHost
const signal = new AbortController().signal

test('pending records are expired and never re-committed', async () => {
  const store = await storeWith([record('pending-1')])
  const counts = await reconcileStaging(store, targetFor({}), host, signal)
  assert.equal(counts.expired, 1)
  assert.equal((await store.get('pending-1'))?.state, 'expired')
})

test('a decided record whose write landed becomes committed', async () => {
  const store = await storeWith([record('landed-1')])
  await store.transition('landed-1', 'decided', {
    decision: { status: 'accept', by: 'user', finalContentSha256: 'f'.repeat(64), decidedAt: 2000 },
  })
  const counts = await reconcileStaging(
    store,
    targetFor({ '/ws/landed-1.ts': 'f'.repeat(64) }),
    host,
    signal,
  )
  assert.equal(counts.committed, 1)
  assert.equal((await store.get('landed-1'))?.state, 'committed')
  assert.equal((await store.get('landed-1'))?.commit?.code, 'RECOVERED_COMMITTED')
})

test('a decided record whose content does not match becomes a conflict without a retry', async () => {
  const store = await storeWith([record('mismatch-1')])
  await store.transition('mismatch-1', 'decided', {
    decision: { status: 'accept', by: 'user', finalContentSha256: 'f'.repeat(64), decidedAt: 2000 },
  })
  const counts = await reconcileStaging(
    store,
    targetFor({ '/ws/mismatch-1.ts': 'e'.repeat(64) }),
    host,
    signal,
  )
  assert.equal(counts.conflict, 1)
  const recordAfter = await store.get('mismatch-1')
  assert.equal(recordAfter?.state, 'conflict')
  assert.equal(recordAfter?.commit?.code, 'RECOVERED_MISMATCH')
})

test('a decided record with a missing file becomes a conflict', async () => {
  const store = await storeWith([record('missing-1')])
  await store.transition('missing-1', 'decided', {
    decision: { status: 'accept', by: 'user', finalContentSha256: 'f'.repeat(64), decidedAt: 2000 },
  })
  const counts = await reconcileStaging(store, targetFor({}), host, signal)
  assert.equal(counts.conflict, 1)
})

test('a decided record without a content hash is retained as a conflict', async () => {
  const store = await storeWith([record('nohash-1')])
  await store.transition('nohash-1', 'decided', {
    decision: { status: 'accept', by: 'user', decidedAt: 2000 },
  })
  const counts = await reconcileStaging(store, targetFor({}), host, signal)
  assert.equal(counts.conflict, 1)
  assert.equal((await store.get('nohash-1'))?.commit?.code, 'RECOVERED_NO_DECISION_HASH')
})

test('terminal records are left untouched', async () => {
  const store = await storeWith([
    record('rejected-1', { state: 'rejected' }),
    record('committed-1', { state: 'committed' }),
  ])
  const counts = await reconcileStaging(store, targetFor({}), host, signal)
  assert.equal(counts.expired + counts.committed + counts.conflict, 0)
  assert.equal(counts.unchanged, 2)
  assert.equal((await store.get('rejected-1'))?.state, 'rejected')
})
