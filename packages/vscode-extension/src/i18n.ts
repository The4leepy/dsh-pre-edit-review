/**
 * Tiny in-extension i18n table (no `l10n` bundle files needed).
 *
 * The active language comes from `vscode.env.language` (e.g. `zh-cn`, `en`).
 * Everything user-visible in the extension goes through this single object so
 * the en / zh-CN surfaces cannot drift apart.
 */

import * as vscode from 'vscode'

import type { HistoryStatus } from './history-store.ts'

/** Arguments for the history-row tooltip (kept structural to avoid a cycle). */
export interface HistoryTooltipEntry {
  displayPath: string
  status: HistoryStatus
  mode: string
  toolName: string
  outcome: string
  edited: boolean
  at: Date
}

export interface Messages {
  readonly locale: 'en' | 'zh-CN'

  // Status bar
  readonly statusConnected: string
  readonly statusOffline: string
  readonly statusTooltip: (stateDir: string, clientVersion: string) => string
  pendingSuffix(count: number): string
  readonly autoAcceptStatus: string
  autoAcceptTooltip(until: Date): string
  /** Appended to the status bar while the Host reports review paused (`/review off`). */
  readonly pausedSuffix: string
  readonly pausedTooltip: string

  // UI actions
  readonly accept: string
  readonly reject: string
  readonly firstReviewHint: string
  pendingStatus(count: number): string
  readonly diffTitle: (displayPath: string) => string
  readonly pendingPickPlaceholder: string
  pendingPickDescription(mode: string, toolName: string): string

  // Reject flow
  readonly rejectReasonPrompt: string
  readonly rejectReasonPlaceholder: string

  // Outcomes
  outcomeCommitted(displayPath: string): string
  outcomeRejected(displayPath: string): string
  outcomeAlreadyDecided(displayPath: string): string
  outcomeConflict(displayPath: string, detail?: string): string
  outcomeFailed(displayPath: string, detail?: string): string
  outcomeExpired(displayPath: string, detail?: string): string
  outcomeCancelled(displayPath: string, detail?: string): string
  outcomePending(displayPath: string, outcome: string): string
  decisionFailed(displayPath: string, detail: string): string
  openDiffFailed(displayPath: string, detail: string): string
  reviewCancelledByHost(displayPath: string, reason: string): string
  readonly noPendingReview: string
  pendingDiscarded(count: number): string

  // Connection
  readonly offlineWarning: string
  authFailedError(detail: string): string
  readonly reconnectRequested: string
  readonly notConnected: string

  // Auto-accept window
  autoAcceptArmed(minutes: number): string
  readonly autoAcceptDisarmed: string
  readonly autoAcceptExpired: string
  readonly autoAcceptDisabled: string
  readonly autoAcceptConfirm: string
  readonly autoAcceptConfirmYes: string

  // Pending queue view
  readonly openItemTitle: string
  pendingBadgeTooltip(count: number): string
  pendingItemTooltip(absolutePath: string, openedAt: Date, operation: string): string
  reopenReviewHint(displayPath: string): string

  // History view
  historyStatusLabel(status: HistoryStatus): string
  historyDescription(status: HistoryStatus, mode: string, toolName: string, edited: boolean): string
  historyItemTooltip(entry: HistoryTooltipEntry): string
  readonly clearHistoryConfirm: string
  readonly clearHistoryConfirmYes: string
  readonly clearHistoryDone: string

  // Reject all
  rejectAllSummary(rejected: number, total: number, remaining: number): string

  // Self-test
  selfTestPassed(steps: number, reportPath: string): string
  selfTestFailed(detail: string): string
  readonly selfTestNoWorkspace: string
  readonly selfTestSkippedPending: string
}

const enHistoryStatus: Readonly<Record<HistoryStatus, string>> = {
  committed: 'Committed',
  rejected: 'Rejected',
  conflict: 'Conflict',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Failed',
}

const zhHistoryStatus: Readonly<Record<HistoryStatus, string>> = {
  committed: '已提交',
  rejected: '已拒绝',
  conflict: '冲突',
  expired: '已过期',
  cancelled: '已取消',
  failed: '失败',
}

