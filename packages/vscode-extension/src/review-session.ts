/**
 * One review session = one UDS connection + the pending review queue.
 *
 * The session owns the editable `vscode.diff` for every pending request and
 * turns the user's Accept/Reject into a protocol `decision` request. It is
 * deliberately instantiable more than once so the in-process self-test can run
 * a session against a mock Host while the real one stays untouched.
 */

import * as vscode from 'vscode'

import { METHODS, RPC_ERRORS, reviewPaused } from '../../shared/src/protocol.ts'
import type {
  DecisionParams,
  DecisionResult,
  ReviewCancelParams,
  ReviewModeParams,
  ReviewRequestParams,
  ReviewStateParams,
  ServerNotification,
  ServerShutdownParams,
} from '../../shared/src/protocol.ts'
import { isTerminal } from '../../shared/src/review-record.ts'
import type { DecisionOutcome, ReviewState } from '../../shared/src/review-record.ts'
import {
  DPR_SCHEME,
  emptyOriginalUriFor,
  proposalUriFor,
  requestIdOfPath,
  type DprFileSystemProvider,
} from './fs-provider.ts'
import { IpcClient, IpcRpcError, type IpcConnectionInfo } from './ipc-client.ts'
import type { Messages } from './i18n.ts'
import { delay, describeError } from './util.ts'

export interface DecisionCommandArg {
  requestId?: string
  reason?: string
  /** Skip the reject-reason input box (used by the automated self-test). */
  skipPrompt?: boolean
}

export type ReviewCommandArg = string | DecisionCommandArg | undefined

export interface ReviewSessionOptions {
  stateDir: string
  socketPath?: string
  clientVersion: string
  messages: Messages
  provider: DprFileSystemProvider
  /** Suppress informational toasts (warnings/errors are still shown). */
  quiet?: boolean
  onStateChanged?(): void
  /** Called once per settled decision so the extension can append history. */
  onSettled?(record: SettledReview): void
  onConnectionChanged?(info: IpcConnectionInfo): void
  /** Route transient messages to the host UI (status-bar flash) instead of native toasts. */
  onTransientMessage?(message: string, severity: 'info' | 'warning' | 'error'): void
  onLog?(message: string): void
}

export interface PendingReview {
  readonly params: ReviewRequestParams
  readonly proposalUri: vscode.Uri
  readonly originalUri: vscode.Uri
  readonly openedAt: number
}

/**
 * One settled decision, emitted for the decision-history view. This stays
 * protocol-agnostic: the extension maps `outcome` to a history status.
 */
export interface SettledReview {
  requestId: string
  displayPath: string
  toolName: string
  mode: string
  outcome: string
  /** True when the accepted content differed from the agent's proposal. */
  edited: boolean
  at: number
}

interface PendingPickItem extends vscode.QuickPickItem {
  review: PendingReview
}

interface AwaitingOutcome {
  params: ReviewRequestParams
  edited: boolean
  timer: NodeJS.Timeout
}

type AutoAcceptDisarmReason = 'toggled' | 'expired' | 'disconnect' | 'shutdown' | 'rejectAll' | 'disposed'

const AUTO_ACCEPT_WINDOW_MS = 5 * 60 * 1000
const DOC_OPEN_TIMEOUT_MS = 6000
const WAIT_OUTCOME_MS = 2 * 60 * 1000

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<string>([
  'committed',
  'rejected',
  'conflict',
  'expired',
  'cancelled',
  'already-decided',
  'failed',
])

export class ReviewSession {
  private readonly options: ReviewSessionOptions
  private readonly messages: Messages
  private readonly provider: DprFileSystemProvider
  private readonly client: IpcClient
  private readonly pending = new Map<string, PendingReview>()
  private readonly deciding = new Set<string>()
  private readonly awaitingOutcome = new Map<string, AwaitingOutcome>()
  private autoAcceptTimer: NodeJS.Timeout | undefined
  private autoAcceptUntil: number | undefined
  private reviewPausedState = false
  private disposed = false
  /** One onboarding hint per VS Code session; decisions live on the title bar. */
  private firstHintShown = false

