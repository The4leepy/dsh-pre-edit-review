/**
 * DeepSeek Pre-edit Review — VS Code client.
 *
 * Responsibilities:
 * - register the editable `dpr:` FileSystemProvider used as the right side of
 *   `vscode.diff`;
 * - connect to the Host plugin's Unix domain socket, authenticate with the
 *   token file, and show one diff per `review/request`;
 * - turn Accept/Reject into a protocol `decision` request (the only mutation
 *   the extension can trigger);
 * - expose the pending/review-history activity-bar views, status / queue /
 *   auto-accept commands, and run an in-process self-test against a mock Host.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import * as vscode from 'vscode'

import { DPR_SCHEME, DprFileSystemProvider } from './fs-provider.ts'
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
import { describeError, expandHome, isRecord } from './util.ts'

const SETTINGS_SECTION = 'dpr'
const AUTO_SELF_TEST_DELAY_MS = 2000
const PENDING_VIEW_ID = 'dpr.pendingView'

let provider: DprFileSystemProvider | undefined
let providerRegistration: vscode.Disposable | undefined
let mainSession: ReviewSession | undefined
let selfTestSession: ReviewSession | undefined
let statusBar: vscode.StatusBarItem | undefined
let autoAcceptBar: vscode.StatusBarItem | undefined
let output: vscode.OutputChannel | undefined
let history: ReviewHistoryStore | undefined
let pendingProvider: PendingReviewsProvider | undefined
let historyProvider: HistoryReviewsProvider | undefined
let pendingTreeView: vscode.TreeView<PendingReviewTreeItem> | undefined
let historyTreeView: vscode.TreeView<HistoryReviewTreeItem> | undefined
let messages: Messages = pickMessages('en')
let clientVersion = '0.0.0'
let offlineWarned = false
let authWarned = false
let selfTestAutoRan = false
let selfTestInFlight: Promise<SelfTestReport | undefined> | undefined

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

  // -- activity-bar views (Phase 3) ----------------------------------------
  history = new ReviewHistoryStore({
    memento: context.workspaceState,
    onChanged: (): void => {
      historyProvider?.refresh()
    },
  })
  historyProvider = new HistoryReviewsProvider(history, messages)
  pendingProvider = new PendingReviewsProvider(() => mainSession, messages)
  pendingTreeView = tryCreateTreeView(PENDING_VIEW_ID, pendingProvider)
  historyTreeView = tryCreateTreeView('dpr.historyView', historyProvider)
  if (pendingTreeView !== undefined) context.subscriptions.push(pendingTreeView)
  if (historyTreeView !== undefined) context.subscriptions.push(historyTreeView)
  context.subscriptions.push(pendingProvider, historyProvider)

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
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
    vscode.commands.registerCommand('dpr.acceptAll', () => withMainSession((session) => session.acceptAll())),
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
    startMainSession()
  } else {
    log('autoConnect is disabled; not starting the IPC client')
  }

  scheduleAutoSelfTest(context)
}

export function deactivate(): void {
  selfTestSession?.dispose()
  selfTestSession = undefined
  mainSession?.dispose()
  mainSession = undefined
  providerRegistration?.dispose()
  providerRegistration = undefined
  provider?.dispose()
  provider = undefined
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

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

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

function currentConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SETTINGS_SECTION)
}

function resolveStateDir(raw: string | undefined): string {
  return expandHome(raw ?? '~/.dsh/pre-edit-review')
}

function createSession(stateDir: string): ReviewSession {
  if (provider === undefined) throw new Error('the dpr file system provider is not registered yet')
  return new ReviewSession({
    stateDir,
    clientVersion,
    messages,
    provider,
    onStateChanged: (): void => onSessionStateChanged(),
    onSettled: (record): void => onDecisionSettled(record),
    onConnectionChanged: (info): void => handleConnectionChanged(info),
    onLog: (message): void => log(message),
  })
}

function startMainSession(): void {
  if (mainSession !== undefined) return
  const stateDir = resolveStateDir(currentConfig().get<string>('stateDir'))
  log(`starting IPC client against ${stateDir}`)
  mainSession = createSession(stateDir)
  mainSession.start()
  updateStatusBar()
}

function stopMainSession(): void {
  if (mainSession === undefined) return
  log('stopping IPC client')
  mainSession.dispose()
  mainSession = undefined
  offlineWarned = false
  authWarned = false
  updateStatusBar()
}

function onConfigurationChanged(): void {
  const config = currentConfig()
  const autoConnect = config.get<boolean>('autoConnect', true)
  if (!autoConnect) {
    stopMainSession()
    updateStatusBar()
    return
  }
  const stateDir = resolveStateDir(config.get<string>('stateDir'))
  if (mainSession === undefined) {
    startMainSession()
  } else if (mainSession.stateDir !== stateDir) {
    log(`stateDir changed to ${stateDir}; reconnecting`)
    stopMainSession()
    startMainSession()
  }
  updateStatusBar()
}

function handleConnectionChanged(info: IpcConnectionInfo): void {
  if (info.connected) {
    offlineWarned = false
    authWarned = false
  } else if (info.authFailed === true) {
    if (!authWarned) {
      authWarned = true
      void vscode.window.showErrorMessage(messages.authFailedError(info.error ?? 'invalid token'))
    }
  } else if (!offlineWarned) {
    offlineWarned = true
    void vscode.window.showWarningMessage(messages.offlineWarning)
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
  const pending = mainSession?.pendingCount ?? 0
  pendingTreeView.badge =
    pending > 0 ? { value: pending, tooltip: messages.pendingBadgeTooltip(pending) } : undefined
}

function updateStatusBar(): void {
  if (statusBar === undefined) return
  const connected = mainSession?.connected === true
  const pending = mainSession?.pendingCount ?? 0
  const state = connected ? messages.statusConnected : messages.statusOffline
  if (pending > 0) {
    statusBar.text = `$(shield) ${messages.pendingStatus(pending)}`
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  } else {
    statusBar.text = `$(shield) Pre-edit Review: ${state}`
    statusBar.backgroundColor = undefined
  }
  statusBar.tooltip = messages.statusTooltip(
    mainSession?.stateDir ?? resolveStateDir(currentConfig().get<string>('stateDir')),
    clientVersion,
  )
  statusBar.show()

  // Decisions live on the editor-title buttons; the status bar is a single
  // indicator that opens the pending queue (no duplicate accept/reject items).
  const hasPending = pending > 0
  void vscode.commands.executeCommand('setContext', 'dpr.hasPending', hasPending)
  void vscode.commands.executeCommand('setContext', 'dpr.pendingCount', pending)
  updateProposalContext()
  updatePendingBadge()

  if (autoAcceptBar === undefined) return
  if (mainSession?.autoAcceptArmed === true) {
    const deadline = mainSession.autoAcceptDeadline ?? Date.now()
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
  const active = vscode.window.activeTextEditor?.document.uri.scheme === DPR_SCHEME
  void vscode.commands.executeCommand('setContext', 'dpr.activeProposal', active)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function requestIdFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg
  if (isRecord(arg) && typeof arg['requestId'] === 'string') return arg['requestId']
  return undefined
}

function normalizeArg(arg: unknown): ReviewCommandArg {
  if (typeof arg === 'string') return arg
  if (!isRecord(arg)) return undefined
  const normalized: DecisionCommandArg = {}
  if (typeof arg['requestId'] === 'string') normalized.requestId = arg['requestId']
  if (typeof arg['reason'] === 'string') normalized.reason = arg['reason']
  if (typeof arg['skipPrompt'] === 'boolean') normalized.skipPrompt = arg['skipPrompt']
  return normalized
}

/**
 * Accept/Reject must reach the session that owns the request: while the
 * self-test runs, its own session is active, but a real pending request must
 * still be routed to the main session.
 */
