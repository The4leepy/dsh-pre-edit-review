/**
 * Durable staging store for review records.
 *
 * Ordering invariant: a record is fsync-visible here **before** the review UI
 * is shown, so a crash can never produce a committed file whose record was
 * never written. `~/.dsh/pre-edit-review` is created 0700; records are 0600
 * and never contain log lines.
 */
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomHex, type ReviewRecord, type ReviewState, canTransition } from '../../../shared/src/index.ts'

export interface StagingStoreOptions {
  dir: string
  now?: () => number
}

export class StagingStore {
  readonly dir: string
  private readonly now: () => number

  constructor(options: StagingStoreOptions) {
    this.dir = options.dir
    this.now = options.now ?? (() => Date.now())
  }

  static async open(options: StagingStoreOptions): Promise<StagingStore> {
    const store = new StagingStore(options)
    await store.init()
    return store
  }

  /** Create the state directories with owner-only permissions. */
  async init(): Promise<void> {
    await mkdir(join(this.dir, 'staging'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.dir, 'audit'), { recursive: true, mode: 0o700 })
  }

  private recordPath(requestId: string): string {
    return join(this.dir, 'staging', `${requestId}.json`)
  }

  async create(record: ReviewRecord): Promise<void> {
    const path = this.recordPath(record.requestId)
    const temp = `${path}.${randomHex(6)}.tmp`
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  }

  async get(requestId: string): Promise<ReviewRecord | undefined> {
    try {
      const raw = await readFile(this.recordPath(requestId), 'utf8')
      return JSON.parse(raw) as ReviewRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async list(): Promise<ReviewRecord[]> {
    const entries = await readdir(join(this.dir, 'staging')).catch(() => [] as string[])
    const records: ReviewRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const record = await this.get(entry.slice(0, -'.json'.length))
      if (record !== undefined) records.push(record)
    }
    return records.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Apply one transition. Throws when the transition is illegal, which makes
   * duplicate decisions and late decisions fail loudly instead of corrupting
   * state. The caller decides which IPC error to return.
   */
  async transition(requestId: string, next: ReviewState, patch: Partial<ReviewRecord> = {}): Promise<ReviewRecord> {
    const current = await this.get(requestId)
    if (current === undefined) throw new Error(`staging record ${requestId} not found`)
    if (!canTransition(current.state, next)) {
      throw new Error(`illegal review transition ${current.state} -> ${next} for ${requestId}`)
    }
    const updated: ReviewRecord = { ...current, ...patch, state: next }
    await this.create(updated)
    return updated
  }

  /** Crash recovery: every non-terminal record becomes `expired`; never commits. */
  async expirePending(): Promise<ReviewRecord[]> {
    const expired: ReviewRecord[] = []
    for (const record of await this.list()) {
      if (record.state !== 'pending') continue
      expired.push(
        await this.transition(record.requestId, 'expired', {
          commit: { at: this.now(), code: 'RECOVERED_PENDING', message: 'host restarted before a decision' },
        }),
      )
    }
    return expired
  }

  async remove(requestId: string): Promise<void> {
    await unlink(this.recordPath(requestId)).catch(() => undefined)
  }

  /** Append one audit line (hashes and paths only, never file content). */
  async audit(event: Record<string, unknown>): Promise<void> {
    const now = new Date(this.now())
    const dir = join(this.dir, 'audit')
    // Activation commands may run before the async init finished; never lose
    // the audit line because the directory is not there yet.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${now.toISOString().slice(0, 7)}.jsonl`)
    await chmod(file, 0o600).catch(() => undefined)
    const handle = await open(file, 'a', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({ at: now.toISOString(), ...event })}\n`, 'utf8')
    } finally {
      await handle.close()
    }
  }
}