const en: Messages = {
  locale: 'en',
  statusConnected: 'connected',
  statusOffline: 'offline',
  statusTooltip: (stateDir, clientVersion) =>
    `DeepSeek Pre-edit Review ${clientVersion}\nstateDir: ${stateDir}\nClick to show pending reviews.`,
  pendingSuffix: (count) => ` (${count} pending)`,
  autoAcceptStatus: 'AUTO-ACCEPT',
  autoAcceptTooltip: (until) => `Auto-accept armed until ${until.toLocaleTimeString()} — click to disarm.`,
  pausedSuffix: ' · OFF',
  pausedTooltip: 'Review is paused for a session on this Host: its writes are NOT reviewed. Use /review on to restore review.',
  accept: 'Accept',
  reject: 'Reject',
  firstReviewHint:
    'A file change is waiting for review. An editable diff is open — click ✓ or ✗ in the editor title bar, or press Ctrl+Alt+A (accept) / Ctrl+Alt+R (reject).',
  pendingStatus: (count) => `Pre-edit Review: ${count} pending — click to review`,
  diffTitle: (displayPath) => `Pre-edit Review: ${displayPath}`,
  pendingPickPlaceholder: 'Pending review requests (select one to open its diff)',
  pendingPickDescription: (mode, toolName) => `${mode} · ${toolName}`,
  rejectReasonPrompt: 'Reason for rejecting this change (optional)',
  rejectReasonPlaceholder: 'The agent will receive this reason; leave empty to reject without one',
  outcomeCommitted: (displayPath) => `Committed: ${displayPath}`,
  outcomeRejected: (displayPath) => `Rejected: ${displayPath}`,
  outcomeAlreadyDecided: (displayPath) => `Already decided: ${displayPath}`,
  outcomeConflict: (displayPath, detail) =>
    `Conflict, nothing committed: ${displayPath}${detail === undefined ? '' : ` — ${detail}`}`,
  outcomeFailed: (displayPath, detail) =>
    `Commit failed: ${displayPath}${detail === undefined ? '' : ` — ${detail}`}`,
  outcomeExpired: (displayPath, detail) =>
    `Review expired: ${displayPath}${detail === undefined ? '' : ` — ${detail}`}`,
  outcomeCancelled: (displayPath, detail) =>
    `Review cancelled: ${displayPath}${detail === undefined ? '' : ` — ${detail}`}`,
  outcomePending: (displayPath, outcome) => `Decision sent (${outcome}): ${displayPath}`,
  decisionFailed: (displayPath, detail) => `Could not send the decision for ${displayPath}: ${detail}`,
  openDiffFailed: (displayPath, detail) => `Could not open the review diff for ${displayPath}: ${detail}`,
  reviewCancelledByHost: (displayPath, reason) => `Review withdrawn by the Host (${reason}): ${displayPath}`,
  noPendingReview: 'No pending pre-edit review.',
  pendingDiscarded: (count) =>
    `Connection to DeepSeek Harness was lost; ${count} pending review(s) were discarded and nothing was committed.`,
  offlineWarning: 'DeepSeek Pre-edit Review is offline; waiting for the Host to come up (retrying every 3 s).',
  authFailedError: (detail) => `Pre-edit Review authentication failed: ${detail}`,
  reconnectRequested: 'Reconnecting to DeepSeek Harness…',
  notConnected: 'DeepSeek Pre-edit Review is not connected to the Host.',
  autoAcceptArmed: (minutes) => `AUTO-ACCEPT is armed for the next ${minutes} minute(s).`,
  autoAcceptDisarmed: 'Auto-accept disarmed.',
  autoAcceptExpired: 'Auto-accept window expired.',
  autoAcceptDisabled:
    'Auto-accept is disabled. Enable "dpr.autoAccept" in settings before arming dpr.acceptAll.',
  autoAcceptConfirm:
    'Arm AUTO-ACCEPT? Every change the agent proposes from now on will be committed without asking, for 5 minutes.',
  autoAcceptConfirmYes: 'Arm AUTO-ACCEPT',
  openItemTitle: 'Open Review',
  pendingBadgeTooltip: (count) => `${count} pending review${count === 1 ? '' : 's'}`,
  pendingItemTooltip: (absolutePath, openedAt, operation) =>
    `${absolutePath}\n${operation} · opened ${openedAt.toLocaleString()}`,
  reopenReviewHint: (displayPath) =>
    `Review opened: ${displayPath}. Use ✓ or ✗ in the editor title bar (top-right) to accept or reject.`,
  historyStatusLabel: (status) => enHistoryStatus[status],
  historyDescription: (status, mode, toolName, edited) =>
    `${enHistoryStatus[status]} · ${mode} · ${toolName}${edited ? ' · edited' : ''}`,
  historyItemTooltip: (entry) =>
    `${entry.displayPath}\n${enHistoryStatus[entry.status]} · ${entry.mode} · ${entry.toolName}\nOutcome: ${
      entry.outcome
    }${entry.edited ? ' · edited' : ''}\n${entry.at.toLocaleString()}`,
  clearHistoryConfirm:
    'Clear the review history? This deletes the last 50 decision records for this workspace.',
  clearHistoryConfirmYes: 'Clear History',
  clearHistoryDone: 'Review history cleared.',
  rejectAllSummary: (rejected, total, remaining) =>
    remaining > 0
      ? `Rejected ${rejected} of ${total} pending review(s); ${remaining} still pending.`
      : `Rejected all ${rejected} pending review(s).`,
  selfTestPassed: (steps, reportPath) => `Self-test PASSED (${steps} steps). Report: ${reportPath}`,
  selfTestFailed: (detail) => `Self-test FAILED: ${detail}`,
  selfTestNoWorkspace: 'Self-test needs an open workspace folder to write .spike/ext-selftest.json.',
  selfTestSkippedPending: 'Self-test auto-run skipped: there are pending reviews.',
}

