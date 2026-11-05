/**
 * Activity-bar tree data providers: the pending review queue and the decision
 * history.
 *
 * Both providers are deliberately dumb: they read the live `ReviewSession`
 * queue / the persisted history store on every `getChildren()` call and are
 * refreshed by `refresh()`. That keeps the view correct even if an event is
 * missed and makes the providers easy to instantiate in the self-test.
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

/** One row in the pending queue; a click opens that review's diff. */
export class PendingReviewTreeItem extends vscode.TreeItem {
  readonly requestId: string
  readonly review: PendingReview

  constructor(review: PendingReview, messages: Messages) {
    super(review.params.displayPath, vscode.TreeItemCollapsibleState.None)
    this.review = review
    this.requestId = review.params.requestId
    this.id = this.requestId
    this.description = messages.pendingPickDescription(review.params.mode, review.params.toolName)
    this.tooltip = messages.pendingItemTooltip(
      review.params.absolutePath,
      new Date(review.openedAt),
      review.params.operation,
    )
    this.iconPath = new vscode.ThemeIcon('diff')
    this.contextValue = PENDING_CONTEXT_VALUE
    this.command = {
      command: 'dpr.openItem',
      title: messages.openItemTitle,
      arguments: [{ requestId: this.requestId }],
    }
  }
}

/** One row in the decision history (committed / rejected / … ). */
export class HistoryReviewTreeItem extends vscode.TreeItem {
  readonly entry: HistoryEntry

  constructor(entry: HistoryEntry, messages: Messages) {
    super(entry.displayPath, vscode.TreeItemCollapsibleState.None)
    this.entry = entry
    this.id = entry.requestId
    this.description = messages.historyDescription(entry.status, entry.mode, entry.toolName, entry.edited)
    this.tooltip = messages.historyItemTooltip({
      displayPath: entry.displayPath,
      status: entry.status,
      mode: entry.mode,
      toolName: entry.toolName,
      outcome: entry.outcome,
      edited: entry.edited,
      at: new Date(entry.at),
    })
    this.iconPath = historyIcon(entry.status)
    this.contextValue = HISTORY_CONTEXT_VALUE
  }
}

export class PendingReviewsProvider implements vscode.TreeDataProvider<PendingReviewTreeItem> {
  private readonly emitter = new vscode.EventEmitter<PendingReviewTreeItem | undefined | void>()
  private readonly activeSession: () => ReviewSession | undefined
  private readonly messages: Messages

  readonly onDidChangeTreeData: vscode.Event<PendingReviewTreeItem | undefined | void> = this.emitter.event

  constructor(activeSession: () => ReviewSession | undefined, messages: Messages) {
    this.activeSession = activeSession
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
    const session = this.activeSession()
    if (session === undefined) return []
    return session.pendingList().map((review) => new PendingReviewTreeItem(review, this.messages))
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
