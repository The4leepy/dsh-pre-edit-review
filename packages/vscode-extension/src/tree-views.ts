/**
 * Activity-bar tree data providers: the pending review queue and the decision
 * history.
 *
 * Both providers are deliberately dumb: they read the live `ReviewSession`
 * queues / the persisted history store on every `getChildren()` call and are
 * refreshed by `refresh()`. That keeps the view correct even if an event is
 * missed and makes the providers easy to instantiate in the self-test.
 *
 * Multi-Host (ADR 0002): the pending view flattens every Host's queue and shows
 * the Host label for non-legacy Hosts; rows carry `{requestId, hostKey}` so a
 * decision is routed back to the owning Host.
 */

import * as vscode from 'vscode'

import type { HistoryEntry, HistoryStatus } from './history-store.ts'
import type { ReviewHistoryStore } from './history-store.ts'
import type { Messages } from './i18n.ts'
import type { PendingReview, ReviewSession } from './review-session.ts'

export const PENDING_CONTEXT_VALUE = 'pendingReview'
export const HISTORY_CONTEXT_VALUE = 'historyEntry'

function historyIcon(status: HistoryStatus): vscode.ThemeIcon {
  switch (status) {
    case 'committed':
      return new vscode.ThemeIcon('check')
    case 'rejected':
      return new vscode.ThemeIcon('close')
    case 'conflict':
      return new vscode.ThemeIcon('warning')
    case 'expired':
      return new vscode.ThemeIcon('clock')
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash')
    case 'failed':
    default:
      return new vscode.ThemeIcon('error')
  }
}

/** Command argument shared by the pending-row click and the inline actions. */
export interface PendingItemArg {
  requestId: string
  /** Present only for non-legacy Hosts. */
  hostKey?: string
}

/** One row in the pending queue; a click opens that review's diff. */
export class PendingReviewTreeItem extends vscode.TreeItem {
  readonly requestId: string
  readonly review: PendingReview
  /** Owning Host key; undefined for legacy rows (they route by requestId only). */
  readonly hostKey: string | undefined

  constructor(review: PendingReview, messages: Messages, session: ReviewSession) {
    super(review.params.displayPath, vscode.TreeItemCollapsibleState.None)
    this.review = review
    this.requestId = review.params.requestId
    this.hostKey = session.isLegacy ? undefined : session.hostKey
    this.id = this.hostKey === undefined ? this.requestId : `${this.hostKey}/${this.requestId}`
    const hostLabel = session.isLegacy ? undefined : session.displayLabel
    const baseDescription = messages.pendingPickDescription(review.params.mode, review.params.toolName)
    this.description =
      hostLabel === undefined ? baseDescription : `${baseDescription}${messages.hostSuffix(hostLabel)}`
    this.tooltip = messages.pendingItemTooltip(
      review.params.absolutePath,
      new Date(review.openedAt),
      review.params.operation,
      hostLabel,
    )
    this.iconPath = new vscode.ThemeIcon('diff')
    this.contextValue = PENDING_CONTEXT_VALUE
    const argument: PendingItemArg = {
      requestId: this.requestId,
      ...(this.hostKey !== undefined ? { hostKey: this.hostKey } : {}),
    }
    this.command = {
      command: 'dpr.openItem',
      title: messages.openItemTitle,
      arguments: [argument],
    }
  }
}

/** One row in the decision history (committed / rejected / … ). */
export class HistoryReviewTreeItem extends vscode.TreeItem {
  readonly entry: HistoryEntry

  constructor(entry: HistoryEntry, messages: Messages) {
    super(entry.displayPath, vscode.TreeItemCollapsibleState.None)
    this.entry = entry
    this.id = entry.hostKey === undefined ? entry.requestId : `${entry.hostKey}/${entry.requestId}`
    this.description = messages.historyDescription(
      entry.status,
      entry.mode,
      entry.toolName,
      entry.edited,
      entry.hostKey,
    )
    this.tooltip = messages.historyItemTooltip({
      displayPath: entry.displayPath,
      status: entry.status,
      mode: entry.mode,
      toolName: entry.toolName,
      outcome: entry.outcome,
      edited: entry.edited,
      at: new Date(entry.at),
      ...(entry.hostKey !== undefined ? { hostKey: entry.hostKey } : {}),
    })
    this.iconPath = historyIcon(entry.status)
    this.contextValue = HISTORY_CONTEXT_VALUE
  }
}

export class PendingReviewsProvider implements vscode.TreeDataProvider<PendingReviewTreeItem> {
  private readonly emitter = new vscode.EventEmitter<PendingReviewTreeItem | undefined | void>()
  private readonly getSessions: () => readonly ReviewSession[]
  private readonly messages: Messages

  readonly onDidChangeTreeData: vscode.Event<PendingReviewTreeItem | undefined | void> = this.emitter.event

  constructor(getSessions: () => readonly ReviewSession[], messages: Messages) {
    this.getSessions = getSessions
    this.messages = messages
  }

  refresh(): void {
    this.emitter.fire()
  }

  getTreeItem(element: PendingReviewTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: PendingReviewTreeItem): PendingReviewTreeItem[] {
    if (element !== undefined) return []
    const rows: PendingReviewTreeItem[] = []
    for (const session of this.getSessions()) {
      for (const review of session.pendingList()) {
        rows.push(new PendingReviewTreeItem(review, this.messages, session))
      }
    }
    return rows
  }

  dispose(): void {
    this.emitter.dispose()
  }
}

export class HistoryReviewsProvider implements vscode.TreeDataProvider<HistoryReviewTreeItem> {
  private readonly emitter = new vscode.EventEmitter<HistoryReviewTreeItem | undefined | void>()
  private readonly history: ReviewHistoryStore
  private readonly messages: Messages

  readonly onDidChangeTreeData: vscode.Event<HistoryReviewTreeItem | undefined | void> = this.emitter.event

  constructor(history: ReviewHistoryStore, messages: Messages) {
    this.history = history
    this.messages = messages
  }

  refresh(): void {
    this.emitter.fire()
  }

  getTreeItem(element: HistoryReviewTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: HistoryReviewTreeItem): HistoryReviewTreeItem[] {
    if (element !== undefined) return []
    return this.history.list().map((entry) => new HistoryReviewTreeItem(entry, this.messages))
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
