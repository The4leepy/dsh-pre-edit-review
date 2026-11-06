/**
 * DeepSeek Pre-edit Review — VS Code client.
 *
 * Responsibilities:
 * - register the editable `dpr:` FileSystemProvider used as the right side of
 *   `vscode.diff`;
 * - discover every Host plugin instance under the root state directory
 *   (ADR 0002), connect one `ReviewSession` per Host, and authenticate with
 *   that Host's token file;
 * - show one diff per `review/request` and turn Accept/Reject into a protocol
 *   `decision` request routed back to the Host that issued it (the only
 *   mutation the extension can trigger);
 * - expose the aggregated pending/review-history activity-bar views, status /
 *   queue / auto-accept commands, and run an in-process self-test against mock
 *   Hosts.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import * as vscode from 'vscode'

import { DPR_SCHEME, DprFileSystemProvider } from './fs-provider.ts'
import { LEGACY_HOST_KEY, discoverHostLinks } from './host-registry.ts'
import type { HostLink } from './host-registry.ts'
import { historyStatusFor, ReviewHistoryStore } from './history-store.ts'
import { pickMessages, type Messages } from './i18n.ts'
import type { IpcConnectionInfo } from './ipc-client.ts'
import {
  ReviewSession,
  type DecisionCommandArg,
  type ReviewCommandArg,
  type SettledReview,
} from './review-session.ts'
import { runExtensionSelfTest, type SelfTestReport } from './self-test.ts'
import {
  HistoryReviewsProvider,
  PendingReviewsProvider,
  type HistoryReviewTreeItem,
  type PendingReviewTreeItem,
} from './tree-views.ts'
import { clampMessageDuration, describeError, expandHome, isRecord } from './util.ts'

const SETTINGS_SECTION = 'dpr'
const AUTO_SELF_TEST_DELAY_MS = 2000
const DISCOVERY_POLL_MS = 2500
const AUTO_ACCEPT_WINDOW_MINUTES = 5
const PENDING_VIEW_ID = 'dpr.pendingView'

let provider: DprFileSystemProvider | undefined
let providerRegistration: vscode.Disposable | undefined
/** One session per discovered Host key (ADR 0002). */
const mainSessions = new Map<string, ReviewSession>()
/** Sessions owned by a running self-test; routed first for explicit request ids. */
let selfTestSessions: ReviewSession[] = []
let discoveryTimer: NodeJS.Timeout | undefined
let discoveryGeneration = 0
let discoveryBusy = false
let discoveryRoot: string | undefined
const offlineWarnedHosts = new Set<string>()
const authWarnedHosts = new Set<string>()
let statusBar: vscode.StatusBarItem | undefined
let autoAcceptBar: vscode.StatusBarItem | undefined
let flashBar: vscode.StatusBarItem | undefined
let flashTimer: NodeJS.Timeout | undefined
let output: vscode.OutputChannel | undefined
let history: ReviewHistoryStore | undefined
let pendingProvider: PendingReviewsProvider | undefined
let historyProvider: HistoryReviewsProvider | undefined
let pendingTreeView: vscode.TreeView<PendingReviewTreeItem> | undefined
let historyTreeView: vscode.TreeView<HistoryReviewTreeItem> | undefined
let messages: Messages = pickMessages('en')
let clientVersion = '0.0.0'
let selfTestAutoRan = false
let selfTestInFlight: Promise<SelfTestReport | undefined> | undefined
/** Cleanup passes for `dpr:` editors restored from a previous window. */
const staleTabTimers: NodeJS.Timeout[] = []

