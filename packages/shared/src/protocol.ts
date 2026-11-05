/**
 * Wire protocol v1 between the Host plugin (UDS server) and the VS Code
 * extension (UDS client): JSON-RPC 2.0 over newline-delimited JSON.
 *
 * Security invariant: the protocol has **no** method that writes a file or
 * commits arbitrary content. The only mutating method is `decision`, and it
 * must reference an existing `requestId` + `nonce` created by the Host.
 */

import type { ReviewOperation } from './review-record.ts'
import type { CommitTargetKind } from './commit-target.ts'

export const PROTOCOL_VERSION = 1

export const METHODS = {
  hello: 'hello',
  decision: 'decision',
  autoAccept: 'autoAccept',
  ack: 'ack',
  ping: 'ping',
  reviewRequest: 'review/request',
  reviewCancel: 'review/cancel',
  reviewMode: 'review/mode',
  reviewState: 'review/state',
  serverShutdown: 'server/shutdown',
} as const

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_FAILED: -32001,
  UNKNOWN_REQUEST: -32002,
  ALREADY_DECIDED: -32003,
  EXPIRED: -32004,
} as const

export interface HelloParams {
  token: string
  protocolVersion: number
  client: { name: string; version: string }
}

export interface HelloResult {
  ok: true
  serverVersion: string
  stateDir: string
  /** True when at least one live session currently runs with review bypassed. */
  bypass?: boolean
}

export interface DecisionParams {
  requestId: string
  nonce: string
  status: 'accept' | 'reject'
  /** Full final file content; required for `accept`. */
  finalContent?: string
  reason?: string
}

export interface DecisionResult {
  ok: true
  outcome: 'committed' | 'rejected' | 'conflict' | 'expired' | 'cancelled' | 'already-decided' | 'failed'
  detail?: { code?: string; message?: string }
}

export interface AutoAcceptParams {
  scope: 'turn'
  max: number
}

export interface AutoAcceptResult {
  ok: true
  expiresAt: number
}

export interface AckParams {
  requestId: string
}

export interface PingResult {
  pong: true
  now: number
}

export interface ReviewRequestParams {
  requestId: string
  nonce: string
  protocolVersion: number
  createdAt: number
  expiresAt: number
  sessionId: string
  sessionLabel: string
  toolName: string
  callId: string
  operation: ReviewOperation
  displayPath: string
  absolutePath: string
  isNewFile: boolean
  languageHint?: string
  /** LF-normalised original content, `null` when the file does not exist. */
  before: string | null
  /** LF-normalised proposed content. */
  after: string
  beforeSha256: string | null
  afterSha256: string
  targetKind: CommitTargetKind
  mode: 'tool-level' | 'strict'
}

export interface ReviewCancelParams {
  requestId: string
  reason: string
}

export interface ReviewStateParams {
  requestId: string
  state: string
  detail?: string
}

/** Review bypass (放行模式) changed: skip the pre-edit review for the session. */
export interface ReviewModeParams {
  bypass: boolean
}

export interface ServerShutdownParams {
  reason?: string
}

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export type ClientRequest =
  | { jsonrpc: '2.0'; id: number | string; method: typeof METHODS.hello; params: HelloParams }
  | { jsonrpc: '2.0'; id: number | string; method: typeof METHODS.decision; params: DecisionParams }
  | { jsonrpc: '2.0'; id: number | string; method: typeof METHODS.autoAccept; params: AutoAcceptParams }
  | { jsonrpc: '2.0'; id: number | string; method: typeof METHODS.ack; params: AckParams }
  | { jsonrpc: '2.0'; id: number | string; method: typeof METHODS.ping; params?: Record<string, never> }

export type ServerNotification =
  | { jsonrpc: '2.0'; method: typeof METHODS.reviewRequest; params: ReviewRequestParams }
  | { jsonrpc: '2.0'; method: typeof METHODS.reviewCancel; params: ReviewCancelParams }
  | { jsonrpc: '2.0'; method: typeof METHODS.reviewState; params: ReviewStateParams }
  | { jsonrpc: '2.0'; method: typeof METHODS.reviewMode; params: ReviewModeParams }
  | { jsonrpc: '2.0'; method: typeof METHODS.serverShutdown; params: ServerShutdownParams }

