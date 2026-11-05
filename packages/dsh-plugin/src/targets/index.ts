import type { CommitTarget, CommitTargetHost, CommitTargetKind } from '../../../shared/src/index.ts'
import type { HostContext } from '../host.ts'
import { DirectWorkspaceTarget } from './direct-workspace.ts'
import { GitWorktreeTarget } from './git-worktree.ts'

export { DirectWorkspaceTarget } from './direct-workspace.ts'
export { GitWorktreeTarget, NotImplementedError } from './git-worktree.ts'

/** Resolve one target implementation. Unknown kinds fail closed. */
export function createCommitTarget(kind: CommitTargetKind): CommitTarget {
  switch (kind) {
    case 'direct-workspace':
      return new DirectWorkspaceTarget()
    case 'git-worktree':
      return new GitWorktreeTarget()
    default:
      throw new Error(`unknown commit target kind: ${String(kind)}`)
  }
}

/**
 * Adapt the live Cordis context to the narrow `CommitTargetHost` seam.
 *
 * `cwd` is the session working directory resolved once per review; every path
 * is resolved against it and containment is enforced against the realpath root.
 */
export function createCommitTargetHost(ctx: HostContext, cwd: string): CommitTargetHost {
  return {
    resolve: (path, options) => ctx.fs.resolve(path, { cwd, signal: options?.signal }),
    contains: (parent, child) => ctx.fs.contains(parent, child),
    stat: (target, signal) => ctx.fs.stat(target, signal),
    readText: (target, signal) => ctx.fs.readText(target, signal),
    writeText: (target, content, expected, signal, sandboxPolicy) =>
      ctx.fs.writeText(target, content, expected, signal, sandboxPolicy),
    processPath: (target) => ctx.fs.processPath(target),
    observe: (target, version, actor) => {
      ctx.emit('fs/observed', target, { kind: 'present', version }, actor)
    },
    workspaceRoot: async () => cwd,
  }
}
