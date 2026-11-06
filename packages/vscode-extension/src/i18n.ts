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
  /** Owning Host key for non-legacy entries (ADR 0002). */
  hostKey?: string
}

export interface Messages {
  readonly locale: 'en' | 'zh-CN'

  // Status bar
  readonly statusConnected: string
  readonly statusOffline: string
  readonly statusTooltip: (stateDir: string, clientVersion: string) => string
  /** Aggregate "N hosts connected" line (multi-Host, ADR 0002). */
  statusConnectedHosts(count: number): string
  /** One tooltip line per connected/discovered Host. */
  hostStatusLine(label: string, connected: boolean, pending: number, inactive: boolean): string
  /** Tooltip hint when discovery has not found any Host yet. */
  readonly noHostsFound: string
  /** Display label used for the legacy root-layout Host in multi-Host surfaces. */
  readonly legacyHostLabel: string
  readonly autoAcceptStatus: string
  autoAcceptTooltip(until: Date): string
  /** Appended to the status bar while every connected Host reports review inactive. */
  readonly inactiveSuffix: string
  readonly inactiveTooltip: string

  // UI actions
  readonly accept: string
  readonly reject: string
  readonly firstReviewHint: string
  pendingStatus(count: number, hostCount: number): string
  diffTitle(displayPath: string, hostLabel?: string): string
  readonly pendingPickPlaceholder: string
  pendingPickDescription(mode: string, toolName: string): string
  /** ` · <label>` suffix for multi-Host rows/items. */
  hostSuffix(label: string): string

  // Routing (multi-Host)
  ambiguousRoutingError(labels: readonly string[]): string

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
  /** Confirmation when auto-accept is armed for several Hosts at once. */
  acceptAllConfirmMulti(hosts: string): string
  /** Confirmation before rejecting every pending review on several Hosts. */
  rejectAllConfirmMulti(hosts: string): string
  readonly rejectAllConfirmMultiYes: string

  // Pending queue view
  readonly openItemTitle: string
  pendingBadgeTooltip(count: number): string
  pendingItemTooltip(absolutePath: string, openedAt: Date, operation: string, hostLabel?: string): string
  reopenReviewHint(displayPath: string): string

