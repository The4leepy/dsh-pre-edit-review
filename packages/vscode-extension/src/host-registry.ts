/**
 * Host discovery for the multi-Host VS Code client (ADR 0002 §6).
 *
 * A 0.3.0 Host instance publishes one descriptor per instance at
 * `<rootStateDir>/hosts/<hostKey>/meta.json` (see `packages/shared/src/host.ts`)
 * and keeps its socket/token inside that directory. An old 0.2.x Host only has
 * the legacy root layout (`<rootStateDir>/ipc.sock` + `<rootStateDir>/token`).
 *
 * This module is deliberately **node-only** (no `vscode` import) so the
 * discovery rules — including the security checks — can be unit tested with the
 * plain Node test runner.
 *
 * Trust model: `meta.json` is read from a directory owned by the same user, but
 * it is still treated as untrusted input. Paths inside it must stay inside the
 * host directory, the key must equal the directory name, and a descriptor whose
 * pid is gone is ignored (the Host crashed without cleaning up).
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { HOSTS_DIR_NAME, isHostDescriptor, isHostKey } from '../../shared/src/host.ts'
import type { HostDescriptor } from '../../shared/src/host.ts'

/** Host key reserved for the legacy (pre-0.3.0) root layout. */
export const LEGACY_HOST_KEY = 'legacy'

/**
 * One discovered Host endpoint. `hostDir` is the directory the descriptor was
 * found in (the host's own staging/audit namespace, used as the IPC `stateDir`).
 */
export interface HostLink {
  key: string
  label: string
  /** True for the legacy root layout (`<stateDir>/ipc.sock` + `<stateDir>/token`). */
  legacy: boolean
  hostDir: string
  socketPath: string
  tokenPath: string
  pid?: number
  pluginVersion?: string
}

/**
 * Liveness probe for a descriptor pid.
 *
 * `process.kill(pid, 0)` sends no signal and only checks whether the process
 * exists: `ESRCH` means it is gone, `EPERM` means it exists but belongs to
 * another user (counts as alive — a Host could run under a different uid in a
 * container setup). Any other error is treated as "alive" so a transient probe
 * failure never hides a live Host.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code !== 'ESRCH'
  }
}

/** Resolve `candidate` and return it only when it is strictly inside `baseDir`. */
function resolveInside(baseDir: string, candidate: string): string | undefined {
  const base = resolve(baseDir)
  const target = resolve(candidate)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  if (!target.startsWith(prefix)) return undefined
  return target
}

/**
 * Symlink-aware containment: both paths must already be canonical (`realpath`).
 * `resolve()` alone cannot catch a symlink that points outside the Host dir.
 */
function isInsideRealDir(realBaseDir: string, realCandidate: string): boolean {
  const prefix = realBaseDir.endsWith(sep) ? realBaseDir : `${realBaseDir}${sep}`
  return realCandidate.startsWith(prefix)
}

/** True when the path exists and is a socket (or, leniently, a regular file). */
async function isSocketPath(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isSocket() || info.isFile()
  } catch {
    return false
  }
}

/** True when the path exists and is a regular file (the token is read as text). */
async function isTokenFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function readDescriptor(hostDir: string, directoryName: string): Promise<HostDescriptor | undefined> {
  let raw: string
  try {
    raw = await readFile(join(hostDir, 'meta.json'), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isHostDescriptor(parsed)) return undefined
  // The descriptor's key is part of the identity: it must match its directory.
  if (parsed.key !== directoryName) return undefined
  // A Host that crashed leaves its descriptor behind; the pid tells us.
  if (!isProcessAlive(parsed.pid)) return undefined
  return parsed
}

async function linkForHostDirectory(hostDir: string, directoryName: string): Promise<HostLink | undefined> {
  const descriptor = await readDescriptor(hostDir, directoryName)
  if (descriptor === undefined) return undefined
  const socketPath = resolveInside(hostDir, descriptor.socketPath)
  const tokenPath = resolveInside(hostDir, descriptor.tokenPath)
  if (socketPath === undefined || tokenPath === undefined) return undefined
  // `resolve()` is string-only; follow symlinks before trusting the descriptor.
  const realHostDir = await realpath(hostDir).catch(() => undefined)
  const realSocket = await realpath(socketPath).catch(() => undefined)
  const realToken = await realpath(tokenPath).catch(() => undefined)
  if (realHostDir === undefined || realSocket === undefined || realToken === undefined) return undefined
  if (!isInsideRealDir(realHostDir, realSocket) || !isInsideRealDir(realHostDir, realToken)) return undefined
  if (!(await isSocketPath(socketPath)) || !(await isTokenFile(tokenPath))) return undefined
  return {
    key: descriptor.key,
    label: descriptor.label,
    legacy: false,
    hostDir: resolve(hostDir),
    socketPath,
    tokenPath,
    pid: descriptor.pid,
    pluginVersion: descriptor.pluginVersion,
  }
}

function compareLinks(left: HostLink, right: HostLink): number {
  if (left.key < right.key) return -1
  if (left.key > right.key) return 1
  return 0
}

/**
 * Discover every Host reachable from `rootStateDir`: the per-Host namespaces
 * under `<rootStateDir>/hosts/*` plus the legacy root layout. Dead or malformed
 * descriptors are silently skipped (a stale Host must never break discovery).
 */
export async function discoverHostLinks(rootStateDir: string): Promise<HostLink[]> {
  const root = resolve(rootStateDir)
  const hostsDir = join(root, HOSTS_DIR_NAME)
  const links: HostLink[] = []
  const seen = new Set<string>()

  let entries: Dirent[] | undefined
  try {
    entries = await readdir(hostsDir, { withFileTypes: true })
  } catch {
    entries = undefined
  }
  if (entries !== undefined) {
    for (const entry of entries) {
      // Symlinks are skipped on purpose: only real per-Host directories count.
      if (!entry.isDirectory()) continue
      if (!isHostKey(entry.name)) continue
      const link = await linkForHostDirectory(join(hostsDir, entry.name), entry.name)
      if (link === undefined) continue
      if (seen.has(link.key)) continue
      seen.add(link.key)
      links.push(link)
    }
  }

  const legacySocket = join(root, 'ipc.sock')
  const legacyToken = join(root, 'token')
  const realRoot = await realpath(root).catch(() => undefined)
  const realLegacySocket = await realpath(legacySocket).catch(() => undefined)
  const realLegacyToken = await realpath(legacyToken).catch(() => undefined)
  if (
    !seen.has(LEGACY_HOST_KEY) &&
    realRoot !== undefined &&
    realLegacySocket !== undefined &&
    realLegacyToken !== undefined &&
    isInsideRealDir(realRoot, realLegacySocket) &&
    isInsideRealDir(realRoot, realLegacyToken) &&
    (await isSocketPath(legacySocket)) &&
    (await isTokenFile(legacyToken))
  ) {
    links.push({
      key: LEGACY_HOST_KEY,
      label: LEGACY_HOST_KEY,
      legacy: true,
      hostDir: root,
      socketPath: legacySocket,
      tokenPath: legacyToken,
    })
  }

  links.sort(compareLinks)
  return links
}
