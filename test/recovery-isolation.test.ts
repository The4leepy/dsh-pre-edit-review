import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import { resolveHostPaths } from '../packages/dsh-plugin/src/paths.ts'
import { reconcileStaging } from '../packages/dsh-plugin/src/recovery.ts'
import { StagingStore } from '../packages/dsh-plugin/src/staging/store.ts'
import type { CommitTarget, CommitTargetHost } from '../packages/shared/src/commit-target.ts'
import type { ReviewRecord } from '../packages/shared/src/review-record.ts'

function record(requestId: string, absolutePath: string): ReviewRecord {
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
    displayPath: absolutePath.split('/').pop() ?? absolutePath,
    absolutePath,
    before: 'a\n',
    beforeSha256: 'a'.repeat(64),
    proposed: 'b\n',
    proposedSha256: 'b'.repeat(64),
    lineEndings: 'LF',
    mode: 'tool-level',
    state: 'pending',
  }
}

interface HostStore {
  hostKey: string
  hostDir: string
  auditDir: string
  store: StagingStore
}

async function storesFor(root: string, hostKeys: readonly string[]): Promise<HostStore[]> {
  const stores: HostStore[] = []
  for (const hostKey of hostKeys) {
    const paths = resolveHostPaths(normalizeConfig({ stateDir: root, hostKey }))
    const store = new StagingStore({ dir: paths.hostDir })
    await store.init()
    stores.push({ hostKey, hostDir: paths.hostDir, auditDir: paths.auditDir, store })
  }
  return stores
}

function noopTarget(): CommitTarget {
  return {
    kind: 'direct-workspace',
    prepare: async () => {
      throw new Error('prepare must not run during reconciliation')
    },
    commit: async () => {
      throw new Error('commit must never run during reconciliation')
    },
    inspect: async () => {
      throw new Error('inspect must not run for pending-only staging')
    },
  }
}

const host = {} as CommitTargetHost
const signal = new AbortController().signal

test('expirePending in one Host never touches another Host pending record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-isolation-'))
  const [hostA, hostB] = await storesFor(root, ['desktop', 'tui'])
  await hostA.store.create(record('req-a', '/ws/a.ts'))
  await hostB.store.create(record('req-b', '/ws/b.ts'))

  const expiredB = await hostB.store.expirePending()
  assert.deepEqual(
    expiredB.map((entry) => entry.requestId),
    ['req-b'],
  )
  assert.equal((await hostA.store.get('req-a'))?.state, 'pending')
  assert.equal((await hostB.store.get('req-b'))?.state, 'expired')
  assert.notEqual(hostA.hostDir, hostB.hostDir)
  assert.notEqual(hostA.auditDir, hostB.auditDir)

  // Each store lists only its own namespace.
  assert.deepEqual(
    (await hostA.store.list()).map((entry) => entry.requestId),
    ['req-a'],
  )
  assert.deepEqual(
    (await hostB.store.list()).map((entry) => entry.requestId),
    ['req-b'],
  )
})

test('startup reconciliation in one Host leaves another Host records untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-isolation-'))
  const [hostA, hostB] = await storesFor(root, ['desktop', 'tui'])
  await hostA.store.create(record('req-a', '/ws/a.ts'))
  await hostB.store.create(record('req-b', '/ws/b.ts'))

  await hostB.store.expirePending()
  const counts = await reconcileStaging(hostB.store, noopTarget(), host, signal)
  assert.equal(counts.expired, 0)
  assert.equal(counts.unchanged, 1)

  assert.equal((await hostA.store.get('req-a'))?.state, 'pending')
  assert.equal((await hostA.store.get('req-a'))?.commit, undefined)
})

test('audit lines are written under the Host namespace only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-isolation-'))
  const [hostA, hostB] = await storesFor(root, ['desktop', 'tui'])
  await hostA.store.audit({ event: 'review/activated', sessionId: 'session-1' })

  const aFiles = await readdir(hostA.auditDir)
  const bFiles = await readdir(hostB.auditDir)
  assert.equal(aFiles.length, 1)
  assert.deepEqual(bFiles, [])
})