export function activate(context: vscode.ExtensionContext): void {
  messages = pickMessages(vscode.env.language)
  clientVersion = String(context.extension?.packageJSON?.version ?? '0.0.0')
  output = vscode.window.createOutputChannel('DeepSeek Pre-edit Review')
  context.subscriptions.push(output)
  log(`activating v${clientVersion} locale=${messages.locale} vscode=${vscode.version}`)

  provider = new DprFileSystemProvider()
  // No `isReadonly`: the right-hand diff document must stay editable (S2 proof).
  providerRegistration = vscode.workspace.registerFileSystemProvider(DPR_SCHEME, provider, {
    isCaseSensitive: true,
  })
  context.subscriptions.push(providerRegistration)

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'dpr.showPending'
  context.subscriptions.push(statusBar)
  autoAcceptBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
  autoAcceptBar.command = 'dpr.acceptAll'
  autoAcceptBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  context.subscriptions.push(autoAcceptBar)
  flashBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98)
  context.subscriptions.push(flashBar)

  // -- activity-bar views (Phase 3) ----------------------------------------
  history = new ReviewHistoryStore({
    memento: context.workspaceState,
    onChanged: (): void => {
      historyProvider?.refresh()
    },
  })
  historyProvider = new HistoryReviewsProvider(history, messages)
  pendingProvider = new PendingReviewsProvider(() => mainSessionList(), messages)
  pendingTreeView = tryCreateTreeView(PENDING_VIEW_ID, pendingProvider)
  historyTreeView = tryCreateTreeView('dpr.historyView', historyProvider)
  if (pendingTreeView !== undefined) context.subscriptions.push(pendingTreeView)
  if (historyTreeView !== undefined) context.subscriptions.push(historyTreeView)
  context.subscriptions.push(pendingProvider, historyProvider)

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateProposalContext()
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      updateProposalContext()
    }),
  )
  updateStatusBar()

  context.subscriptions.push(
    vscode.commands.registerCommand('dpr.accept', (arg?: unknown) => acceptCommand(arg)),
    vscode.commands.registerCommand('dpr.reject', (arg?: unknown) => rejectCommand(arg)),
    vscode.commands.registerCommand('dpr.acceptItem', (arg?: unknown) => acceptCommand(arg)),
    vscode.commands.registerCommand('dpr.rejectItem', (arg?: unknown) => rejectCommand(arg)),
    vscode.commands.registerCommand('dpr.openItem', (arg?: unknown) => openItemCommand(arg)),
    vscode.commands.registerCommand('dpr.showPending', () => showPendingCommand()),
    vscode.commands.registerCommand('dpr.reconnect', () => reconnectCommand()),
    vscode.commands.registerCommand('dpr.acceptAll', () => acceptAllCommand()),
    vscode.commands.registerCommand('dpr.rejectAll', () => rejectAllCommand()),
    vscode.commands.registerCommand('dpr.clearHistory', () => clearHistoryCommand()),
    vscode.commands.registerCommand('dpr.runSelfTest', () => runSelfTestCommand('command')),
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SETTINGS_SECTION)) return
      onConfigurationChanged()
    }),
  )

  if (currentConfig().get<boolean>('autoConnect', true)) {
    startDiscovery()
  } else {
    log('autoConnect is disabled; not starting Host discovery')
  }

  scheduleStaleDprTabCleanup()
  scheduleAutoSelfTest(context)
}

export function deactivate(): void {
  for (const timer of staleTabTimers.splice(0)) clearTimeout(timer)
  stopDiscovery()
  disposeMainSessions()
  for (const session of selfTestSessions) session.dispose()
  selfTestSessions = []
  providerRegistration?.dispose()
  providerRegistration = undefined
  provider?.dispose()
  provider = undefined
  if (flashTimer !== undefined) {
    clearTimeout(flashTimer)
    flashTimer = undefined
  }
  flashBar?.dispose()
  flashBar = undefined
  statusBar?.dispose()
  statusBar = undefined
  autoAcceptBar?.dispose()
  autoAcceptBar = undefined
  pendingTreeView?.dispose()
  pendingTreeView = undefined
  historyTreeView?.dispose()
  historyTreeView = undefined
  pendingProvider?.dispose()
  pendingProvider = undefined
  historyProvider?.dispose()
  historyProvider = undefined
  history = undefined
  output?.dispose()
  output = undefined
}

/**
 * Create a contributed tree view. If the view id is not registered (stale
 * extension host manifest, tests), keep the extension usable without the view
 * rather than failing activation.
 */
