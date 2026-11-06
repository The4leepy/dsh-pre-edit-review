import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/** Raw config as authored in `cordis.patch.yml`; every field is optional. */
export interface RawPluginConfig {
  enabled?: boolean
  mode?: 'review' | 'off'
  /**
   * Whether review is active for a session that made no explicit choice.
   * Default `false` (ADR 0002): a fresh install, an upgrade and a hand-written
   * profile config that omits this key all start with review inactive. Set
   * `true` explicitly to review every session by default.
   */
  defaultActive?: boolean
  /** Overrides the detected Host key (`<stateDir>/hosts/<hostKey>/`). */
  hostKey?: string
  /** Display label for the Host; defaults to the resolved host key. */
  hostLabel?: string
  reviewTools?: string[]
  exemptTools?: string[]
  unknownToolPolicy?: 'deny' | 'pass'
  mutationNamePatterns?: string[]
  approvalTimeoutMs?: number
  maxFileBytes?: number
  fallback?: 'deny' | 'dsh-approval'
  enableAutoAccept?: boolean
  autoAcceptMax?: number
  /** Root state directory; per-Host data lives under `<stateDir>/hosts/<key>/`. */
  stateDir?: string
  /** Explicit socket override; by default `<hostDir>/ipc.sock`. */
  socketPath?: string
  clientConnectTimeoutMs?: number
  noticeOnUserEdit?: boolean
  allowPause?: boolean
  /** @deprecated legacy name for allowPause. */
  allowBypass?: boolean
  auditRetentionDays?: number
}

export interface PluginConfig {
  enabled: boolean
  mode: 'review' | 'off'
  defaultActive: boolean
  hostKey?: string
  hostLabel?: string
  reviewTools: readonly string[]
  exemptTools: readonly string[]
  unknownToolPolicy: 'deny' | 'pass'
  mutationNamePatterns: readonly RegExp[]
  approvalTimeoutMs: number
  maxFileBytes: number
  fallback: 'deny' | 'dsh-approval'
  enableAutoAccept: boolean
  autoAcceptMax: number
  stateDir: string
  socketPath?: string
  clientConnectTimeoutMs: number
  noticeOnUserEdit: boolean
  allowPause: boolean
  auditRetentionDays: number
}

export const DEFAULT_REVIEW_TOOLS = ['write', 'edit', 'str_replace_editor'] as const
export const DEFAULT_MUTATION_PATTERNS = [
  '(^|_)(write|edit|create|delete|remove|move|rename|replace|patch|apply)(_|$)',
] as const

export const DEFAULT_STATE_DIR = '~/.dsh/pre-edit-review'

/** Expand a leading `~` and make the result absolute. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function fail(message: string): never {
  throw new Error(`dsh-pre-edit-review config: ${message}`)
}

function positiveInt(value: unknown, name: string, fallback: number, min = 1): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    fail(`${name} must be an integer >= ${min}`)
  }
  return value
}

function booleanValue(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`)
  return value
}

/** Trim an optional string; empty (or whitespace-only) means "not set". */
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${name} must be a string`)
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Expand an optional path override; empty means "use the per-Host default". */
function optionalPath(value: unknown, name: string): string | undefined {
  const raw = optionalString(value, name)
  return raw === undefined ? undefined : expandHome(raw)
}

function stringArray(value: unknown, name: string, fallback: readonly string[]): readonly string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fail(`${name} must be an array of non-empty strings`)
  }
  return value
}

export function normalizeConfig(raw: unknown): PluginConfig {
  const input = (raw ?? {}) as RawPluginConfig
  if (typeof input !== 'object' || input === null) fail('config must be an object')

  const mode = input.mode ?? 'review'
  if (mode !== 'review' && mode !== 'off') fail('mode must be "review" or "off"')
  const unknownToolPolicy = input.unknownToolPolicy ?? 'deny'
  if (unknownToolPolicy !== 'deny' && unknownToolPolicy !== 'pass') fail('unknownToolPolicy must be "deny" or "pass"')
  const fallback = input.fallback ?? 'deny'
  if (fallback !== 'deny' && fallback !== 'dsh-approval') fail('fallback must be "deny" or "dsh-approval"')

  const stateDir = expandHome(input.stateDir ?? DEFAULT_STATE_DIR)
  // No root-level default: each Host gets `<stateDir>/hosts/<hostKey>/ipc.sock`.
  const socketPath = optionalPath(input.socketPath, 'socketPath')

  return {
    enabled: input.enabled ?? true,
    mode,
    // ADR 0002 §1: inactive is the product default. The shipped bundle also
    // spells it out, but the schema fallback must agree so a profile-level
    // config row that replaces `config` wholesale cannot silently turn review
    // back on (that used to fail-close every write after an upgrade).
    defaultActive: booleanValue(input.defaultActive, 'defaultActive', false),
    hostKey: optionalString(input.hostKey, 'hostKey'),
    hostLabel: optionalString(input.hostLabel, 'hostLabel'),
    reviewTools: stringArray(input.reviewTools, 'reviewTools', DEFAULT_REVIEW_TOOLS),
    exemptTools: stringArray(input.exemptTools, 'exemptTools', []),
    unknownToolPolicy,
    mutationNamePatterns: stringArray(input.mutationNamePatterns, 'mutationNamePatterns', DEFAULT_MUTATION_PATTERNS).map(
      (pattern) => new RegExp(pattern, 'i'),
    ),
    approvalTimeoutMs: positiveInt(input.approvalTimeoutMs, 'approvalTimeoutMs', 600_000, 1_000),
    maxFileBytes: positiveInt(input.maxFileBytes, 'maxFileBytes', 2 * 1024 * 1024, 1),
    fallback,
    enableAutoAccept: input.enableAutoAccept ?? true,
    autoAcceptMax: positiveInt(input.autoAcceptMax, 'autoAcceptMax', 20, 1),
    stateDir,
    ...(socketPath !== undefined ? { socketPath } : {}),
    clientConnectTimeoutMs: positiveInt(input.clientConnectTimeoutMs, 'clientConnectTimeoutMs', 3_000, 100),
    noticeOnUserEdit: input.noticeOnUserEdit ?? true,
    allowPause: input.allowPause ?? input.allowBypass ?? true,
    auditRetentionDays: positiveInt(input.auditRetentionDays, 'auditRetentionDays', 30, 1),
  }
}
