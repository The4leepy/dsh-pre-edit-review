/**
 * ReviewCoordinator — the only orchestrator allowed to move a review from
 * "intercepted call" to "committed file".
 *
 * Flow:
 *   exec → workspace root → CommitTarget.prepare → proposal → StagingStore.create
 *        → IpcServer.request → decision (handled inline, so the reply carries the
 *          real commit outcome) → synthetic ToolExecutionResult.
 *
 * Failure modes are fail-closed: any error, timeout, abort, missing client, or
 * CAS conflict returns an `isError` result and never writes the file.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  CommitConflict,
  normalizeLineEndings,
  randomHex,
  restoreLineEndings,
  sha256Hex,
  type CommitPrecondition,
  type CommitTarget,
  type CommitTargetHost,
  type FileSnapshot,
  type ReviewRecord,
  type ReviewRequestParams,
} from '../../shared/src/index.ts'
import type { PluginConfig } from './config.ts'
import type {
  HostContext,
  SandboxPolicyService,
  ToolExecutionResultView,
  ToolExecutionView,
  WorkingDirectoryService,
} from './host.ts'
import type { DecisionHandling, IpcServer, ReviewDecision } from './ipc/server.ts'
import type { StagingStore } from './staging/store.ts'
import { buildProposal, type ProposalResult } from './proposal.ts'

export type ReviewResult = ToolExecutionResultView | { passthrough: true }

export interface CoordinatorDeps {
  ctx: HostContext
  config: PluginConfig
  store: StagingStore
  ipc: IpcServer
  target: CommitTarget
  createHost(cwd: string): CommitTargetHost
}

type AcceptedProposal = Extract<ProposalResult, { ok: true }>

interface ReviewContext {
  requestId: string
  exec: ToolExecutionView
  snapshot: FileSnapshot
  proposal: AcceptedProposal
  host: CommitTargetHost
  record: ReviewRecord
  toolResult?: ToolExecutionResultView
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The tool argument that names the target path (DSH 0.2.1-rc.5 tool set). */
export function pathArgument(toolName: string): string | undefined {
  switch (toolName) {
    case 'write':
    case 'edit':
      return 'file_path'
    case 'str_replace_editor':
      return 'path'
    default:
      return undefined
  }
}

/** Build the synthetic success value a reviewed tool must return. */
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
      return operation === 'create'
        ? `New file created successfully at: ${path}`
        : `The file ${path} has been edited successfully.`
    default:
      throw new Error(`no success value shape for tool "${toolName}"`)
  }
}

export function failureResult(message: string): ToolExecutionResultView {
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}

export class ReviewCoordinator {
  private readonly deps: CoordinatorDeps
  private readonly contexts = new Map<string, ReviewContext>()
  private readonly notices = new WeakMap<object, string>()
  private ready: Promise<void> = Promise.resolve()

  constructor(deps: CoordinatorDeps) {
    this.deps = deps
  }

  /** Runtime wiring supplies the async initialisation (directory + socket). */
  setReady(ready: Promise<void>): void {
    this.ready = ready
  }

  get pendingCount(): number {
    return this.contexts.size
  }

  get ipcConnected(): boolean {
    return this.deps.ipc.connected
  }

  /** Status snapshot for the `/review` command. */
  status(): { connected: boolean; pending: number; stateDir: string; socketPath: string; mode: string } {
    return {
      connected: this.deps.ipc.connected,
      pending: this.contexts.size,
      stateDir: this.deps.config.stateDir,
      socketPath: this.deps.config.socketPath,
      mode: this.deps.config.mode,
    }
  }

  /** Consume the one-shot model notice attached to a committed report. */
  takeNotice(exec: object): string | undefined {
    const notice = this.notices.get(exec)
    if (notice !== undefined) this.notices.delete(exec)
    return notice
  }

  // -------------------------------------------------------------------------
  // Interception
  // -------------------------------------------------------------------------

  async review(exec: ToolExecutionView): Promise<ReviewResult> {
    try {
      await this.ready
    } catch (error) {
      return failureResult(`pre-edit review is unavailable: ${messageOf(error)}; the file was NOT modified`)
    }

    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const argName = pathArgument(exec.name)
    const requestedPath = argName === undefined ? undefined : args[argName]
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      return failureResult(`pre-edit review cannot locate the target path for tool "${exec.name}"; the file was NOT modified`)
    }

