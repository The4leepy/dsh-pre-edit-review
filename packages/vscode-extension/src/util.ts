/**
 * Small dependency-free helpers shared by the extension modules.
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/** Expand a leading `~` and make relative paths relative to the home directory. */
export function expandHome(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2))
  if (trimmed.length === 0) return resolve(homedir(), '.dsh/pre-edit-review')
  return isAbsolute(trimmed) ? trimmed : resolve(homedir(), trimmed)
}

/** Basename for both POSIX and Windows display paths (`src\a\b.ts` too). */
export function basenameOf(displayPath: string): string {
  const parts = displayPath.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? ''
  return last.length > 0 ? last : 'review.txt'
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Default lifetime of a transient status-bar message. */
export const DEFAULT_MESSAGE_DURATION_MS = 5000

/** Clamp a user-configured status-bar message duration to 1s..30s. */
export function clampMessageDuration(value: unknown, fallback = DEFAULT_MESSAGE_DURATION_MS): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(30_000, Math.max(1_000, Math.round(value)))
}
