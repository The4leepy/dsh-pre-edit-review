/**
 * ReviewCoordinator — the only orchestrator allowed to move a review from
 * "intercepted call" to "committed file".
 *
 * Intended flow (Phase 2):
 *   exec → workspace root → CommitTarget.prepare → proposal → StagingStore.create
 *        → IpcServer.request → decision
 *        → accept: restore line endings, CommitTarget.commit, post-execute notice
 *        → reject/timeout/cancel: synthetic error result, nothing written.
 *
 * This file stabilises the seams; Phase 2 supplies the body.
 */
import type { CommitTarget, FileSnapshot } from '../../shared/src/index.ts'
import type { PluginConfig } from './config.ts'
import type { HostContext, ToolExecutionResultView, ToolExecutionView } from './host.ts'
import type { IpcServer } from './ipc/server.ts'
import type { StagingStore } from './staging/store.ts'

export interface CoordinatorDeps {
  ctx: HostContext
  config: PluginConfig
  store: StagingStore
  ipc: IpcServer
  target: CommitTarget
}

export interface PreparedReview {
  snapshot: FileSnapshot
  displayContent: string
  proposedContent: string
}

export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED'
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

export class ReviewCoordinator {
  private readonly deps: CoordinatorDeps

  constructor(deps: CoordinatorDeps) {
    this.deps = deps
  }

  /**
   * Intercept one tool execution.
   *
   * Returns the synthetic `ToolExecutionResult` the registry should expose to
   * the model. Never calls the tool body; the only write path is
   * `CommitTarget.commit` after an `accept` decision.
   */
  async review(_exec: ToolExecutionView): Promise<ToolExecutionResultView> {
    throw new NotImplementedError('ReviewCoordinator.review lands in Phase 2 (M2)')
  }

  /** Read-only helpers that Phase 2 composes; kept here so the seam is explicit. */
  async prepareReview(_exec: ToolExecutionView): Promise<PreparedReview> {
    throw new NotImplementedError('prepareReview lands in Phase 2 (M2)')
  }
}

/** Build the synthetic success value a reviewed `write`/`edit` must return. */
export function successValueFor(
  toolName: string,
  path: string,
  operation: 'create' | 'update',
  before: string | null,
  after: string,
): Record<string, unknown> | string {
  switch (toolName) {
    case 'write':
      return { path, operation, before, after }
    case 'edit':
      return { path, before: before ?? '', after }
    case 'str_replace_editor':
      return 'The file has been updated successfully.'
    default:
      throw new Error(`no success value shape for tool "${toolName}"`)
  }
}

/** Build the synthetic failure result for reject/timeout/cancel/conflict. */
export function failureResult(message: string): ToolExecutionResultView {
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}
