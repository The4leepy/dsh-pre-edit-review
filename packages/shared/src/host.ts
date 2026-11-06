/**
 * Multi-Host discovery contract (ADR 0002).
 *
 * Every plugin Host instance owns one directory under `<stateDir>/hosts/<key>/`
 * and publishes a `meta.json` descriptor so the VS Code extension can discover
 * and connect to several Hosts at once (for example the Desktop app and the
 * TUI, which run as separate DSH profiles on the same machine).
 *
 * The descriptor never contains the token itself — only its path. The token
 * file stays `0600` and is read by the client directly.
 */

/** Directory (under the root state dir) that groups one namespace per Host. */
export const HOSTS_DIR_NAME = 'hosts'

/** A Host key is a file-name-safe slug; it is also the directory name. */
export const HOST_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export function isHostKey(value: unknown): value is string {
  return typeof value === 'string' && HOST_KEY_PATTERN.test(value) && value !== '.' && value !== '..'
}

/**
 * Normalise an untrusted label into a host key. Characters outside
 * `[A-Za-z0-9._-]` collapse to `_`; leading `.`, `_` or `-` are stripped so a
 * path-like label can never start with a dot segment; an empty result falls
 * back to `default`.
 */
export function sanitizeHostKey(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return 'default'
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 64)
  if (cleaned.length === 0) return 'default'
  return cleaned
}

/** `meta.json` written by a Host instance. Paths are absolute. */
export interface HostDescriptor {
  /** Directory-safe Host identity; equals the containing directory name. */
  key: string
  /** Human-readable label for the UI (the DSH profile name by default). */
  label: string
  pid: number
  /** Host plugin version that produced this descriptor. */
  pluginVersion: string
  /**
   * Random per-runtime instance id. Two runtimes in one process can share
   * pid + millisecond `startedAt` (HMR); the instance id keeps descriptor
   * ownership unambiguous.
   */
  instanceId?: string
  startedAt: number
  /** Absolute host directory that contains `staging/` and `audit/`. */
  stateDir: string
  socketPath: string
  tokenPath: string
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.startsWith('/')
}

/** Structural validation for descriptors read from disk (untrusted input). */
export function isHostDescriptor(value: unknown): value is HostDescriptor {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    isHostKey(record['key']) &&
    typeof record['label'] === 'string' &&
    record['label'].length > 0 &&
    typeof record['pid'] === 'number' &&
    Number.isInteger(record['pid']) &&
    record['pid'] > 0 &&
    typeof record['pluginVersion'] === 'string' &&
    (record['instanceId'] === undefined || typeof record['instanceId'] === 'string') &&
    typeof record['startedAt'] === 'number' &&
    Number.isFinite(record['startedAt']) &&
    isAbsolutePath(record['stateDir']) &&
    isAbsolutePath(record['socketPath']) &&
    isAbsolutePath(record['tokenPath'])
  )
}