function tryCreateTreeView<T>(
  id: string,
  treeDataProvider: vscode.TreeDataProvider<T>,
): vscode.TreeView<T> | undefined {
  try {
    return vscode.window.createTreeView(id, { treeDataProvider, showCollapseAll: false })
  } catch (error) {
    log(`could not create the ${id} tree view: ${describeError(error)}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Host discovery (ADR 0002)
// ---------------------------------------------------------------------------

function currentConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SETTINGS_SECTION)
}

function resolveStateDir(raw: string | undefined): string {
  return expandHome(raw ?? '~/.dsh/pre-edit-review')
}

function currentRootStateDir(): string {
  return resolveStateDir(currentConfig().get<string>('stateDir'))
}

function hostKeyOf(session: ReviewSession): string {
  return session.hostKey ?? LEGACY_HOST_KEY
}

/** Human-readable label used by the aggregate status bar and multi-Host prompts. */
function hostDisplayLabel(session: ReviewSession): string {
  return session.isLegacy ? messages.legacyHostLabel : session.displayLabel
}

/** Sessions sorted by Host key so every aggregate UI has a stable order. */
function mainSessionList(): ReviewSession[] {
  return [...mainSessions.values()].sort((left, right) => {
    const leftKey = hostKeyOf(left)
    const rightKey = hostKeyOf(right)
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
}

function createSession(link: HostLink): ReviewSession {
  if (provider === undefined) throw new Error('the dpr file system provider is not registered yet')
  const session = new ReviewSession({
    stateDir: link.hostDir,
    socketPath: link.socketPath,
    tokenPath: link.tokenPath,
    hostKey: link.key,
    hostLabel: link.label,
    clientVersion,
    messages,
    provider,
    onStateChanged: (): void => onSessionStateChanged(),
    onSettled: (record): void => onDecisionSettled(record),
    onConnectionChanged: (info): void => handleConnectionChanged(session, info),
    onTransientMessage: (message, severity): void => presentTransient(message, severity),
    onLog: (message): void => log(`[${link.key}] ${message}`),
  })
  return session
}

function startDiscovery(): void {
  stopDiscovery()
  discoveryRoot = currentRootStateDir()
  const generation = discoveryGeneration
  log(`discovering Hosts under ${discoveryRoot}`)
  void runDiscovery(generation)
  discoveryTimer = setInterval(() => {
    void runDiscovery(generation)
  }, DISCOVERY_POLL_MS)
}

function stopDiscovery(): void {
  // Bump first: an in-flight scan of the old root must not reconcile anymore.
  discoveryGeneration += 1
  if (discoveryTimer !== undefined) {
    clearInterval(discoveryTimer)
    discoveryTimer = undefined
  }
  discoveryRoot = undefined
}

async function runDiscovery(generation: number): Promise<void> {
  if (generation !== discoveryGeneration || discoveryBusy) return
  const root = discoveryRoot
  if (root === undefined) return
  discoveryBusy = true
  try {
    const links = await discoverHostLinks(root)
    if (generation !== discoveryGeneration) return
    reconcileMainSessions(links)
  } catch (error) {
    log(`Host discovery failed: ${describeError(error)}`)
  } finally {
    discoveryBusy = false
  }
}

/** Connect newly discovered Hosts, dispose vanished ones, refresh labels. */
function reconcileMainSessions(links: readonly HostLink[]): void {
  const desired = new Map<string, HostLink>()
  for (const link of links) desired.set(link.key, link)
  let changed = false

  for (const [key, session] of [...mainSessions]) {
    const link = desired.get(key)
    if (link === undefined) {
      log(`Host ${key} disappeared; disposing its session`)
      mainSessions.delete(key)
      forgetHostWarnings(key)
      session.dispose()
      changed = true
      continue
    }
    if (session.socketPath !== link.socketPath || session.tokenPath !== link.tokenPath) {
      log(`Host ${key} endpoint changed; reconnecting its session`)
      mainSessions.delete(key)
      forgetHostWarnings(key)
      session.dispose()
      changed = true
      continue
    }
    session.setHostLabel(link.label)
  }

  for (const link of links) {
    if (mainSessions.has(link.key)) continue
    const session = createSession(link)
    mainSessions.set(link.key, session)
    session.start()
    changed = true
    log(`connected to Host ${link.key} (${link.label}) at ${link.socketPath}`)
  }

  if (changed) {
    updateStatusBar()
    refreshTrees()
  }
}

function disposeMainSessions(): void {
  for (const [key, session] of mainSessions) {
    forgetHostWarnings(key)
    session.dispose()
  }
  mainSessions.clear()
}

function forgetHostWarnings(key: string): void {
  offlineWarnedHosts.delete(key)
  authWarnedHosts.delete(key)
}

function onConfigurationChanged(): void {
  const config = currentConfig()
  const autoConnect = config.get<boolean>('autoConnect', true)
  if (!autoConnect) {
    log('autoConnect is disabled; disposing every Host session')
    stopDiscovery()
    disposeMainSessions()
    updateStatusBar()
    refreshTrees()
    return
  }
  const root = currentRootStateDir()
  if (discoveryRoot !== root) {
    log(`stateDir changed to ${root}; rediscovering Hosts`)
    disposeMainSessions()
    startDiscovery()
    updateStatusBar()
    refreshTrees()
    return
  }
  if (discoveryTimer === undefined) startDiscovery()
  updateStatusBar()
}

function handleConnectionChanged(session: ReviewSession, info: IpcConnectionInfo): void {
  const key = hostKeyOf(session)
  if (info.connected) {
    forgetHostWarnings(key)
  } else if (info.authFailed === true) {
    if (!authWarnedHosts.has(key)) {
      authWarnedHosts.add(key)
      presentTransient(messages.authFailedError(info.error ?? 'invalid token'), 'error')
    }
  } else if (!offlineWarnedHosts.has(key)) {
    offlineWarnedHosts.add(key)
    presentTransient(messages.offlineWarning, 'warning')
  }
  updateStatusBar()
}

/** Keep every review surface in sync after a queue change. */
function onSessionStateChanged(): void {
  updateStatusBar()
  refreshTrees()
}

/**
 * Persist one settled decision and refresh the history view. Writes are
 * best-effort: history must never be able to break a decision.
 */
function onDecisionSettled(record: SettledReview): void {
  refreshTrees()
  const store = history
  if (store === undefined) return
  void store
    .append({
      requestId: record.requestId,
      displayPath: record.displayPath,
      toolName: record.toolName,
      mode: record.mode,
      status: historyStatusFor(record.outcome),
      outcome: record.outcome,
      edited: record.edited,
      at: record.at,
      ...(record.hostKey !== undefined ? { hostKey: record.hostKey } : {}),
    })
    .catch((error: unknown) => {
      log(`could not append review history: ${describeError(error)}`)
    })
}

function refreshTrees(): void {
  pendingProvider?.refresh()
  historyProvider?.refresh()
}

/** Pending-count badge on the activity-bar container; cleared at zero. */
function updatePendingBadge(): void {
  if (pendingTreeView === undefined) return
  const pending = mainSessionList().reduce((total, session) => total + session.pendingCount, 0)
  pendingTreeView.badge =
    pending > 0 ? { value: pending, tooltip: messages.pendingBadgeTooltip(pending) } : undefined
}

type TransientSeverity = 'info' | 'warning' | 'error'

/**
 * Show one transient plugin message for `dpr.messageDurationMs` in the status
 * bar, or fall back to a native VS Code notification when the user asks for it.
 */
function presentTransient(message: string, severity: TransientSeverity = 'info'): void {
  log(`[${severity}] ${message}`)
  const config = currentConfig()
  if (config.get<boolean>('useNativeNotifications', false) === true) {
    switch (severity) {
      case 'error':
        void vscode.window.showErrorMessage(message)
        return
      case 'warning':
        void vscode.window.showWarningMessage(message)
        return
      default:
        void vscode.window.showInformationMessage(message)
        return
    }
  }
  if (flashBar === undefined) return
  const duration = clampMessageDuration(config.get<number>('messageDurationMs', 5000))
  const icon = severity === 'error' ? '$(error)' : severity === 'warning' ? '$(warning)' : '$(info)'
  flashBar.text = `${icon} ${message}`
  flashBar.tooltip = message
  flashBar.backgroundColor =
    severity === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : severity === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined
  flashBar.show()
  if (flashTimer !== undefined) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashBar?.hide()
    flashTimer = undefined
  }, duration)
}

function updateStatusBar(): void {
  if (statusBar === undefined) return
  const sessions = mainSessionList()
  const connectedSessions = sessions.filter((session) => session.connected)
  const connectedCount = connectedSessions.length
  const pending = sessions.reduce((total, session) => total + session.pendingCount, 0)
  // " · OFF" only when at least one Host is connected and every connected Host
  // reports review inactive (ADR 0002 §6).
  const inactive = connectedCount > 0 && connectedSessions.every((session) => session.reviewPaused)
  const inactiveSuffix = inactive ? messages.inactiveSuffix : ''
  if (pending > 0) {
    const hostsWithPending = sessions.filter((session) => session.pendingCount > 0).length
    statusBar.text = `$(shield) ${messages.pendingStatus(pending, hostsWithPending)}${inactiveSuffix}`
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  } else if (connectedCount > 0) {
    statusBar.text = `$(shield) Pre-edit Review: ${messages.statusConnectedHosts(connectedCount)}${inactiveSuffix}`
    statusBar.backgroundColor = undefined
  } else {
    statusBar.text = `$(shield) Pre-edit Review: ${messages.statusOffline}`
    statusBar.backgroundColor = undefined
  }

  const root = discoveryRoot ?? currentRootStateDir()
  const tooltipLines = [messages.statusTooltip(root, clientVersion)]
  if (sessions.length === 0) {
    tooltipLines.push(messages.noHostsFound)
  } else {
    for (const session of sessions) {
      tooltipLines.push(
        messages.hostStatusLine(
          hostDisplayLabel(session),
          session.connected,
          session.pendingCount,
          session.reviewPaused,
        ),
      )
    }
  }
  if (inactive) tooltipLines.push(messages.inactiveTooltip)
  statusBar.tooltip = tooltipLines.join('\n')
  statusBar.show()

  // Decisions live on the editor-title buttons; the status bar is a single
  // indicator that opens the pending queue (no duplicate accept/reject items).
  const hasPending = pending > 0
  void vscode.commands.executeCommand('setContext', 'dpr.hasPending', hasPending)
  void vscode.commands.executeCommand('setContext', 'dpr.pendingCount', pending)
  updateProposalContext()
  updatePendingBadge()

  if (autoAcceptBar === undefined) return
  const armed = sessions.filter((session) => session.autoAcceptArmed)
  if (armed.length > 0) {
    const deadline = Math.min(...armed.map((session) => session.autoAcceptDeadline ?? Date.now()))
    autoAcceptBar.text = `$(zap) ${messages.autoAcceptStatus}`
    autoAcceptBar.tooltip = messages.autoAcceptTooltip(new Date(deadline))
    autoAcceptBar.command = 'dpr.acceptAll'
    autoAcceptBar.show()
  } else {
    autoAcceptBar.hide()
  }
}

/** Keep the `dpr.activeProposal` context key in sync with the focused editor. */
function updateProposalContext(): void {
  let active = vscode.window.activeTextEditor?.document.uri.scheme === DPR_SCHEME
  // In a diff editor the focused side may be the original file; the tab input
  // is the reliable source for "this tab shows a dpr proposal".
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab
  if (!active && tab?.input instanceof vscode.TabInputTextDiff) {
    active = tab.input.modified.scheme === DPR_SCHEME
  }
  void vscode.commands.executeCommand('setContext', 'dpr.activeProposal', active)
}

// ---------------------------------------------------------------------------
// Multi-Host routing (ADR 0002 §6)
// ---------------------------------------------------------------------------

interface SessionResolution {
  session: ReviewSession
}

interface SessionResolutionError {
  error: 'no-session' | 'no-pending' | 'ambiguous'
  labels: string[]
}

type Resolution = SessionResolution | SessionResolutionError

function isResolutionError(resolution: Resolution): resolution is SessionResolutionError {
  return 'error' in resolution
}

/** Self-test sessions first: the self-test drives the real dpr.* commands. */
function commandSessions(): ReviewSession[] {
  return [...selfTestSessions, ...mainSessionList()]
}

function requestIdFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg
  if (isRecord(arg) && typeof arg['requestId'] === 'string') return arg['requestId']
  return undefined
}

function hostKeyFromArg(arg: unknown): string | undefined {
  if (isRecord(arg) && typeof arg['hostKey'] === 'string') return arg['hostKey']
  return undefined
}

/** URI of the proposal diff that currently has focus (editor or diff tab). */
function activeProposalUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor
  if (editor !== undefined && editor.document.uri.scheme === DPR_SCHEME) return editor.document.uri
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab
  if (tab?.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === DPR_SCHEME) {
    return tab.input.modified
  }
  return undefined
}

function findSessionForRequest(requestId: string, hostKey?: string): ReviewSession | undefined {
  return commandSessions().find(
    (session) =>
      (hostKey === undefined || hostKeyOf(session) === hostKey) && session.hasPending(requestId),
  )
}

function findSessionForUri(uri: vscode.Uri): ReviewSession | undefined {
  return commandSessions().find((session) => session.ownsUri(uri))
}

/**
 * Resolve the session owning a decision command.
 *
 * Order: explicit `{requestId}` argument (highest priority, so pending-tree
 * rows route correctly regardless of focus), then the focused `dpr:` diff,
 * then "the only session with pending items". Multiple candidates produce a
 * clear routing error instead of guessing.
 */
function resolveSessionForArg(arg: unknown): Resolution {
  const requestId = requestIdFromArg(arg)
  if (requestId !== undefined) {
    const session = findSessionForRequest(requestId, hostKeyFromArg(arg))
    if (session !== undefined) return { session }
    return { error: 'no-pending', labels: [] }
  }
  const activeUri = activeProposalUri()
  if (activeUri !== undefined) {
    const session = findSessionForUri(activeUri)
    if (session !== undefined) return { session }
    // A focused dpr: document that no live review owns (e.g. a stale diff tab
    // from a previous extension version) must never let the decision fall
    // through to an unrelated pending review.
    return { error: 'no-pending', labels: [] }
  }
  const withPending = commandSessions().filter((session) => session.pendingCount > 0)
  if (withPending.length === 1 && withPending[0] !== undefined) return { session: withPending[0] }
  if (withPending.length === 0) {
    return { error: commandSessions().length === 0 ? 'no-session' : 'no-pending', labels: [] }
  }
  return { error: 'ambiguous', labels: withPending.map((session) => hostDisplayLabel(session)) }
}

function presentResolutionError(resolution: SessionResolutionError): void {
  if (resolution.error === 'ambiguous') {
    presentTransient(messages.ambiguousRoutingError(resolution.labels), 'warning')
    return
  }
  presentTransient(resolution.error === 'no-session' ? messages.notConnected : messages.noPendingReview)
}

/** Active proposal's Host, otherwise every Host with pending items (broadcast). */
function broadcastTargets(): ReviewSession[] {
  const activeUri = activeProposalUri()
  if (activeUri !== undefined) {
    const session = findSessionForUri(activeUri)
    if (session !== undefined) return [session]
  }
  return commandSessions().filter((session) => session.pendingCount > 0)
}

function presentNoTargets(): void {
  presentTransient(commandSessions().length === 0 ? messages.notConnected : messages.noPendingReview)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function normalizeArg(arg: unknown): ReviewCommandArg {
  if (typeof arg === 'string') return arg
  if (!isRecord(arg)) return undefined
  const normalized: DecisionCommandArg = {}
  if (typeof arg['requestId'] === 'string') normalized.requestId = arg['requestId']
  if (typeof arg['reason'] === 'string') normalized.reason = arg['reason']
  if (typeof arg['skipPrompt'] === 'boolean') normalized.skipPrompt = arg['skipPrompt']
  return normalized
}

function acceptCommand(arg?: unknown): Promise<void> {
  const resolution = resolveSessionForArg(arg)
  if (isResolutionError(resolution)) {
    presentResolutionError(resolution)
    return Promise.resolve()
  }
  log(`dpr.accept requestId=${requestIdFromArg(arg) ?? '(active)'} host=${hostKeyOf(resolution.session)}`)
  return resolution.session.accept(normalizeArg(arg)).catch((error: unknown) => {
    log(`dpr.accept failed: ${describeError(error)}`)
    presentTransient(describeError(error), 'warning')
  })
}

function rejectCommand(arg?: unknown): Promise<void> {
  const resolution = resolveSessionForArg(arg)
  if (isResolutionError(resolution)) {
    presentResolutionError(resolution)
    return Promise.resolve()
  }
  log(`dpr.reject requestId=${requestIdFromArg(arg) ?? '(active)'} host=${hostKeyOf(resolution.session)}`)
  return resolution.session.reject(normalizeArg(arg)).catch((error: unknown) => {
    log(`dpr.reject failed: ${describeError(error)}`)
    presentTransient(describeError(error), 'warning')
  })
}

/** Open one specific pending review (pending-tree row / palette). */
function openItemCommand(arg?: unknown): Promise<void> {
  const resolution = resolveSessionForArg(arg)
  if (isResolutionError(resolution)) {
    presentResolutionError(resolution)
    return Promise.resolve()
  }
  const requestId = requestIdFromArg(arg)
  if (requestId === undefined) {
    presentTransient(messages.noPendingReview)
    return Promise.resolve()
  }
  log(`dpr.openItem requestId=${requestId} host=${hostKeyOf(resolution.session)}`)
  return resolution.session.openReview(requestId).catch((error: unknown) => {
    log(`dpr.openItem failed: ${describeError(error)}`)
    presentTransient(describeError(error), 'warning')
  })
}

/** Reject every pending review; a multi-Host broadcast asks once first. */
async function rejectAllCommand(): Promise<void> {
  const targets = broadcastTargets()
  if (targets.length === 0) {
    presentNoTargets()
    return
  }
  if (targets.length > 1) {
    const labels = targets.map((session) => hostDisplayLabel(session)).join(', ')
    const confirmed = await vscode.window.showWarningMessage(
      messages.rejectAllConfirmMulti(labels),
      { modal: true },
      messages.rejectAllConfirmMultiYes,
    )
    if (confirmed !== messages.rejectAllConfirmMultiYes) return
  }
  for (const session of targets) {
    log(`dpr.rejectAll host=${hostKeyOf(session)} pending=${session.pendingCount}`)
    try {
      await session.rejectAll()
    } catch (error) {
      log(`dpr.rejectAll failed for ${hostKeyOf(session)}: ${describeError(error)}`)
      presentTransient(describeError(error), 'warning')
    }
  }
}

/**
 * Arm the auto-accept window. A single target keeps the per-session flow
 * (toggle off when armed + its own confirmation); several Hosts are covered by
 * one confirmation that names them.
 */
async function acceptAllCommand(): Promise<void> {
  const targets = broadcastTargets()
  if (targets.length === 0) {
    presentNoTargets()
    return
  }
  if (targets.length === 1 && targets[0] !== undefined) {
    await targets[0].acceptAll().catch((error: unknown) => {
      log(`dpr.acceptAll failed: ${describeError(error)}`)
      presentTransient(describeError(error), 'warning')
    })
    return
  }
  const anyArmed = targets.some((session) => session.autoAcceptArmed)
  if (anyArmed) {
    // Toggle off across every target Host so a mixed armed/unarmed state cannot
    // leave some Hosts armed after the user asked to disarm.
    let disarmed = 0
    for (const session of targets) {
      if (session.disarmAutoAcceptWindow()) disarmed += 1
    }
    if (disarmed > 0) presentTransient(messages.autoAcceptDisarmed)
    return
  }
  if (currentConfig().get<boolean>('autoAccept', false) !== true) {
    presentTransient(messages.autoAcceptDisabled, 'warning')
    return
  }
  const labels = targets.map((session) => hostDisplayLabel(session)).join(', ')
  const confirmed = await vscode.window.showWarningMessage(
    messages.acceptAllConfirmMulti(labels),
    { modal: true },
    messages.autoAcceptConfirmYes,
  )
  if (confirmed !== messages.autoAcceptConfirmYes) return
  for (const session of targets) session.armAutoAcceptWindow()
  presentTransient(messages.autoAcceptArmed(AUTO_ACCEPT_WINDOW_MINUTES))
}

interface AggregatedPendingPick extends vscode.QuickPickItem {
  session: ReviewSession
  requestId: string
}

/** Aggregated pending queue: one QuickPick item per review, tagged by Host. */
async function showPendingCommand(): Promise<void> {
  revealPendingView()
  const sessions = mainSessionList()
  if (sessions.length === 0) {
    presentTransient(messages.notConnected)
    return
  }
  const items: AggregatedPendingPick[] = []
  for (const session of sessions) {
    const hostLabel = session.isLegacy ? undefined : session.displayLabel
    for (const review of session.pendingList()) {
      const base = messages.pendingPickDescription(review.params.mode, review.params.toolName)
      items.push({
        label: `$(file) ${review.params.displayPath}`,
        description: hostLabel === undefined ? base : `${base}${messages.hostSuffix(hostLabel)}`,
        detail: review.params.absolutePath,
        session,
        requestId: review.params.requestId,
      })
    }
  }
  if (items.length === 0) {
    presentTransient(messages.noPendingReview)
    return
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: messages.pendingPickPlaceholder,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  })
  if (picked === undefined) return
  if (!picked.session.hasPending(picked.requestId)) return
  await picked.session.openReview(picked.requestId).catch((error: unknown) => {
    log(`dpr.showPending open failed: ${describeError(error)}`)
    presentTransient(describeError(error), 'warning')
  })
}

async function clearHistoryCommand(): Promise<void> {
  const store = history
  if (store === undefined) return
  const confirmed = await vscode.window.showWarningMessage(
    messages.clearHistoryConfirm,
    { modal: true },
    messages.clearHistoryConfirmYes,
  )
  if (confirmed !== messages.clearHistoryConfirmYes) return
  try {
    await store.clear()
    log('review history cleared')
    presentTransient(messages.clearHistoryDone)
  } catch (error) {
    log(`could not clear review history: ${describeError(error)}`)
    presentTransient(describeError(error), 'warning')
  }
}

/** Bring the pending view to the foreground; quick-pick semantics stay intact. */
function revealPendingView(): void {
  void revealCommand('workbench.view.extension.dpr')
  void revealCommand(`${PENDING_VIEW_ID}.focus`)
}

async function revealCommand(command: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(command)
  } catch (error) {
    log(`could not reveal the pending view (${command}): ${describeError(error)}`)
  }
}

function reconnectCommand(): void {
  if (currentConfig().get<boolean>('autoConnect', true) !== true) {
    presentTransient(messages.notConnected)
    return
  }
  const sessions = mainSessionList()
  if (sessions.length === 0) {
    startDiscovery()
  } else {
    log('manual reconnect requested for every Host')
    for (const session of sessions) session.reconnect()
  }
  presentTransient(messages.reconnectRequested)
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * VS Code restores editors from the previous window, including `dpr:` proposal
 * documents. Those documents only exist in the extension's in-memory store, so
 * a restored tab is a stale ghost that can never be decided. Sweep them shortly
 * after activation (twice: the restore order relative to activation varies).
 */
function scheduleStaleDprTabCleanup(): void {
  const sweep = (): void => {
    void closeStaleDprTabs().catch((error: unknown) => {
      log(`stale dpr: tab cleanup failed: ${describeError(error)}`)
    })
  }
  for (const delay of [250, 1_200]) {
    const timer = setTimeout(sweep, delay)
    timer.unref?.()
    staleTabTimers.push(timer)
  }
}

/** URIs of a tab whose editor belongs to this extension. */
function tabDprUris(tab: vscode.Tab): vscode.Uri[] {
  const input = tab.input as unknown
  if (typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  const uris: vscode.Uri[] = []
  for (const field of ['uri', 'original', 'modified']) {
    const value = record[field]
    if (value instanceof vscode.Uri && value.scheme === DPR_SCHEME) uris.push(value)
  }
  return uris
}

/** Close ghost `dpr:` editors restored from a previous window. */
async function closeStaleDprTabs(): Promise<void> {
  const stale: vscode.Tab[] = []
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tabDprUris(tab).length > 0) stale.push(tab)
    }
  }
  if (stale.length === 0) return
  log(`closing ${stale.length} stale dpr: editor tab(s) restored from a previous window`)
  await vscode.window.tabGroups.close(stale, true)
}

function scheduleAutoSelfTest(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder === undefined) {
    log('auto self-test skipped: no workspace folder is open')
    return
  }
  // Opt-in trigger: a `.spike` directory alone must NOT start the self-test.
  // The self-test opens several diff editors, and workspaces that merely used
  // the extension (e.g. this repository, whose `.spike/` holds past e2e output)
  // must not see diffs flash on every window start.
  const marker = path.join(folder.uri.fsPath, '.spike', 'auto-selftest')
  void fs
    .stat(marker)
    .then((stat) => {
      if (!stat.isFile()) {
        log(`auto self-test skipped: ${marker} is not a file`)
        return
      }
      const timer = setTimeout(() => {
        void autoRunSelfTest()
      }, AUTO_SELF_TEST_DELAY_MS)
      context.subscriptions.push({
        dispose: (): void => clearTimeout(timer),
      })
      log(`self-test scheduled in ~${AUTO_SELF_TEST_DELAY_MS} ms (marker: ${marker})`)
    })
    .catch(() => {
      log(`auto self-test skipped: ${marker} does not exist (create it to auto-run the self-test)`)
    })
}

async function autoRunSelfTest(): Promise<void> {
  if (selfTestAutoRan || selfTestInFlight !== undefined) return
  selfTestAutoRan = true
  if (mainSessionList().some((session) => session.pendingCount > 0)) {
    log(messages.selfTestSkippedPending)
    return
  }
  await runSelfTestCommand('auto')
}

function runSelfTestCommand(trigger: 'auto' | 'command'): Promise<SelfTestReport | undefined> {
  if (selfTestInFlight !== undefined) return selfTestInFlight
  if (provider === undefined || history === undefined) return Promise.resolve(undefined)
  if (trigger === 'command') selfTestAutoRan = true
  log(`running extension self-test (${trigger})`)
  const run = runExtensionSelfTest({
    trigger,
    clientVersion,
    messages,
    provider,
    history,
    setSessions: (sessions): void => {
      selfTestSessions = sessions === undefined ? [] : [...sessions]
    },
    log: (message): void => log(message),
  }).catch((error: unknown) => {
    log(`self-test crashed: ${describeError(error)}`)
    return undefined
  })
  selfTestInFlight = run
  void run.then(
    () => {
      selfTestInFlight = undefined
    },
    () => {
      selfTestInFlight = undefined
    },
  )
  return run
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`)
}