  constructor(options: ReviewSessionOptions) {
    this.options = options
    this.messages = options.messages
    this.provider = options.provider
    this.client = new IpcClient({
      stateDir: options.stateDir,
      ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
      clientVersion: options.clientVersion,
      onNotification: (notification): void => this.onNotification(notification),
      onConnectionChanged: (info): void => this.onConnectionChanged(info),
      log: (message): void => this.log(message),
    })
  }

  // -- lifecycle ----------------------------------------------------------

  start(): void {
    this.client.start()
  }

  reconnect(): void {
    if (this.disposed) return
    this.client.reconnect()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disarmAutoAccept('disposed')
    this.clearPending()
    this.clearAwaitingOutcomes()
    this.client.stop()
  }

  // -- read-only state ----------------------------------------------------

  get connected(): boolean {
    return this.client.connected
  }

  get stateDir(): string {
    return this.options.stateDir
  }

  get socketPath(): string {
    return this.client.endpoint
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get autoAcceptArmed(): boolean {
    return this.autoAcceptTimer !== undefined
  }

  /** True when the Host reported that review is paused for some live session. */
  get reviewPaused(): boolean {
    return this.reviewPausedState
  }

  get autoAcceptDeadline(): number | undefined {
    return this.autoAcceptUntil
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  pendingList(): readonly PendingReview[] {
    return [...this.pending.values()]
  }

  // -- commands -----------------------------------------------------------

  async accept(arg?: ReviewCommandArg): Promise<void> {
    if (this.disposed) return
    const review = this.resolveTarget(arg)
    if (review === undefined) {
      this.showInfo(this.messages.noPendingReview)
      return
    }
    const requestId = review.params.requestId
    if (this.deciding.has(requestId)) return
    this.deciding.add(requestId)
    const finalContent = this.finalContentFor(review)
    let reply: DecisionResult
    try {
      reply = await this.sendDecision({
        requestId,
        nonce: review.params.nonce,
        status: 'accept',
        finalContent,
      })
    } catch (error) {
      this.deciding.delete(requestId)
      this.log(`accept failed: ${describeError(error)}`)
      this.showWarning(this.messages.decisionFailed(review.params.displayPath, describeError(error)))
      return
    }
    this.deciding.delete(requestId)
    await this.finalizeProposal(review)
    this.removePending(requestId)
    this.notifyOutcome(review.params, reply, finalContent !== review.params.after)
  }

  async reject(arg?: ReviewCommandArg): Promise<void> {
    if (this.disposed) return
    const review = this.resolveTarget(arg)
    if (review === undefined) {
      this.showInfo(this.messages.noPendingReview)
      return
    }
    const objectArg = typeof arg === 'object' && arg !== null ? arg : undefined
    const requestId = review.params.requestId

    let reason: string | undefined
    if (objectArg?.reason !== undefined) {
      reason = objectArg.reason.trim()
    } else if (objectArg?.skipPrompt !== true) {
      const input = await vscode.window.showInputBox({
        prompt: this.messages.rejectReasonPrompt,
        placeHolder: this.messages.rejectReasonPlaceholder,
        value: '',
        ignoreFocusOut: true,
      })
      if (input === undefined) return // the user cancelled the reason prompt
      reason = input.trim()
    }
    if (this.pending.get(requestId) !== review) return
    if (this.deciding.has(requestId)) return
    this.deciding.add(requestId)

    let reply: DecisionResult
    try {
      const params: DecisionParams = {
        requestId,
        nonce: review.params.nonce,
        status: 'reject',
        ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
      }
      reply = await this.sendDecision(params)
    } catch (error) {
      this.deciding.delete(requestId)
      this.log(`reject failed: ${describeError(error)}`)
      this.showWarning(this.messages.decisionFailed(review.params.displayPath, describeError(error)))
      return
    }
    this.deciding.delete(requestId)
    await this.revertProposal(review)
    await this.closeDiffTab(review.proposalUri)
    this.removePending(requestId)
    this.notifyOutcome(review.params, reply, false)
  }

  async showPending(): Promise<void> {
    if (this.disposed) return
    if (this.pending.size === 0) {
      this.showInfo(this.messages.noPendingReview)
      return
    }
    const items: PendingPickItem[] = this.pendingList().map((review) => ({
      label: `$(file) ${review.params.displayPath}`,
      description: this.messages.pendingPickDescription(review.params.mode, review.params.toolName),
      detail: review.params.absolutePath,
      review,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: this.messages.pendingPickPlaceholder,
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    })
    if (picked === undefined) return
    if (!this.pending.has(picked.review.params.requestId)) return
    await this.openDiff(picked.review)
  }

  /**
   * Open the diff for one specific pending request (pending-tree row click).
   * Reuses `resolveTarget`/`openDiff` so behaviour matches the editor command,
   * and repeats the M2.1 prompt so the title-bar decision buttons stay
   * discoverable after the first review.
   */
  async openReview(requestId: string): Promise<void> {
    if (this.disposed) return
    const review = this.resolveTarget(requestId)
    if (review === undefined || review.params.requestId !== requestId) {
      this.showInfo(this.messages.noPendingReview)
      return
    }
    await this.openDiff(review)
    if (this.options.quiet === true) return
    this.showInfo(this.messages.reopenReviewHint(review.params.displayPath))
  }

  /**
   * Reject every currently pending review, sequentially. Per-item failures are
   * ignored (the individual `reject` call already warns) and the queue is left
   * untouched for anything that could not be settled. Disarms auto-accept so a
   * later request cannot slip through unread while the queue is being drained.
   */
  async rejectAll(): Promise<void> {
    if (this.disposed) return
    if (this.autoAcceptArmed) this.disarmAutoAccept('rejectAll')
    const targets = [...this.pending.keys()]
    if (targets.length === 0) {
      this.showInfo(this.messages.noPendingReview)
      return
    }
    let rejected = 0
    for (const requestId of targets) {
      if (this.disposed) break
      if (!this.pending.has(requestId)) continue
      try {
        await this.reject({ requestId, reason: '', skipPrompt: true })
      } catch (error) {
        this.log(`rejectAll: ${requestId} threw unexpectedly: ${describeError(error)}`)
      }
      if (!this.pending.has(requestId)) rejected += 1
    }
    this.notifyStateChanged()
    this.showInfo(this.messages.rejectAllSummary(rejected, targets.length, this.pending.size))
  }

  async acceptAll(): Promise<void> {
    if (this.disposed) return
    if (this.autoAcceptArmed) {
      this.disarmAutoAccept('toggled')
      return
    }
    const enabled = vscode.workspace.getConfiguration('dpr').get<boolean>('autoAccept', false)
    if (enabled !== true) {
      this.showWarning(this.messages.autoAcceptDisabled)
      return
    }
    const confirmed = await vscode.window.showWarningMessage(
      this.messages.autoAcceptConfirm,
      { modal: true },
      this.messages.autoAcceptConfirmYes,
    )
    if (confirmed !== this.messages.autoAcceptConfirmYes || this.disposed) return
    this.autoAcceptUntil = Date.now() + AUTO_ACCEPT_WINDOW_MS
    this.autoAcceptTimer = setTimeout(() => {
      this.disarmAutoAccept('expired')
    }, AUTO_ACCEPT_WINDOW_MS)
    this.log('auto-accept armed for 5 minutes')
    this.showInfo(this.messages.autoAcceptArmed(AUTO_ACCEPT_WINDOW_MS / 60_000))
    this.notifyStateChanged()
  }

  // -- notifications ------------------------------------------------------

  private onNotification(notification: ServerNotification): void {
    switch (notification.method) {
      case METHODS.reviewRequest:
        void this.onReviewRequest(notification.params)
        return
      case METHODS.reviewCancel:
        this.onReviewCancel(notification.params)
        return
      case METHODS.reviewState:
        this.onReviewState(notification.params)
        return
      case METHODS.reviewMode:
        this.onReviewMode(notification.params)
        return
      case METHODS.serverShutdown:
        this.onServerShutdown(notification.params)
        return
      default:
        return
    }
  }

  private onReviewMode(params: ReviewModeParams): void {
    const paused = reviewPaused(params)
    if (this.reviewPausedState === paused) return
    this.reviewPausedState = paused
    this.log(`review ${paused ? 'paused' : 'resumed'} by the Host`)
    this.notifyStateChanged()
  }

  private async onReviewRequest(params: ReviewRequestParams): Promise<void> {
    if (this.disposed) return
    if (this.pending.has(params.requestId)) {
      this.log(`duplicate review request ignored: ${params.requestId}`)
      return
    }
    if (this.autoAcceptArmed) {
      const handled = await this.tryAutoAccept(params)
      if (handled) return
    }
    await this.openNewReview(params)
  }

  private async openNewReview(params: ReviewRequestParams): Promise<void> {
    if (this.disposed || this.pending.has(params.requestId)) return
    const proposalUri = proposalUriFor(params.requestId, params.displayPath)
    const originalUri = params.isNewFile
      ? emptyOriginalUriFor(params.requestId, params.displayPath)
      : vscode.Uri.file(params.absolutePath)

    this.provider.seed(proposalUri.path, params.after)
    if (params.isNewFile) this.provider.seed(originalUri.path, '')

    const review: PendingReview = {
      params,
      proposalUri,
      originalUri,
      openedAt: Date.now(),
    }
    this.pending.set(params.requestId, review)
    this.notifyStateChanged()
    this.log(`opening review diff for ${params.displayPath} (${params.requestId})`)

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        proposalUri,
        this.messages.diffTitle(params.displayPath),
        { preview: false },
      )
    } catch (error) {
      this.log(`failed to open diff: ${describeError(error)}`)
      this.showWarning(this.messages.openDiffFailed(params.displayPath, describeError(error)))
      return
    }

    const document = await this.waitForDocument(proposalUri, DOC_OPEN_TIMEOUT_MS)
    if (this.pending.get(params.requestId) !== review || this.disposed) return
    if (document === undefined) {
      this.log(`proposal document did not open for ${params.displayPath}`)
    } else {
      await this.applyLanguage(document, review)
    }
    this.maybeShowFirstReviewHint()
  }

  /**
   * One-time onboarding hint per VS Code session.
   *
   * Decisions live on the persistent editor-title buttons (✓/✗), so the toast
   * never carries accept/reject actions: newcomers get one short pointer the
   * first time a review arrives, and it cannot be mistaken for the decision UI.
   */
  private maybeShowFirstReviewHint(): void {
    if (this.options.quiet) return
    if (this.firstHintShown) return
    this.firstHintShown = true
    this.showInfo(this.messages.firstReviewHint)
  }

  private async tryAutoAccept(params: ReviewRequestParams): Promise<boolean> {
    this.log(`auto-accepting ${params.displayPath} (${params.requestId})`)
    try {
      const reply = await this.sendDecision({
        requestId: params.requestId,
        nonce: params.nonce,
        status: 'accept',
        finalContent: params.after,
      })
      this.notifyOutcome(params, reply, false)
      return true
    } catch (error) {
      this.log(`auto-accept failed: ${describeError(error)}`)
      this.showWarning(this.messages.decisionFailed(params.displayPath, describeError(error)))
      return false
    }
  }

  private onReviewCancel(params: ReviewCancelParams): void {
    const review = this.pending.get(params.requestId)
    if (review === undefined) {
      this.log(`review/cancel for unknown request ignored: ${params.requestId}`)
      return
    }
    this.pending.delete(params.requestId)
    this.provider.release(params.requestId)
    this.notifyStateChanged()
    this.recordSettled(review.params, 'cancelled', false)
    void this.closeDiffTab(review.proposalUri)
    this.log(`review cancelled by Host: ${params.requestId} (${params.reason})`)
    this.showWarning(this.messages.reviewCancelledByHost(review.params.displayPath, params.reason))
  }

  private onReviewState(params: ReviewStateParams): void {
    const state = params.state as ReviewState
    if (!isTerminal(state)) {
      this.log(`review/state ${params.requestId}: ${params.state}`)
      return
    }
    const detail = params.detail === undefined ? undefined : { message: params.detail }
    const awaiting = this.awaitingOutcome.get(params.requestId)
    if (awaiting !== undefined) {
      this.clearAwaitingOutcome(params.requestId)
      this.notifyOutcomeValue(awaiting.params.displayPath, params.state, detail)
      this.recordSettled(awaiting.params, params.state, awaiting.edited)
    }
    const review = this.pending.get(params.requestId)
    if (review !== undefined) {
      this.pending.delete(params.requestId)
      this.provider.release(params.requestId)
      this.notifyStateChanged()
      void this.closeDiffTab(review.proposalUri)
      this.recordSettled(review.params, params.state, false)
    }
  }

  private onServerShutdown(_params: ServerShutdownParams): void {
    this.log('Host announced server/shutdown')
    this.disarmAutoAccept('shutdown')
    this.clearPending()
    this.clearAwaitingOutcomes()
    this.notifyStateChanged()
  }

  // -- connection ---------------------------------------------------------

  private onConnectionChanged(info: IpcConnectionInfo): void {
    if (info.paused !== undefined) this.reviewPausedState = info.paused
    if (!info.connected) {
      this.disarmAutoAccept('disconnect')
      const discarded = this.clearPending()
      this.clearAwaitingOutcomes()
      if (discarded > 0) {
        this.log(`discarded ${discarded} pending review(s) after disconnect`)
        this.showWarning(this.messages.pendingDiscarded(discarded))
      }
    }
    this.options.onConnectionChanged?.(info)
    this.notifyStateChanged()
  }

  // -- decisions ----------------------------------------------------------

  private async sendDecision(params: DecisionParams): Promise<DecisionResult> {
    try {
      return await this.client.decide(params)
    } catch (error) {
      if (error instanceof IpcRpcError) {
        const outcome = this.outcomeForErrorCode(error.code)
        if (outcome !== undefined) {
          this.log(`decision rejected by Host (${error.code} ${error.message}) → ${outcome}`)
          return {
            ok: true,
            outcome,
            detail: { code: String(error.code), message: error.message },
          }
        }
      }
      throw error
    }
  }

  private outcomeForErrorCode(code: number): DecisionOutcome | undefined {
    if (code === RPC_ERRORS.ALREADY_DECIDED) return 'already-decided'
    if (code === RPC_ERRORS.EXPIRED) return 'expired'
    if (code === RPC_ERRORS.UNKNOWN_REQUEST) return 'failed'
    return undefined
  }

  private finalContentFor(review: PendingReview): string {
    const document = this.findDocument(review.proposalUri)
    if (document !== undefined) return document.getText()
    const stored = this.provider.readText(review.proposalUri)
    return stored ?? review.params.after
  }

  private async finalizeProposal(review: PendingReview): Promise<void> {
    const document = this.findDocument(review.proposalUri)
    if (document !== undefined) {
      try {
        const saved = await document.save()
        if (!saved) this.log(`document.save() after accept returned false; the tab may still be dirty`)
      } catch (error) {
        this.log(`document.save() after accept failed: ${describeError(error)}`)
      }
    }
    await this.closeDiffTab(review.proposalUri)
  }

  private async revertProposal(review: PendingReview): Promise<void> {
    const document = this.findDocument(review.proposalUri)
    if (document === undefined) return
    try {
      await vscode.commands.executeCommand('workbench.action.files.revert', review.proposalUri)
      await delay(30)
    } catch (error) {
      // Custom-scheme documents may not implement revert; closing a dirty tab is
      // still safe because the provider content was never written to disk.
      this.log(`revert of the proposal document failed: ${describeError(error)}`)
    }
    if (!document.isDirty) return
    // Last resort: saving clears the dirty flag without touching the workspace,
    // so closing the diff tab cannot raise a save prompt.
    try {
      await document.save()
      this.log(`revert had no effect; saved the in-memory proposal to clear dirty state`)
    } catch (error) {
      this.log(`could not clear the dirty state before closing: ${describeError(error)}`)
    }
  }

  private notifyOutcome(params: ReviewRequestParams, reply: DecisionResult, edited: boolean): void {
    this.notifyOutcomeValue(params.displayPath, reply.outcome, reply.detail)
    if (KNOWN_OUTCOMES.has(reply.outcome)) {
      this.recordSettled(params, reply.outcome, edited)
    } else {
      // The Host answered `ok` with a not-yet-terminal outcome; wait for the
      // matching review/state notification before writing history.
      this.trackAwaitingOutcome(params.requestId, params, edited)
    }
  }

  private recordSettled(params: ReviewRequestParams, outcome: string, edited: boolean): void {
    if (!KNOWN_OUTCOMES.has(outcome)) return
    this.options.onSettled?.({
      requestId: params.requestId,
      displayPath: params.displayPath,
      toolName: params.toolName,
      mode: params.mode,
      outcome,
      edited,
      at: Date.now(),
    })
  }

  private notifyOutcomeValue(
    displayPath: string,
    outcome: string,
    detail: { code?: string; message?: string } | undefined,
  ): void {
    const detailText = this.detailText(detail)
    switch (outcome) {
      case 'committed':
        this.showInfo(this.messages.outcomeCommitted(displayPath))
        return
      case 'rejected':
        this.showInfo(this.messages.outcomeRejected(displayPath))
        return
      case 'already-decided':
        this.showInfo(this.messages.outcomeAlreadyDecided(displayPath))
        return
      case 'conflict':
        this.showWarning(this.messages.outcomeConflict(displayPath, detailText))
        return
      case 'failed':
        this.showWarning(this.messages.outcomeFailed(displayPath, detailText))
        return
      case 'expired':
        this.showWarning(this.messages.outcomeExpired(displayPath, detailText))
        return
      case 'cancelled':
        this.showWarning(this.messages.outcomeCancelled(displayPath, detailText))
        return
      default:
        this.showInfo(this.messages.outcomePending(displayPath, outcome))
        return
    }
  }

  private detailText(detail: { code?: string; message?: string } | undefined): string | undefined {
    if (detail === undefined) return undefined
    const parts: string[] = []
    if (detail.code !== undefined) parts.push(detail.code)
    if (detail.message !== undefined) parts.push(detail.message)
    return parts.length === 0 ? undefined : parts.join(': ')
  }

  private trackAwaitingOutcome(requestId: string, params: ReviewRequestParams, edited: boolean): void {
    const existing = this.awaitingOutcome.get(requestId)
    if (existing !== undefined) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.awaitingOutcome.delete(requestId)
    }, WAIT_OUTCOME_MS)
    this.awaitingOutcome.set(requestId, { params, edited, timer })
  }

  private clearAwaitingOutcome(requestId: string): void {
    const existing = this.awaitingOutcome.get(requestId)
    if (existing === undefined) return
    clearTimeout(existing.timer)
    this.awaitingOutcome.delete(requestId)
  }

  private clearAwaitingOutcomes(): void {
    for (const [requestId, awaiting] of this.awaitingOutcome) {
      clearTimeout(awaiting.timer)
      this.awaitingOutcome.delete(requestId)
    }
  }

  // -- pending queue ------------------------------------------------------

  private resolveTarget(arg: ReviewCommandArg): PendingReview | undefined {
    const explicit = typeof arg === 'string' ? arg : arg?.requestId
    if (explicit !== undefined) {
      const hit = this.pending.get(explicit)
      if (hit !== undefined) return hit
    }
    const activeEditor = vscode.window.activeTextEditor
    if (activeEditor !== undefined && activeEditor.document.uri.scheme === DPR_SCHEME) {
      const review = this.reviewForUri(activeEditor.document.uri)
      if (review !== undefined) return review
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== DPR_SCHEME) continue
      const review = this.reviewForUri(editor.document.uri)
      if (review !== undefined) return review
    }
    for (const review of this.pending.values()) return review
    return undefined
  }

  private reviewForUri(uri: vscode.Uri): PendingReview | undefined {
    const requestId = requestIdOfPath(uri.path)
    if (requestId === undefined) return undefined
    return this.pending.get(requestId)
  }

  private removePending(requestId: string): void {
    if (this.pending.delete(requestId)) this.notifyStateChanged()
    this.provider.release(requestId)
  }

  private clearPending(): number {
    const count = this.pending.size
    if (count === 0) return 0
    for (const review of this.pending.values()) {
      this.provider.release(review.params.requestId)
      void this.closeDiffTab(review.proposalUri)
    }
    this.pending.clear()
    this.notifyStateChanged()
    return count
  }

  // -- diff UI ------------------------------------------------------------

  private async openDiff(review: PendingReview): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        review.originalUri,
        review.proposalUri,
        this.messages.diffTitle(review.params.displayPath),
        { preview: false },
      )
    } catch (error) {
      this.showWarning(this.messages.openDiffFailed(review.params.displayPath, describeError(error)))
    }
  }

  private async waitForDocument(uri: vscode.Uri, timeoutMs: number): Promise<vscode.TextDocument | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const document = this.findDocument(uri)
      if (document !== undefined) return document
      if (Date.now() >= deadline || this.disposed) return undefined
      await delay(50)
    }
  }

  private findDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const target = uri.toString()
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === target)
  }

  private async applyLanguage(document: vscode.TextDocument, review: PendingReview): Promise<void> {
    let leftDocument = this.findDocument(review.originalUri)
    if (leftDocument === undefined) {
      // The diff editor opens both sides; give the left model a moment to land
      // so the proposal inherits its languageId rather than the hint.
      leftDocument = await this.waitForDocument(review.originalUri, 500)
    }
    const languageId = leftDocument?.languageId ?? review.params.languageHint
    if (languageId === undefined || languageId.length === 0) return
    if (document.languageId === languageId) return
    try {
      await vscode.languages.setTextDocumentLanguage(document, languageId)
    } catch (error) {
      this.log(`setTextDocumentLanguage(${languageId}) failed: ${describeError(error)}`)
    }
  }

  private async closeDiffTab(proposalUri: vscode.Uri): Promise<void> {
    const target = proposalUri.toString()
    const tabs: vscode.Tab[] = []
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input
        if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === target) {
          tabs.push(tab)
        } else if (input instanceof vscode.TabInputText && input.uri.toString() === target) {
          tabs.push(tab)
        }
      }
    }
    if (tabs.length === 0) return
    try {
      await vscode.window.tabGroups.close(tabs)
    } catch (error) {
      this.log(`tabGroups.close failed: ${describeError(error)}`)
    }
  }

  // -- misc ---------------------------------------------------------------

  private disarmAutoAccept(reason: AutoAcceptDisarmReason): void {
    if (this.autoAcceptTimer === undefined) return
    clearTimeout(this.autoAcceptTimer)
    this.autoAcceptTimer = undefined
    this.autoAcceptUntil = undefined
    this.log(`auto-accept disarmed (${reason})`)
    if (reason === 'toggled') this.showInfo(this.messages.autoAcceptDisarmed)
    else if (reason === 'expired') this.showInfo(this.messages.autoAcceptExpired)
    this.notifyStateChanged()
  }

  private notifyStateChanged(): void {
    this.options.onStateChanged?.()
  }

  private showInfo(message: string): void {
    if (this.options.quiet === true) return
    if (this.options.onTransientMessage !== undefined) {
      this.options.onTransientMessage(message, 'info')
      return
    }
    void vscode.window.showInformationMessage(message)
  }

  private showWarning(message: string): void {
    if (this.options.onTransientMessage !== undefined) {
      this.options.onTransientMessage(message, 'warning')
      return
    }
    void vscode.window.showWarningMessage(message)
  }

  private log(message: string): void {
    this.options.onLog?.(message)
  }
}
