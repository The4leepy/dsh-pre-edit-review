/**
 * Host descriptor registry (`<hostDir>/meta.json`, ADR 0002 §3).
 *
 * The descriptor is discovery metadata for the VS Code extension: it names the
 * Host, its PID, and the real socket/token paths. It never contains the token
 * itself. The write is atomic (temp 0600 + rename) so a concurrent discovery
 * scan never observes a torn JSON document; a clean stop removes it, and a
 * crashed Host leaves a stale descriptor the client prunes by pid liveness.
 */
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isHostDescriptor, randomHex, type HostDescriptor } from '../../shared/src/index.ts'

async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomHex(6)}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
  await chmod(path, 0o600).catch(() => undefined)
}

/** Atomically publish the HostDescriptor; rejects an invalid descriptor. */
export async function writeHostDescriptor(metaPath: string, descriptor: HostDescriptor): Promise<void> {
  if (!isHostDescriptor(descriptor)) {
    throw new Error(`pre-edit review: refusing to write an invalid HostDescriptor to ${metaPath}`)
  }
  await writeAtomically(metaPath, `${JSON.stringify(descriptor, null, 2)}\n`)
}

/**
 * The parts of a descriptor that identify one Host *instance*.
 * `pid` + `startedAt` stay unique across in-process reloads (HMR) because the
 * start timestamp is regenerated per runtime.
 */
export type HostDescriptorOwner = Pick<HostDescriptor, 'key' | 'pid' | 'startedAt' | 'instanceId'>

/** Read the on-disk descriptor; malformed or missing means `undefined`. */
export async function readHostDescriptor(metaPath: string): Promise<HostDescriptor | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf8'))
    return isHostDescriptor(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function sameOwner(current: HostDescriptor, expected: HostDescriptorOwner): boolean {
  if (expected.instanceId !== undefined && current.instanceId !== undefined) {
    return current.key === expected.key && current.instanceId === expected.instanceId
  }
  return current.key === expected.key && current.pid === expected.pid && current.startedAt === expected.startedAt
}

/**
 * Remove the descriptor on a clean stop (missing file = already gone).
 *
 * With `expected`, the removal is ownership-checked: a stopping instance must
 * never delete the descriptor that a newer instance of the same profile has
 * already published (reload/HMR or a fast restart overlap). Returns whether a
 * matching descriptor was removed.
 */
export async function removeHostDescriptor(metaPath: string, expected?: HostDescriptorOwner): Promise<boolean> {
  if (expected !== undefined) {
    const current = await readHostDescriptor(metaPath)
    if (current === undefined || !sameOwner(current, expected)) return false
  }
  try {
    await unlink(metaPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