function commandSession(arg: unknown): ReviewSession | undefined {
  const requestId = requestIdFromArg(arg)
  if (requestId !== undefined) {
    if (selfTestSession?.hasPending(requestId) === true) return selfTestSession
    if (mainSession?.hasPending(requestId) === true) return mainSession
  }
  return selfTestSession ?? mainSession
}

function acceptCommand(arg?: unknown): Promise<void> {
  const session = commandSession(arg)
  if (session === undefined) {
    void vscode.window.showInformationMessage(messages.notConnected)
    return Promise.resolve()
  }
  log(`dpr.accept requestId=${requestIdFromArg(arg) ?? '(active)'}`)
  return session.accept(normalizeArg(arg)).catch((error: unknown) => {
    log(`dpr.accept failed: ${describeError(error)}`)
    void vscode.window.showWarningMessage(describeError(error))
  })
}

function rejectCommand(arg?: unknown): Promise<void> {
  const session = commandSession(arg)
  if (session === undefined) {
    void vscode.window.showInformationMessage(messages.notConnected)
    return Promise.resolve()
  }
  log(`dpr.reject requestId=${requestIdFromArg(arg) ?? '(active)'}`)
  return session.reject(normalizeArg(arg)).catch((error: unknown) => {
    log(`dpr.reject failed: ${describeError(error)}`)
    void vscode.window.showWarningMessage(describeError(error))
  })
}

