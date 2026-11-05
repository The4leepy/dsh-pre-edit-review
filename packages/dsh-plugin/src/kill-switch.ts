/**
 * Emergency kill switch.
 *
 * While `<stateDir>/DISABLED` exists the plugin is inert: the gate passes every
 * tool call through untouched. This is the recovery path for a misbehaving
 * plugin (see the T9 risk in the implementation plan); it must be cheap, so the
 * file check is cached for ~1 s.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface KillSwitch {
  active(): boolean
  path: string
}

export function createKillSwitch(stateDir: string, cacheMs = 1_000, now: () => number = () => Date.now()): KillSwitch {
  const path = join(stateDir, 'DISABLED')
  let checkedAt = -Infinity
  let active = false
  return {
    path,
    active(): boolean {
      const at = now()
      if (at - checkedAt >= cacheMs) {
        checkedAt = at
        try {
          active = existsSync(path)
        } catch {
          // An unreadable state directory must not brick tool calls; treat the
          // switch as inactive so the normal gate logic (which fails closed on
          // its own errors) still applies.
          active = false
        }
      }
      return active
    },
  }
}