  // History view
  historyStatusLabel(status: HistoryStatus): string
  historyDescription(status: HistoryStatus, mode: string, toolName: string, edited: boolean, hostKey?: string): string
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
    `DeepSeek Pre-edit Review ${clientVersion}\nstateDir (root): ${stateDir}\nClick to show pending reviews.`,
  statusConnectedHosts: (count) => (count === 1 ? '1 host connected' : `${count} hosts connected`),
  hostStatusLine: (label, connected, pending, inactive) =>
    `${label}: ${connected ? 'connected' : 'offline'} · ${pending} pending${inactive ? ' · review OFF' : ''}`,
  noHostsFound: 'No Host discovered under the state directory yet. Start DeepSeek Harness with the plugin enabled.',
  legacyHostLabel: 'legacy Host',
  autoAcceptStatus: 'AUTO-ACCEPT',
  autoAcceptTooltip: (until) => `Auto-accept armed until ${until.toLocaleTimeString()} — click to disarm.`,
  inactiveSuffix: ' · OFF',
  inactiveTooltip: 'Review is inactive: writes are NOT reviewed until a session runs /review on.',
  accept: 'Accept',
  reject: 'Reject',
  firstReviewHint:
    'A file change is waiting for review. An editable diff is open — click ✓ or ✗ in the editor title bar, or press Ctrl+Alt+A (accept) / Ctrl+Alt+R (reject).',
  pendingStatus: (count, hostCount) =>
    hostCount > 1
      ? `Pre-edit Review: ${count} pending across ${hostCount} hosts — click to review`
      : `Pre-edit Review: ${count} pending — click to review`,
  diffTitle: (displayPath, hostLabel) =>
    hostLabel === undefined
      ? `Pre-edit Review: ${displayPath}`
      : `Pre-edit Review: ${displayPath} [${hostLabel}]`,
  pendingPickPlaceholder: 'Pending review requests (select one to open its diff)',
  pendingPickDescription: (mode, toolName) => `${mode} · ${toolName}`,
  hostSuffix: (label) => ` · ${label}`,
  ambiguousRoutingError: (labels) =>
    `Cannot tell which Host owns this review (candidates: ${labels.join(', ')}). Open the review diff and try again.`,
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
  offlineWarning: 'DeepSeek Pre-edit Review is offline; waiting for a Host to come up (retrying every 3 s).',
  authFailedError: (detail) => `Pre-edit Review authentication failed: ${detail}`,
  reconnectRequested: 'Reconnecting to DeepSeek Harness…',
  notConnected: 'DeepSeek Pre-edit Review is not connected to any Host.',
  autoAcceptArmed: (minutes) => `AUTO-ACCEPT is armed for the next ${minutes} minute(s).`,
  autoAcceptDisarmed: 'Auto-accept disarmed.',
  autoAcceptExpired: 'Auto-accept window expired.',
  autoAcceptDisabled:
    'Auto-accept is disabled. Enable "dpr.autoAccept" in settings before arming dpr.acceptAll.',
  autoAcceptConfirm:
    'Arm AUTO-ACCEPT? Every change the agent proposes from now on will be committed without asking, for 5 minutes.',
  autoAcceptConfirmYes: 'Arm AUTO-ACCEPT',
  acceptAllConfirmMulti: (hosts) =>
    `Arm AUTO-ACCEPT for ${hosts}? Every change those Hosts propose in the next 5 minutes will be committed without asking.`,
  rejectAllConfirmMulti: (hosts) => `Reject all pending reviews on ${hosts}? Nothing will be written.`,
  rejectAllConfirmMultiYes: 'Reject All',
  openItemTitle: 'Open Review',
  pendingBadgeTooltip: (count) => `${count} pending review${count === 1 ? '' : 's'}`,
  pendingItemTooltip: (absolutePath, openedAt, operation, hostLabel) =>
    `${absolutePath}\n${operation} · opened ${openedAt.toLocaleString()}${
      hostLabel === undefined ? '' : `\nHost: ${hostLabel}`
    }`,
  reopenReviewHint: (displayPath) =>
    `Review opened: ${displayPath}. Use ✓ or ✗ in the editor title bar (top-right) to accept or reject.`,
  historyStatusLabel: (status) => enHistoryStatus[status],
  historyDescription: (status, mode, toolName, edited, hostKey) =>
    `${enHistoryStatus[status]} · ${mode} · ${toolName}${edited ? ' · edited' : ''}${
      hostKey === undefined ? '' : ` · ${hostKey}`
    }`,
  historyItemTooltip: (entry) =>
    `${entry.displayPath}\n${enHistoryStatus[entry.status]} · ${entry.mode} · ${entry.toolName}\nOutcome: ${
      entry.outcome
    }${entry.edited ? ' · edited' : ''}${entry.hostKey === undefined ? '' : `\nHost: ${entry.hostKey}`}\n${entry.at.toLocaleString()}`,
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
    `DeepSeek 修改前审阅 ${clientVersion}\nstateDir（根目录）：${stateDir}\n点击查看待审批队列。`,
  statusConnectedHosts: (count) => `已连接 ${count} 个 Host`,
  hostStatusLine: (label, connected, pending, inactive) =>
    `${label}：${connected ? '已连接' : '离线'} · ${pending} 待审批${inactive ? ' · 未启用' : ''}`,
  noHostsFound: '状态目录下尚未发现任何 Host。请启动已安装插件的 DeepSeek Harness。',
  legacyHostLabel: '旧版 Host',
  autoAcceptStatus: 'AUTO-ACCEPT',
  autoAcceptTooltip: (until) => `自动接受已启用，截止 ${until.toLocaleTimeString()} — 点击关闭。`,
  inactiveSuffix: ' · 未启用',
  inactiveTooltip: '审阅未启用：在会话中执行 /review on 之前，写操作不会经过审批。',
  accept: '接受',
  reject: '拒绝',
  firstReviewHint:
    '有新的修改等待审阅：已打开可编辑 diff，请点击编辑器右上角的 ✓ / ✗ 按钮，或按 Ctrl+Alt+A（接受）/ Ctrl+Alt+R（拒绝）。',
  pendingStatus: (count, hostCount) =>
    hostCount > 1
      ? `修改前审阅：${count} 待审批（${hostCount} 个 Host） — 点击审阅`
      : `修改前审阅：${count} 待审批 — 点击审阅`,
  diffTitle: (displayPath, hostLabel) =>
    hostLabel === undefined ? `修改前审阅：${displayPath}` : `修改前审阅：${displayPath} [${hostLabel}]`,
  pendingPickPlaceholder: '待审批请求（选择一项打开对应 diff）',
  pendingPickDescription: (mode, toolName) => `${mode} · ${toolName}`,
  hostSuffix: (label) => ` · ${label}`,
  ambiguousRoutingError: (labels) =>
    `无法判断该审阅属于哪个 Host（候选：${labels.join('、')}）。请先打开对应审阅 diff 再操作。`,
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
  notConnected: '修改前审阅尚未连接任何 Host。',
  autoAcceptArmed: (minutes) => `AUTO-ACCEPT 已启用，接下来 ${minutes} 分钟内的修改将自动接受。`,
  autoAcceptDisarmed: '自动接受已关闭。',
  autoAcceptExpired: '自动接受已到期。',
  autoAcceptDisabled: '自动接受未启用。请先在设置中开启 "dpr.autoAccept"，再执行 dpr.acceptAll。',
  autoAcceptConfirm: '启用 AUTO-ACCEPT？接下来 5 分钟内 Agent 提出的所有修改都会不经确认直接提交。',
  autoAcceptConfirmYes: '启用 AUTO-ACCEPT',
  acceptAllConfirmMulti: (hosts) =>
    `为 ${hosts} 启用 AUTO-ACCEPT？接下来 5 分钟内这些 Host 提出的修改都会不经确认直接提交。`,
  rejectAllConfirmMulti: (hosts) => `拒绝 ${hosts} 上的全部待审批请求？不会写入任何修改。`,
  rejectAllConfirmMultiYes: '全部拒绝',
  openItemTitle: '打开审阅',
  pendingBadgeTooltip: (count) => `${count} 个待审批`,
  pendingItemTooltip: (absolutePath, openedAt, operation, hostLabel) =>
    `${absolutePath}\n${operation} · 打开于 ${openedAt.toLocaleString()}${
      hostLabel === undefined ? '' : `\nHost：${hostLabel}`
    }`,
  reopenReviewHint: (displayPath) =>
    `已打开审阅：${displayPath}。点击编辑器右上角的 ✓ / ✗ 接受或拒绝。`,
  historyStatusLabel: (status) => zhHistoryStatus[status],
  historyDescription: (status, mode, toolName, edited, hostKey) =>
    `${zhHistoryStatus[status]} · ${mode} · ${toolName}${edited ? ' · 已编辑' : ''}${
      hostKey === undefined ? '' : ` · ${hostKey}`
    }`,
  historyItemTooltip: (entry) =>
    `${entry.displayPath}\n${zhHistoryStatus[entry.status]} · ${entry.mode} · ${entry.toolName}\n结果：${
      entry.outcome
    }${entry.edited ? ' · 已编辑' : ''}${entry.hostKey === undefined ? '' : `\nHost：${entry.hostKey}`}\n${entry.at.toLocaleString()}`,
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
