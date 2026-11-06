/**
 * Per-Host state paths (ADR 0002 §3).
 *
 * The root state directory is shared by every DSH profile on the machine; each
 * Host instance owns one namespace under `<root>/hosts/<hostKey>/` so the
 * Desktop app and the TUI cannot overwrite each other's socket, token, staging
 * records or audit log. The kill switch stays global at `<root>/DISABLED`.
 */
import { join } from 'node:path'
import { HOSTS_DIR_NAME, sanitizeHostKey } from '../../shared/src/index.ts'
import type { PluginConfig } from './config.ts'
import type { HostContext } from './host.ts'

export interface HostPaths {
  /** Root state directory (`config.stateDir`). */
  root: string
  /** Sanitized Host identity; equals the per-Host directory name. */
  hostKey: string
  /** Display label (defaults to `hostKey`). */
  hostLabel: string
  /** `<root>/hosts/<hostKey>` — staging/audit/socket/token/meta live here. */
  hostDir: string
  socketPath: string
  tokenPath: string
  stagingDir: string
  auditDir: string
  metaPath: string
  /** Global emergency stop (`<root>/DISABLED`), shared by every Host. */
  killSwitchPath: string
}

/** The config fields host-key resolution reads. */
export type HostKeyConfig = Pick<PluginConfig, 'hostKey'>
/** The config fields host-path resolution reads. */
export type HostPathsConfig = Pick<PluginConfig, 'stateDir' | 'hostKey' | 'hostLabel' | 'socketPath'>

interface ProfileContextView {
  name?: unknown
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Resolve the Host key: `config.hostKey` → `ctx.get('profileContext').name` →
 * `DSH_PROFILE` → `'default'`, sanitized to a file-name-safe slug.
 * A broken service lookup must never prevent the plugin from mounting.
 */
export function resolveHostKey(config: HostKeyConfig, ctx?: HostContext): string {
  const configured = nonEmptyString(config.hostKey)
  if (configured !== undefined) return sanitizeHostKey(configured)

  let profileName: unknown
  try {
    const profile = ctx?.get('profileContext') as ProfileContextView | string | undefined
    profileName = typeof profile === 'string' ? profile : profile?.name
  } catch {
    profileName = undefined
  }
  const fromProfile = nonEmptyString(profileName)
  if (fromProfile !== undefined) return sanitizeHostKey(fromProfile)

  const fromEnv = nonEmptyString(process.env['DSH_PROFILE'])
  if (fromEnv !== undefined) return sanitizeHostKey(fromEnv)
  return 'default'
}

/** Resolve every path this Host instance owns. */
export function resolveHostPaths(config: HostPathsConfig, ctx?: HostContext): HostPaths {
  const root = config.stateDir
  const hostKey = resolveHostKey(config, ctx)
  const hostLabel = nonEmptyString(config.hostLabel) ?? hostKey
  const hostDir = join(root, HOSTS_DIR_NAME, hostKey)
  return {
    root,
    hostKey,
    hostLabel,
    hostDir,
    socketPath: config.socketPath ?? join(hostDir, 'ipc.sock'),
    tokenPath: join(hostDir, 'token'),
    stagingDir: join(hostDir, 'staging'),
    auditDir: join(hostDir, 'audit'),
    metaPath: join(hostDir, 'meta.json'),
    killSwitchPath: join(root, 'DISABLED'),
  }
}
