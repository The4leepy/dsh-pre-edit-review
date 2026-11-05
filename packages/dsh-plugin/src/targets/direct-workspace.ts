/**
 * The only component allowed to write the user's working copy.
 *
 * `prepare` is read-only (stat → read → stat guards the version/content pair),
 * `commit` writes once under an explicit `workspace-write` policy with a CAS
 * precondition, and `inspect` is a read-only comparison used for crash
 * reconciliation. No other module may call `ctx.fs.writeText`.
 */
import { relative } from 'node:path'
import {
  CommitConflict,
  detectLineEndings,
  normalizeLineEndings,
  sha256Hex,
  type CommitPrecondition,
  type CommitResult,
  type CommitTarget,
  type CommitTargetHost,
  type FileSnapshot,
  type InspectResult,
  type ReviewMode,
} from '../../../shared/src/index.ts'

function versionOf(info: { version: unknown } | undefined): unknown {
  return info?.version
}

function fsCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function mapFsError(error: unknown): CommitConflict {
  const code = fsCode(error)
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'FS_STALE_VERSION':
    case 'FS_NOT_OBSERVED':
    case 'FS_SANDBOX_DENIED':
    case 'FS_NOT_TEXT':
      return new CommitConflict(code, message)
    default:
      return new CommitConflict('UNKNOWN', message)
  }
}

function displayPathOf(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath)
  return rel.length === 0 ? absolutePath : rel
}

export class DirectWorkspaceTarget implements CommitTarget {
  readonly kind = 'direct-workspace' as const

  async prepare(
    host: CommitTargetHost,
    requestedPath: string,
    signal: AbortSignal,
    options?: { mode?: ReviewMode },
  ): Promise<FileSnapshot> {
    const root = await host.workspaceRoot()
    const rootTarget = await host.resolve(root, { signal })
    const target = await host.resolve(requestedPath, { cwd: root, signal })
    if (!host.contains(rootTarget, target)) {
      throw new CommitConflict('OUT_OF_SCOPE', `path "${requestedPath}" is outside the session workspace`)
    }

    const first = await host.stat(target, signal)
    const raw = first === undefined ? null : await host.readText(target, signal)
    const second = await host.stat(target, signal)
    if (versionOf(first) !== versionOf(second)) {
      throw new CommitConflict('FS_STALE_VERSION', 'file changed while the proposal was being read; retry the read')
    }

    const absolutePath = host.processPath(target)
    const content = raw === null ? null : normalizeLineEndings(raw)
    return {
      displayPath: displayPathOf(root, absolutePath),
      absolutePath,
      exists: raw !== null,
      isNewFile: raw === null,
      content,
      sha256: content === null ? null : sha256Hex(content),
      version: second?.version,
      lineEndings: raw === null ? 'LF' : detectLineEndings(raw),
      mode: options?.mode ?? 'tool-level',
    }
  }

  async commit(
    host: CommitTargetHost,
    snapshot: FileSnapshot,
    finalContent: string,
    precondition: CommitPrecondition,
    signal: AbortSignal,
    actor?: unknown,
  ): Promise<CommitResult> {
    const root = await host.workspaceRoot()
    const rootTarget = await host.resolve(root, { signal })
    const target = await host.resolve(snapshot.absolutePath, { signal })
    if (!host.contains(rootTarget, target)) {
      throw new CommitConflict('OUT_OF_SCOPE', `path "${snapshot.absolutePath}" is outside the session workspace`)
    }

    let outcome
    try {
      outcome = await host.writeText(target, finalContent, precondition, signal, {
        mode: 'workspace-write',
        workspaceRoot: root,
      })
    } catch (error) {
      throw mapFsError(error)
    }

    host.observe(target, outcome.version, actor)
    return {
      ok: true,
      operation: outcome.operation,
      before: outcome.before,
      after: normalizeLineEndings(outcome.after),
      versionAfter: outcome.version,
    }
  }

  async inspect(host: CommitTargetHost, snapshot: FileSnapshot, signal: AbortSignal): Promise<InspectResult> {
    const target = await host.resolve(snapshot.absolutePath, { signal })
    const info = await host.stat(target, signal)
    if (info === undefined) return { exists: false, sha256: null, version: undefined }
    const raw = await host.readText(target, signal)
    const content = normalizeLineEndings(raw)
    return { exists: true, sha256: sha256Hex(content), version: info.version }
  }
}
