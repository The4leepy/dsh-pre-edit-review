/**
 * Crash reconciliation for interrupted reviews.
 *
 * A review can be interrupted between "decision accepted" and "commit recorded"
 * (Host crash / power loss). On the next start we must decide, read-only, what
 * actually happened — and **never** re-commit:
 *
 * - `pending`      → expired (the user never decided; nothing was written);
 * - `decided`      → compare the file's current SHA-256 with the accepted
 *                    final-content hash:
 *                      equal   → committed (the write happened before the crash);
 *                      differ  → conflict  (retained as evidence, no retry);
 * - terminal       → untouched.
 *
 * This runs after `StagingStore.expirePending()` in the runtime startup path.
 */
import { CommitConflict, sha256Hex, type CommitTarget, type CommitTargetHost, type FileSnapshot } from '../../shared/src/index.ts'
import type { StagingStore } from './staging/store.ts'

export interface ReconciliationCounts {
  expired: number
  committed: number
  conflict: number
  unchanged: number
}

function snapshotFor(record: {
  displayPath: string
  absolutePath: string
  mode: 'tool-level' | 'strict'
}): FileSnapshot {
  return {
    displayPath: record.displayPath,
    absolutePath: record.absolutePath,
    exists: true,
    isNewFile: false,
    content: null,
    sha256: null,
    version: undefined,
    lineEndings: 'LF',
    mode: record.mode,
  }
}

/**
 * Reconcile every non-terminal record. `host` must stay valid for the whole
 * pass; `signal` bounds the file inspections.
 */
export async function reconcileStaging(
  store: StagingStore,
  target: CommitTarget,
  host: CommitTargetHost,
  signal: AbortSignal,
): Promise<ReconciliationCounts> {
  const counts: ReconciliationCounts = { expired: 0, committed: 0, conflict: 0, unchanged: 0 }

  for (const record of await store.list()) {
    if (record.state === 'pending') {
      await store.transition(record.requestId, 'expired', {
        commit: { at: Date.now(), code: 'RECOVERED_PENDING', message: 'host restarted before a decision' },
      })
      counts.expired += 1
      continue
    }

    if (record.state !== 'decided') {
      counts.unchanged += 1
      continue
    }

    const expected = record.decision?.finalContentSha256
    if (expected === undefined) {
      await store.transition(record.requestId, 'conflict', {
        commit: { at: Date.now(), code: 'RECOVERED_NO_DECISION_HASH', message: 'accepted decision had no content hash' },
      })
      counts.conflict += 1
      continue
    }

    let actual: string | null = null
    try {
      const inspected = await target.inspect(host, snapshotFor(record), signal)
      actual = inspected.sha256
    } catch (error) {
      if (!(error instanceof CommitConflict)) throw error
      actual = null
    }

    if (actual !== null && actual === expected) {
      await store.transition(record.requestId, 'committed', {
        commit: { at: Date.now(), code: 'RECOVERED_COMMITTED', message: 'write had landed before the host restarted' },
      })
      counts.committed += 1
    } else {
      await store.transition(record.requestId, 'conflict', {
        commit: {
          at: Date.now(),
          code: 'RECOVERED_MISMATCH',
          message: 'accepted content does not match the file on disk; nothing was re-committed',
        },
      })
      counts.conflict += 1
    }
  }

  return counts
}

/** Hash helper re-exported for callers that assemble expected hashes. */
export { sha256Hex }
