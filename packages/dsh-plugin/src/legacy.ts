/**
 * Retired 0.2.x root layout cleanup.
 *
 * Before ADR 0002 every Host used `<stateDir>/ipc.sock` + `<stateDir>/token`.
 * After a 0.3.0 upgrade those files are stale, but the VS Code extension still
 * offers them as a `legacy` Host, which shows up as a permanent offline entry.
 * A 0.3.0 Host removes the stale pair on start — but only when nothing answers
 * on the socket, so a still-running 0.2.x Host is never disturbed.
 */
import { stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { probeSocketPath } from './ipc/server.ts'

export interface LegacyCleanup {
  socketRemoved: boolean
  tokenRemoved: boolean
}

const NOTHING: LegacyCleanup = { socketRemoved: false, tokenRemoved: false }

/** Remove a dead 0.2.x root socket/token pair; never touch a live one. */
export async function cleanupLegacyRoot(root: string): Promise<LegacyCleanup> {
  const socketPath = join(root, 'ipc.sock')
  try {
    await stat(socketPath)
  } catch {
    return NOTHING
  }
  if (await probeSocketPath(socketPath)) return NOTHING
  const socketRemoved = await unlink(socketPath).then(
    () => true,
    () => false,
  )
  if (!socketRemoved) return NOTHING
  const tokenRemoved = await unlink(join(root, 'token')).then(
    () => true,
    () => false,
  )
  return { socketRemoved, tokenRemoved }
}
