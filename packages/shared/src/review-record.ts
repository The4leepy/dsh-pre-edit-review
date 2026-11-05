/**
 * Durable review record and its state machine.
 *
 * One record per intercepted tool call. The record is written to the staging
 * directory *before* any UI is shown (crash safety: an un-decided record can
 * never have been committed).
 */

export type ReviewState =
  | 'pending'
  | 'decided'
  | 'committed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'conflict'
  | 'failed'

export type ReviewOperation = 'create' | 'update'

export interface ReviewDecision {
  status: 'accept' | 'reject'
  by: 'user' | 'auto'
  reason?: string
  finalContentSha256?: string
  decidedAt: number
}

export interface ReviewCommitInfo {
  at?: number
  code?: string
  message?: string
}

export interface ReviewRecord {
  requestId: string
  nonce: string
  protocolVersion: number
  createdAt: number
  expiresAt: number
  sessionId: string
  sessionLabel: string
  agentId?: string
  toolName: string
  callId: string
  operation: ReviewOperation
  targetKind: 'direct-workspace' | 'git-worktree'
  displayPath: string
  absolutePath: string
  before: string | null
  beforeSha256: string | null
  proposed: string
  proposedSha256: string
  lineEndings: 'LF' | 'CRLF'
  mode: 'tool-level' | 'strict'
  state: ReviewState
  decision?: ReviewDecision
  commit?: ReviewCommitInfo
  /** Absolute path of the staging payload, when the record was hydrated lazily. */
  stagingFile?: string
}

export const TERMINAL_STATES: ReadonlySet<ReviewState> = new Set<ReviewState>([
  'committed',
  'rejected',
  'expired',
  'cancelled',
  'conflict',
  'failed',
])

export function isTerminal(state: ReviewState): boolean {
  return TERMINAL_STATES.has(state)
}

const TRANSITIONS: Readonly<Record<ReviewState, readonly ReviewState[]>> = {
  pending: ['decided', 'expired', 'cancelled', 'failed'],
  decided: ['committed', 'conflict', 'failed'],
  committed: [],
  rejected: [],
  expired: [],
  cancelled: [],
  conflict: [],
  failed: [],
}

export function canTransition(from: ReviewState, to: ReviewState): boolean {
  return TRANSITIONS[from].includes(to)
}

export type DecisionOutcome =
  | 'committed'
  | 'rejected'
  | 'conflict'
  | 'expired'
  | 'cancelled'
  | 'already-decided'
  | 'failed'

export interface DecisionResultBody {
  ok: true
  outcome: DecisionOutcome
  detail?: { code?: string; message?: string }
}
