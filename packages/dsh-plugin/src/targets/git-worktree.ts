/**
 * Reserved implementation: agent works in an isolated Git worktree, and an
 * accepted proposal is promoted into the original checkout.
 *
 * Not implemented this phase (user requirement 9). It must keep the same
 * interface and factory shape as `DirectWorkspaceTarget` so the coordinator,
 * IPC, staging store, and VS Code UI need no changes when it lands.
 */
import type {
  CommitPrecondition,
  CommitResult,
  CommitTarget,
  CommitTargetHost,
  FileSnapshot,
  InspectResult,
  ReviewMode,
} from '../../../shared/src/index.ts'

export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED'
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

const MESSAGE =
  'GitWorktreeTarget is reserved for the isolated-worktree architecture and is not implemented in this release'

export class GitWorktreeTarget implements CommitTarget {
  readonly kind = 'git-worktree' as const

  async prepare(
    _host: CommitTargetHost,
    _requestedPath: string,
    _signal: AbortSignal,
    _options?: { mode?: ReviewMode },
  ): Promise<FileSnapshot> {
    throw new NotImplementedError(MESSAGE)
  }

  async commit(
    _host: CommitTargetHost,
    _snapshot: FileSnapshot,
    _finalContent: string,
    _precondition: CommitPrecondition,
    _signal: AbortSignal,
    _actor?: unknown,
  ): Promise<CommitResult> {
    throw new NotImplementedError(MESSAGE)
  }

  async inspect(_host: CommitTargetHost, _snapshot: FileSnapshot, _signal: AbortSignal): Promise<InspectResult> {
    throw new NotImplementedError(MESSAGE)
  }
}