const zhCN: Messages = {
  locale: 'zh-CN',
  statusConnected: '已连接',
  statusOffline: '离线',
  statusTooltip: (stateDir, clientVersion) =>
    `DeepSeek 修改前审阅 ${clientVersion}\nstateDir: ${stateDir}\n点击查看待审批队列。`,
  pendingSuffix: (count) => ` (${count} 待审批)`,
  autoAcceptStatus: 'AUTO-ACCEPT',
  autoAcceptTooltip: (until) => `自动接受已启用，截止 ${until.toLocaleTimeString()} — 点击关闭。`,
  pausedSuffix: ' · 已关闭',
  pausedTooltip: '本 Host 上有会话已暂停审批：其写操作不再经过审批。输入 /review on 可恢复审批。',
  accept: '接受',
  reject: '拒绝',
  firstReviewHint:
    '有新的修改等待审阅：已打开可编辑 diff，请点击编辑器右上角的 ✓ / ✗ 按钮，或按 Ctrl+Alt+A（接受）/ Ctrl+Alt+R（拒绝）。',
  pendingStatus: (count) => `修改前审阅：${count} 待审批 — 点击审阅`,
  diffTitle: (displayPath) => `修改前审阅：${displayPath}`,
  pendingPickPlaceholder: '待审批请求（选择一项打开对应 diff）',
  pendingPickDescription: (mode, toolName) => `${mode} · ${toolName}`,
  rejectReasonPrompt: '拒绝本次修改的原因（可选）',
  rejectReasonPlaceholder: 'Agent 会收到该原因；留空表示无原因直接拒绝',
  outcomeCommitted: (displayPath) => `已提交：${displayPath}`,
  outcomeRejected: (displayPath) => `已拒绝：${displayPath}`,
  outcomeAlreadyDecided: (displayPath) => `该请求已有结论：${displayPath}`,
  outcomeConflict: (displayPath, detail) =>
    `冲突，未提交：${displayPath}${detail === undefined ? '' : ` — ${detail}`}`,
  outcomeFailed: (displayPath, detail) =>
    `提交失败：${displayPath}${detail === undefined ? '' : ` — ${detail}`}`,
  outcomeExpired: (displayPath, detail) =>
    `审批已过期：${displayPath}${detail === undefined ? '' : ` — ${detail}`}`,
  outcomeCancelled: (displayPath, detail) =>
    `审批已取消：${displayPath}${detail === undefined ? '' : ` — ${detail}`}`,
  outcomePending: (displayPath, outcome) => `决策已发送（${outcome}）：${displayPath}`,
  decisionFailed: (displayPath, detail) => `无法为 ${displayPath} 发送决策：${detail}`,
  openDiffFailed: (displayPath, detail) => `无法为 ${displayPath} 打开审阅 diff：${detail}`,
  reviewCancelledByHost: (displayPath, reason) => `Host 撤回了审批请求（${reason}）：${displayPath}`,
  noPendingReview: '当前没有待审批的修改。',
  pendingDiscarded: (count) =>
    `与 DeepSeek Harness 的连接已断开；${count} 个待审批请求已丢弃，未提交任何修改。`,
  offlineWarning: '修改前审阅处于离线状态，正在等待 Host 启动（每 3 秒重试）。',
  authFailedError: (detail) => `修改前审阅鉴权失败：${detail}`,
  reconnectRequested: '正在重新连接 DeepSeek Harness…',
  notConnected: '修改前审阅尚未连接 Host。',
  autoAcceptArmed: (minutes) => `AUTO-ACCEPT 已启用，接下来 ${minutes} 分钟内的修改将自动接受。`,
  autoAcceptDisarmed: '自动接受已关闭。',
  autoAcceptExpired: '自动接受已到期。',
  autoAcceptDisabled: '自动接受未启用。请先在设置中开启 "dpr.autoAccept"，再执行 dpr.acceptAll。',
  autoAcceptConfirm: '启用 AUTO-ACCEPT？接下来 5 分钟内 Agent 提出的所有修改都会不经确认直接提交。',
  autoAcceptConfirmYes: '启用 AUTO-ACCEPT',
  openItemTitle: '打开审阅',
  pendingBadgeTooltip: (count) => `${count} 个待审批`,
  pendingItemTooltip: (absolutePath, openedAt, operation) =>
    `${absolutePath}\n${operation} · 打开于 ${openedAt.toLocaleString()}`,
  reopenReviewHint: (displayPath) =>
    `已打开审阅：${displayPath}。点击编辑器右上角的 ✓ / ✗ 接受或拒绝。`,
  historyStatusLabel: (status) => zhHistoryStatus[status],
  historyDescription: (status, mode, toolName, edited) =>
    `${zhHistoryStatus[status]} · ${mode} · ${toolName}${edited ? ' · 已编辑' : ''}`,
  historyItemTooltip: (entry) =>
    `${entry.displayPath}\n${zhHistoryStatus[entry.status]} · ${entry.mode} · ${entry.toolName}\n结果：${
      entry.outcome
    }${entry.edited ? ' · 已编辑' : ''}\n${entry.at.toLocaleString()}`,
  clearHistoryConfirm: '清空审阅历史？将删除本工作区最近 50 条决策记录。',
  clearHistoryConfirmYes: '清空历史',
  clearHistoryDone: '审阅历史已清空。',
  rejectAllSummary: (rejected, total, remaining) =>
    remaining > 0
      ? `已拒绝 ${rejected}/${total} 个待审批请求；仍有 ${remaining} 个未处理。`
      : `已拒绝全部 ${rejected} 个待审批请求。`,
  selfTestPassed: (steps, reportPath) => `自检通过（${steps} 步）。报告：${reportPath}`,
  selfTestFailed: (detail) => `自检失败：${detail}`,
  selfTestNoWorkspace: '自检需要打开一个工作区目录，以写入 .spike/ext-selftest.json。',
  selfTestSkippedPending: '自检自动运行已跳过：当前有正在进行的审批。',
}

export function pickMessages(language: string): Messages {
  const normalized = language.toLowerCase()
  return normalized.startsWith('zh') ? zhCN : en
}

/** Messages for the current VS Code display language. */
export const messages: Messages = pickMessages(vscode.env.language)