export type RpcResponse = { jsonrpc: '2.0'; id: number | string | null; result: unknown } |
  { jsonrpc: '2.0'; id: number | string | null; error: RpcError }

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** One NDJSON frame. Embedded newlines are JSON-escaped by `JSON.stringify`. */
export function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Incremental line splitter. Returns complete lines and the remaining tail so
 * a partial frame can be buffered until the next chunk arrives.
 */
export function splitFrames(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter((line) => line.trim().length > 0), rest }
}

// ---------------------------------------------------------------------------
// Runtime validation (no dependencies; both sides must agree)
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStr(value: unknown): value is string {
  return typeof value === 'string'
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isHelloParams(value: unknown): value is HelloParams {
  if (!isDict(value)) return false
  if (!isStr(value.token) || value.token.length < 32) return false
  if (!isNum(value.protocolVersion)) return false
  const client = value.client
  if (!isDict(client) || !isStr(client.name) || !isStr(client.version)) return false
  return true
}

export function isDecisionParams(value: unknown): value is DecisionParams {
  if (!isDict(value)) return false
  if (!isStr(value.requestId) || value.requestId.length === 0) return false
  if (!isStr(value.nonce) || value.nonce.length < 16) return false
  if (value.status !== 'accept' && value.status !== 'reject') return false
  if (value.status === 'accept' && !isStr(value.finalContent)) return false
  if (value.finalContent !== undefined && !isStr(value.finalContent)) return false
  if (value.reason !== undefined && !isStr(value.reason)) return false
  return true
}

export function isAutoAcceptParams(value: unknown): value is AutoAcceptParams {
  if (!isDict(value)) return false
  return value.scope === 'turn' && isNum(value.max) && value.max > 0 && value.max <= 100
}

export function isAckParams(value: unknown): value is AckParams {
  return isDict(value) && isStr(value.requestId)
}

export function isReviewRequestParams(value: unknown): value is ReviewRequestParams {
  if (!isDict(value)) return false
  const stringFields = ['requestId', 'nonce', 'sessionId', 'sessionLabel', 'toolName', 'callId', 'displayPath', 'absolutePath', 'after', 'afterSha256'] as const
  for (const field of stringFields) if (!isStr(value[field])) return false
  if (!isNum(value.protocolVersion) || !isNum(value.createdAt) || !isNum(value.expiresAt)) return false
  if (value.operation !== 'create' && value.operation !== 'update') return false
  if (!isBool(value.isNewFile)) return false
  if (value.before !== null && !isStr(value.before)) return false
  if (value.beforeSha256 !== null && !isStr(value.beforeSha256)) return false
  if (value.languageHint !== undefined && !isStr(value.languageHint)) return false
  if (value.targetKind !== 'direct-workspace' && value.targetKind !== 'git-worktree') return false
  if (value.mode !== 'tool-level' && value.mode !== 'strict') return false
  return true
}

export function isReviewCancelParams(value: unknown): value is ReviewCancelParams {
  return isDict(value) && isStr(value.requestId) && isStr(value.reason)
}

export function isReviewStateParams(value: unknown): value is ReviewStateParams {
  return isDict(value) && isStr(value.requestId) && isStr(value.state)
}

export function isReviewModeParams(value: unknown): value is ReviewModeParams {
  return isDict(value) && isBool(value.bypass)
}

export function isServerNotification(value: unknown): value is ServerNotification {
  if (!isDict(value) || value.jsonrpc !== '2.0' || !isStr(value.method)) return false
  switch (value.method) {
    case METHODS.reviewRequest:
      return isReviewRequestParams(value.params)
    case METHODS.reviewCancel:
      return isReviewCancelParams(value.params)
    case METHODS.reviewState:
      return isReviewStateParams(value.params)
    case METHODS.reviewMode:
      return isReviewModeParams(value.params)
    case METHODS.serverShutdown:
      return isDict(value.params)
    default:
      return false
  }
}
