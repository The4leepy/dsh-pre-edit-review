/**
 * Durable per-workspace decision history behind the "Review History" view.
 *
 * Every settled decision (accept, reject, auto-accept, conflict, expiry,
 * cancellation) is appended here, newest first, and capped at
 * {@link HISTORY_LIMIT} entries. The payload is deliberately small: no file
 * contents, no hashes, only the metadata the history view renders.
 *
 * The store keeps no in-memory cache: it reads straight from the workspace
 * `Memento`, so a corrupt or tampered value can only ever degrade the history
 * view to "empty", never break a review decision.
 */

import * as vscode from 'vscode'

import { isRecord } from './util.ts'

/** Workspace-state key that holds the history array. */
export const HISTORY_KEY = 'dpr.history'

/** Maximum number of decisions kept. */
export const HISTORY_LIMIT = 50

export type HistoryStatus = 'committed' | 'rejected' | 'conflict' | 'expired' | 'cancelled' | 'failed'

export interface HistoryEntry {
  requestId: string
  displayPath: string
  toolName: string
  mode: string
  status: HistoryStatus
  /** Raw protocol outcome; may be `already-decided` etc. */
  outcome: string
  /** True when the user's final content differed from the agent's proposal. */
  edited: boolean
  /** Epoch milliseconds of the settling decision. */
  at: number
}

const HISTORY_STATUSES: ReadonlySet<string> = new Set<string>([
  'committed',
  'rejected',
  'conflict',
  'expired',
  'cancelled',
  'failed',
])

/**
 * Collapse a protocol outcome into the stable history-status vocabulary.
 * Unknown (non-terminal or future) outcomes are recorded as `failed` so the
 * row still has a rendering bucket; the raw outcome is kept alongside it.
 */
export function historyStatusFor(outcome: string): HistoryStatus {
  if (HISTORY_STATUSES.has(outcome)) return outcome as HistoryStatus
  return 'failed'
}

function isHistoryStatus(value: unknown): value is HistoryStatus {
  return typeof value === 'string' && HISTORY_STATUSES.has(value)
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!isRecord(value)) return false
  return (
    typeof value['requestId'] === 'string' &&
    typeof value['displayPath'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    typeof value['mode'] === 'string' &&
    isHistoryStatus(value['status']) &&
    typeof value['outcome'] === 'string' &&
    typeof value['edited'] === 'boolean' &&
    typeof value['at'] === 'number' &&
    Number.isFinite(value['at'])
  )
}

/** Read + validate the persisted history. Never throws; corrupt data reads as `[]`. */
export function readHistory(memento: vscode.Memento, limit: number = HISTORY_LIMIT): HistoryEntry[] {
  let raw: unknown
  try {
    raw = memento.get<unknown>(HISTORY_KEY, [])
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const entries: HistoryEntry[] = []
  for (const value of raw) {
    if (isHistoryEntry(value)) entries.push(value)
  }
  entries.sort((left, right) => right.at - left.at)
  return entries.slice(0, Math.max(1, limit))
}

function cloneEntry(entry: HistoryEntry): HistoryEntry {
  return {
    requestId: entry.requestId,
    displayPath: entry.displayPath,
    toolName: entry.toolName,
    mode: entry.mode,
    status: entry.status,
    outcome: entry.outcome,
    edited: entry.edited,
    at: entry.at,
  }
}

export interface ReviewHistoryStoreOptions {
  /** `context.workspaceState` in the extension, a fake in tests. */
  memento: vscode.Memento
  limit?: number
  /** Called after a successful write so the tree view can refresh. */
  onChanged?(): void
}

/**
 * Persistence helper shared by the extension command surface and the
 * in-process self-test. One decision per request: appending an already known
 * `requestId` replaces the older row (the Host can emit both a decision reply
 * and a `review/state` notification for the same request).
 */
export class ReviewHistoryStore {
  private readonly memento: vscode.Memento
  private readonly limit: number
  private readonly onChanged: (() => void) | undefined

  constructor(options: ReviewHistoryStoreOptions) {
    this.memento = options.memento
    this.limit = Math.max(1, options.limit ?? HISTORY_LIMIT)
    this.onChanged = options.onChanged
  }

  get limitCount(): number {
    return this.limit
  }

  list(): readonly HistoryEntry[] {
    return readHistory(this.memento, this.limit)
  }

  async append(entry: HistoryEntry): Promise<void> {
    const current = readHistory(this.memento, this.limit).filter(
      (existing) => existing.requestId !== entry.requestId,
    )
    const next = [cloneEntry(entry), ...current].slice(0, this.limit)
    await this.memento.update(HISTORY_KEY, next)
    this.onChanged?.()
  }

  /** Drop one record (used by the self-test to clean up its synthetic row). */
  async remove(requestId: string): Promise<void> {
    const current = this.list()
    const next = current.filter((entry) => entry.requestId !== requestId)
    if (next.length === current.length) return
    await this.memento.update(HISTORY_KEY, next)
    this.onChanged?.()
  }

  async clear(): Promise<void> {
    await this.memento.update(HISTORY_KEY, [])
    this.onChanged?.()
  }
}