    let cwd: string
    try {
      cwd = await this.resolveCwd(exec)
    } catch (error) {
      return failureResult(
        `pre-edit review cannot resolve the session workspace: ${messageOf(error)}; the file was NOT modified`,
      )
    }

    const mode = this.resolveMode(exec)
    const host = this.deps.createHost(cwd)

    let snapshot: FileSnapshot
    try {
      snapshot = await this.deps.target.prepare(host, requestedPath, exec.signal, { mode })
    } catch (error) {
      if (error instanceof CommitConflict) {
        return failureResult(`pre-edit review refused "${requestedPath}": ${error.message}; the file was NOT modified`)
      }
      return failureResult(
        `pre-edit review could not read "${requestedPath}": ${messageOf(error)}; the file was NOT modified`,
      )
    }

    const proposal = buildProposal({
      toolName: exec.name,
      args,
      snapshot,
      maxFileBytes: this.deps.config.maxFileBytes,
    })
    if (!proposal.ok) {
      if ('passthrough' in proposal) return { passthrough: true }
      return failureResult(proposal.reason)
    }

    const requestId = randomUUID()
    const nonce = randomHex(32)
    const now = Date.now()
    const session = exec.agent?.session
    const hint = languageHintFor(snapshot.displayPath)
    const record: ReviewRecord = {
      requestId,
      nonce,
      protocolVersion: 1,
      createdAt: now,
      expiresAt: now + this.deps.config.approvalTimeoutMs,
      sessionId: String(session?.id ?? 'unknown'),
      sessionLabel: `${basename(cwd)}#${String(session?.id ?? 'unknown').slice(0, 8)}`,
      ...(exec.agent?.id !== undefined ? { agentId: String(exec.agent.id) } : {}),
      workspaceRoot: cwd,
      toolName: exec.name,
      callId: String(exec.callId),
      operation: proposal.operation,
      targetKind: this.deps.target.kind,
      displayPath: snapshot.displayPath,
      absolutePath: snapshot.absolutePath,
      before: snapshot.content,
      beforeSha256: snapshot.sha256,
      proposed: proposal.displayContent,
      proposedSha256: sha256Hex(proposal.proposedContent),
      lineEndings: snapshot.lineEndings,
      mode,
      state: 'pending',
    }

    await this.deps.store.create(record)
    const entry: ReviewContext = { requestId, exec, snapshot, proposal, host, record }
    this.contexts.set(requestId, entry)

    const params: ReviewRequestParams = {
      requestId,
      nonce,
      protocolVersion: 1,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      sessionId: record.sessionId,
      sessionLabel: record.sessionLabel,
      toolName: exec.name,
      callId: record.callId,
      operation: proposal.operation,
      displayPath: record.displayPath,
      absolutePath: record.absolutePath,
      isNewFile: snapshot.isNewFile,
      ...(hint !== undefined ? { languageHint: hint } : {}),
      before: snapshot.content,
      after: proposal.displayContent,
      beforeSha256: record.beforeSha256,
      afterSha256: record.proposedSha256,
      targetKind: record.targetKind,
      mode,
    }