/** Open one specific pending review (pending-tree row / palette). */
function openItemCommand(arg?: unknown): Promise<void> {
  const session = commandSession(arg)
  if (session === undefined) {
    void vscode.window.showInformationMessage(messages.notConnected)
    return Promise.resolve()
  }
  const requestId = requestIdFromArg(arg)
  if (requestId === undefined) {
    void vscode.window.showInformationMessage(messages.noPendingReview)
    return Promise.resolve()
  }
  log(`dpr.openItem requestId=${requestId}`)
  return session.openReview(requestId).catch((error: unknown) => {
    log(`dpr.openItem failed: ${describeError(error)}`)
    void vscode.window.showWarningMessage(describeError(error))
  })
}

/** Reject every pending review; disarms auto-accept first (see ReviewSession). */
function rejectAllCommand(): Promise<void> {
  const session = commandSession(undefined)
  if (session === undefined) {
    void vscode.window.showInformationMessage(messages.notConnected)
    return Promise.resolve()
  }
  log(`dpr.rejectAll pending=${session.pendingCount}`)
  return session.rejectAll().catch((error: unknown) => {
    log(`dpr.rejectAll failed: ${describeError(error)}`)
    void vscode.window.showWarningMessage(describeError(error))
  })
}

async function showPendingCommand(): Promise<void> {
  revealPendingView()
  await withMainSession((session) => session.showPending())
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
    void vscode.window.showInformationMessage(messages.clearHistoryDone)
  } catch (error) {
    log(`could not clear review history: ${describeError(error)}`)
    void vscode.window.showWarningMessage(describeError(error))
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

function withMainSession(action: (session: ReviewSession) => Promise<void>): Promise<void> {
  if (mainSession === undefined) {
    void vscode.window.showInformationMessage(messages.notConnected)
    return Promise.resolve()
  }
  return action(mainSession).catch((error: unknown) => {
    log(`command failed: ${describeError(error)}`)
    void vscode.window.showWarningMessage(describeError(error))
  })
}

function reconnectCommand(): void {
  if (mainSession === undefined) {
    if (currentConfig().get<boolean>('autoConnect', true)) {
      startMainSession()
    } else {
      void vscode.window.showInformationMessage(messages.notConnected)
    }
    return
  }
  log('manual reconnect requested')
  mainSession.reconnect()
  void vscode.window.showInformationMessage(messages.reconnectRequested)
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function scheduleAutoSelfTest(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder === undefined) {
    log('auto self-test skipped: no workspace folder is open')
    return
  }
  const spikeDir = path.join(folder.uri.fsPath, '.spike')
  void fs
    .stat(spikeDir)
    .then((stat) => {
      if (!stat.isDirectory()) {
        log(`auto self-test skipped: ${spikeDir} is not a directory`)
        return
      }
      const timer = setTimeout(() => {
        void autoRunSelfTest()
      }, AUTO_SELF_TEST_DELAY_MS)
      context.subscriptions.push({
        dispose: (): void => clearTimeout(timer),
      })
      log(`self-test scheduled in ~${AUTO_SELF_TEST_DELAY_MS} ms (spike dir: ${spikeDir})`)
    })
    .catch(() => {
      log(`auto self-test skipped: ${spikeDir} does not exist`)
    })
}

async function autoRunSelfTest(): Promise<void> {
  if (selfTestAutoRan || selfTestInFlight !== undefined) return
  selfTestAutoRan = true
  if (mainSession !== undefined && mainSession.pendingCount > 0) {
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
    setSession: (session): void => {
      selfTestSession = session
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