    try {
      const connected = await this.deps.ipc.waitForClient(this.deps.config.clientConnectTimeoutMs, exec.signal)
      if (!connected) {
        if (this.deps.config.fallback === 'dsh-approval') return await this.fallbackApproval(entry)
        await this.transitionSafe(entry, 'expired', 'NO_CLIENT')
        return failureResult(
          'Pre-edit review needs VS Code, but no review client is connected. The file was NOT modified. ' +
            'Open VS Code with the DeepSeek Pre-edit Review extension and retry the same edit.',
        )
      }

      const result = await this.deps.ipc.request(params, {
        timeoutMs: this.deps.config.approvalTimeoutMs,
        signal: exec.signal,
      })
      return (
        entry.toolResult ??
        failureResult(`pre-edit review finished as "${result.outcome}" without a tool result; the file was NOT modified`)
      )
    } catch (error) {
      const aborted = exec.signal.aborted
      await this.transitionSafe(entry, aborted ? 'cancelled' : 'expired', aborted ? 'CANCELLED' : 'REVIEW_FAILED')
      return failureResult(
        `pre-edit review did not complete (${messageOf(error)}); the file was NOT modified. ` +
          'Re-read the file and retry if the change is still required.',
      )
    } finally {
      this.contexts.delete(requestId)
    }
  }

  // -------------------------------------------------------------------------
  // Decision handling (invoked by the IPC server while replying to a decision)
  // -------------------------------------------------------------------------

  async handleDecision(decision: ReviewDecision): Promise<DecisionHandling> {
    const entry = this.contexts.get(decision.requestId)
    if (entry === undefined) return { outcome: 'already-decided' }
    if (entry.record.state !== 'pending') return { outcome: 'already-decided' }

    if (decision.status === 'reject') {
      await this.transitionSafe(entry, 'rejected', undefined, {
        status: 'reject',
        by: decision.by,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        decidedAt: Date.now(),
      })
      entry.toolResult = failureResult(
        `The user rejected the proposed edit to "${entry.record.displayPath}". The file was NOT modified. ` +
          (decision.reason === undefined || decision.reason.length === 0
            ? 'Ask what should change before proposing again.'
            : `User reason: ${decision.reason}`),
      )
      await this.audit({ event: 'review/rejected', requestId: entry.requestId, displayPath: entry.record.displayPath })
      return { outcome: 'rejected' }
    }

    const finalDisplay = decision.finalContent ?? entry.proposal.displayContent
    const edited = finalDisplay !== entry.proposal.displayContent
    const finalContent = edited
      ? restoreLineEndings(finalDisplay, entry.snapshot.lineEndings)
      : entry.proposal.proposedContent

    await this.deps.store.transition(entry.requestId, 'decided', {
      decision: {
        status: 'accept',
        by: decision.by,
        finalContentSha256: sha256Hex(finalContent),
        decidedAt: Date.now(),
      },
    })
    entry.record = (await this.deps.store.get(entry.requestId)) ?? entry.record

    const precondition: CommitPrecondition = entry.snapshot.exists
      ? { kind: 'replaceIfVersion', version: entry.snapshot.version }
      : { kind: 'createIfAbsent' }

    try {
      const commit = await this.deps.target.commit(
        entry.host,
        entry.snapshot,
        finalContent,
        precondition,
        entry.exec.signal,
        entry.exec,
      )
      await this.deps.store.transition(entry.requestId, 'committed', { commit: { at: Date.now() } })
      entry.record = (await this.deps.store.get(entry.requestId)) ?? entry.record
      entry.toolResult = {
        isError: false,
        value: successValueFor(
          entry.record.toolName,
          entry.snapshot.absolutePath,
          commit.operation,
          entry.snapshot.content,
          commit.after,
        ),
      }
      if (edited && this.deps.config.noticeOnUserEdit) {
        this.notices.set(
          entry.exec,
          `[pre-edit-review] The user EDITED the proposal before accepting. The file on disk is the user's final version, ` +
            `not your original proposal; before making further changes, re-read "${entry.record.displayPath}".`,
        )
      }
      await this.audit({
        event: 'review/committed',
        requestId: entry.requestId,
        displayPath: entry.record.displayPath,
        edited,
        finalSha256: sha256Hex(normalizeLineEndings(finalContent)),
      })
      return { outcome: 'committed' }
    } catch (error) {
      if (error instanceof CommitConflict) {
        await this.transitionSafe(entry, 'conflict', error.code, undefined, { code: error.code, message: error.message })
        entry.toolResult = failureResult(
          `The file "${entry.record.displayPath}" changed while it was being approved, so the approved change was NOT written ` +
            `(${error.code}: ${error.message}). Re-read the file and propose the change again against the current content.`,
        )
        await this.audit({ event: 'review/conflict', requestId: entry.requestId, code: error.code })
        return { outcome: 'conflict', detail: { code: error.code, message: error.message } }
      }
      await this.transitionSafe(entry, 'failed', 'COMMIT_FAILED')
      entry.toolResult = failureResult(
        `pre-edit review could not write "${entry.record.displayPath}": ${messageOf(error)}. The file was NOT modified.`,
      )
      await this.audit({ event: 'review/failed', requestId: entry.requestId })
      return { outcome: 'failed', detail: { message: messageOf(error) } }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async fallbackApproval(entry: ReviewContext): Promise<ReviewResult> {
    const approval = this.deps.ctx.get('approval') as
      | { request(input: Record<string, unknown>): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> }
      | undefined
    if (approval === undefined) {
      await this.transitionSafe(entry, 'expired', 'NO_CLIENT')
      return failureResult('Pre-edit review needs VS Code and no approval channel is available; the file was NOT modified.')
    }
    let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    try {
      outcome = await approval.request({
        ...(entry.exec.agent !== undefined ? { agent: entry.exec.agent } : {}),
        toolName: entry.record.toolName,
        callId: entry.record.callId,
        reason: `pre-edit review (VS Code offline): allow the change to ${entry.record.displayPath}?`,
        signal: entry.exec.signal,
      })
    } catch (error) {
      await this.transitionSafe(entry, 'failed', 'FALLBACK_UNAVAILABLE')
      return failureResult(`pre-edit review fallback approval failed: ${messageOf(error)}; the file was NOT modified`)
    }
    if (outcome !== 'allowed-once') {
      await this.transitionSafe(entry, outcome === 'cancelled' ? 'cancelled' : 'rejected', 'FALLBACK_DENIED')
      return failureResult(
        'The user did not approve the change through the fallback approval channel; the file was NOT modified.',
      )
    }
    const precondition: CommitPrecondition = entry.snapshot.exists
      ? { kind: 'replaceIfVersion', version: entry.snapshot.version }
      : { kind: 'createIfAbsent' }
    try {
      const commit = await this.deps.target.commit(
        entry.host,
        entry.snapshot,
        entry.proposal.proposedContent,
        precondition,
        entry.exec.signal,
        entry.exec,
      )
      await this.transitionSafe(entry, 'committed')
      return {
        isError: false,
        value: successValueFor(
          entry.record.toolName,
          entry.snapshot.absolutePath,
          commit.operation,
          entry.snapshot.content,
          commit.after,
        ),
      }
    } catch (error) {
      await this.transitionSafe(entry, 'conflict', error instanceof CommitConflict ? error.code : 'COMMIT_FAILED')
      return failureResult(`pre-edit review could not write "${entry.record.displayPath}": ${messageOf(error)}`)
    }
  }

  private async transitionSafe(
    entry: ReviewContext,
    next: ReviewRecord['state'],
    code?: string,
    decision?: ReviewRecord['decision'],
    commit?: ReviewRecord['commit'],
  ): Promise<void> {
    try {
      entry.record = await this.deps.store.transition(entry.requestId, next, {
        ...(decision !== undefined ? { decision } : {}),
        ...(commit !== undefined || code !== undefined
          ? { commit: { at: Date.now(), ...(code !== undefined ? { code } : {}), ...commit } }
          : {}),
      })
    } catch (error) {
      this.deps.ctx.logger?.warn(`[pre-edit-review] state transition to ${next} failed: ${messageOf(error)}`)
    }
  }

  private async audit(event: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.store.audit(event)
    } catch {
      // Auditing must never break the review path.
    }
  }

  private async resolveCwd(exec: ToolExecutionView): Promise<string> {
    const workingDirectory = this.deps.ctx.get('workingDirectory') as WorkingDirectoryService | undefined
    if (workingDirectory !== undefined && exec.agent !== undefined) {
      return await workingDirectory.ensure(exec.agent, exec.signal)
    }
    return process.cwd()
  }

  private resolveMode(exec: ToolExecutionView): 'tool-level' | 'strict' {
    const policy = this.deps.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    if (policy === undefined) return 'tool-level'
    try {
      const resolved = policy.resolve({ ...(exec.agent?.session !== undefined ? { session: exec.agent.session } : {}) })
      return resolved.mode === 'read-only' ? 'strict' : 'tool-level'
    } catch {
      return 'tool-level'
    }
  }
}

/** Cheap extension-based language hint; the extension re-derives it from the left document. */
export function languageHintFor(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = path.slice(dot + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shellscript',
    toml: 'toml',
    sql: 'sql',
    xml: 'xml',
  }
  return map[ext]
}
