/**
 * In-process extension self-test.
 *
 * It starts **mock Hosts** on temporary Unix domain sockets (real NDJSON
 * JSON-RPC, real token files) and drives the real `dpr.*` commands through the
 * extension's routing:
 *
 *   - legacy phase (0.2.x layout): one Host at the root of the state dir;
 *   - multi-Host phase (ADR 0002): two Hosts under `<root>/hosts/<key>` with
 *     `meta.json` descriptors, so discovery, aggregated pending rows, routing
 *     and the per-Host diff title are exercised end to end.
 *
 * Scenarios in the legacy phase:
 *   1. accept-with-edit: a `review/request` is sent, the self-test applies a
 *      `WorkspaceEdit` to the proposed document (as if the user typed), calls
 *      the accept command, and asserts the mock received a `decision` whose
 *      `finalContent` contains the edit marker.
 *   2. reject: a second request is sent, the reject command is called and the
 *      mock asserts `status === 'reject'`.
 *   3. reject-all drains a fresh pending review.
 *
 * The JSON report is always written to `<workspace>/.spike/ext-selftest.json`
 * (when a workspace folder is open), even when a step fails.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as vscode from 'vscode'

import type { HostDescriptor } from '../../shared/src/host.ts'
import {
  METHODS,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  encodeFrame,
  isDecisionParams,
  isHelloParams,
  splitFrames,
} from '../../shared/src/protocol.ts'
import type { DecisionParams, ReviewRequestParams } from '../../shared/src/protocol.ts'
import type { DecisionOutcome } from '../../shared/src/review-record.ts'
import {
  DPR_SCHEME,
  emptyOriginalUriFor,
  proposalUriFor,
  requestIdOfPath,
  type DprFileSystemProvider,
} from './fs-provider.ts'
import { discoverHostLinks } from './host-registry.ts'
import type { HostLink } from './host-registry.ts'
import type { HistoryEntry, ReviewHistoryStore } from './history-store.ts'
import type { Messages } from './i18n.ts'
import { ReviewSession } from './review-session.ts'
import { HistoryReviewsProvider, PendingReviewsProvider } from './tree-views.ts'
import { delay, describeError } from './util.ts'

const SELF_TEST_ID_PREFIX = 'selftest-'
const EDIT_MARKER = '/* DPR-SELFTEST-EDIT */'
const SPIKE_DIR = '.spike'
const REPORT_FILE = 'ext-selftest.json'
const CLIENT_WAIT_MS = 8000
const DECISION_WAIT_MS = 12_000
const UI_WAIT_MS = 6000
const ROUTING_SETTLE_MS = 300

export interface SelfTestStep {
  name: string
  ok: boolean
  detail: string
}

/** One discovered Host, recorded in the report (multi-Host evidence). */
export interface SelfTestHostReport {
  key: string
  label: string
  legacy: boolean
  socketPath: string
  connected: boolean
  pending: number
}

export interface SelfTestReport {
  ok: boolean
  vscodeVersion: string
  steps: SelfTestStep[]
  /** Discovered Hosts at the end of the multi-Host phase (ADR 0002). */
  hosts?: SelfTestHostReport[]
  error?: string
}

export interface SelfTestOptions {
  trigger: 'auto' | 'command'
  clientVersion: string
  messages: Messages
  provider: DprFileSystemProvider
  /** Real persistence helper over `context.workspaceState` (Phase 3 history). */
  history: ReviewHistoryStore
  /** Route the dpr.* commands to the self-test sessions while it runs. */
  setSessions(sessions: readonly ReviewSession[] | undefined): void
  log?(message: string): void
}

interface MockHostIdentity {
  key: string
  label: string
}

interface DecisionWaiter {
  resolve(decision: DecisionParams): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface ReviewRequestFixture {
  requestId: string
  params: ReviewRequestParams
  absolutePath: string
  targetPath: string
  before: string
  after: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function nonce(): string {
  return randomBytes(24).toString('hex')
}

function randomSuffix(): string {
  return randomBytes(4).toString('hex')
}

class MockHost {
  readonly stateDir: string
  readonly socketPath: string
  readonly tokenPath: string
  readonly identity: MockHostIdentity | undefined
  private readonly token: string
  private server: Server | undefined
  private socket: Socket | undefined
  private buffer = ''
  private authed = false
  private readonly decisions = new Map<string, DecisionParams>()
  private readonly waiters = new Map<string, DecisionWaiter>()
  private readonly outcomes = new Map<string, DecisionOutcome>()

  constructor(stateDir: string, identity?: MockHostIdentity) {
    this.stateDir = stateDir
    this.socketPath = join(stateDir, 'ipc.sock')
    this.tokenPath = join(stateDir, 'token')
    this.identity = identity
    this.token = randomBytes(32).toString('hex')
  }

  async start(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(this.tokenPath, this.token, { encoding: 'utf8', mode: 0o600 })
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(this.socketPath, () => {
        server.removeListener('error', onError)
        server.on('error', () => undefined)
        resolve()
      })
    })
    await fs.chmod(this.socketPath, 0o600).catch(() => undefined)
  }

  /** Publish the 0.3.0 `meta.json` descriptor so discovery can find this mock. */
  async publishDescriptor(pluginVersion: string): Promise<void> {
    if (this.identity === undefined) return
    const descriptor: HostDescriptor = {
      key: this.identity.key,
      label: this.identity.label,
      pid: process.pid,
      pluginVersion,
      startedAt: Date.now(),
      stateDir: this.stateDir,
      socketPath: this.socketPath,
      tokenPath: this.tokenPath,
    }
    await fs.writeFile(join(this.stateDir, 'meta.json'), JSON.stringify(descriptor), {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  get clientConnected(): boolean {
    return this.authed && this.socket !== undefined
  }

  /** Number of decisions this mock received (used to prove routing isolation). */
  get decisionCount(): number {
    return this.decisions.size
  }

  hasDecision(requestId: string): boolean {
    return this.decisions.has(requestId)
  }

  async waitForClient(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.clientConnected) return true
      await delay(25)
    }
    return this.clientConnected
  }

  setOutcome(requestId: string, outcome: DecisionOutcome): void {
    this.outcomes.set(requestId, outcome)
  }

  sendReviewRequest(params: ReviewRequestParams): void {
    if (this.socket === undefined || !this.authed) {
      throw new Error('mock Host has no authenticated client')
    }
    this.socket.write(encodeFrame({ jsonrpc: '2.0', method: METHODS.reviewRequest, params }))
  }

  waitForDecision(requestId: string, timeoutMs: number): Promise<DecisionParams> {
    const already = this.decisions.get(requestId)
    if (already !== undefined) return Promise.resolve(already)
    return new Promise<DecisionParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId)
        reject(new Error(`mock Host did not receive a decision for ${requestId} within ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiters.set(requestId, { resolve, reject, timer })
    })
  }

  async stop(): Promise<void> {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('mock Host stopped'))
    }
    this.waiters.clear()
    const socket = this.socket
    this.socket = undefined
    this.authed = false
    if (socket !== undefined) {
      socket.removeAllListeners()
      socket.destroy()
    }
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
    await fs.unlink(this.socketPath).catch(() => undefined)
    await fs.unlink(this.tokenPath).catch(() => undefined)
    await fs.unlink(join(this.stateDir, 'meta.json')).catch(() => undefined)
  }

  private accept(socket: Socket): void {
    if (this.socket !== undefined) {
      socket.destroy()
      return
    }
    this.socket = socket
    this.buffer = ''
    this.authed = false
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('close', () => this.onClose())
    socket.on('error', () => this.onClose())
  }

  private onClose(): void {
    if (this.socket === undefined) return
    this.socket = undefined
    this.authed = false
    this.buffer = ''
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('review client disconnected from the mock Host'))
    }
    this.waiters.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    const { lines, rest } = splitFrames(this.buffer)
    this.buffer = rest
    for (const line of lines) this.onFrame(line)
  }

  private send(message: unknown): void {
    this.socket?.write(encodeFrame(message))
  }

  private reply(id: string | number | null, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  private fail(id: string | number | null, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private onFrame(line: string): void {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      this.fail(null, RPC_ERRORS.PARSE_ERROR, 'invalid JSON frame')
      return
    }

    if (message?.method === METHODS.hello) {
      if (!isHelloParams(message.params) || message.params.protocolVersion !== PROTOCOL_VERSION) {
        this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, 'unsupported protocol or malformed hello')
        this.socket?.destroy()
        return
      }
      if (message.params.token !== this.token) {
        this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, 'invalid token')
        this.socket?.destroy()
        return
      }
      this.authed = true
      this.reply(message.id, {
        ok: true,
        serverVersion: 'dpr-ext-selftest-mock',
        stateDir: this.stateDir,
        ...(this.identity !== undefined
          ? { hostKey: this.identity.key, hostLabel: this.identity.label }
          : {}),
      })
      return
    }

    if (!this.authed) {
      this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, 'hello required before any other method')
      return
    }

    switch (message?.method) {
      case METHODS.decision: {
        if (!isDecisionParams(message.params)) {
          this.fail(message?.id ?? null, RPC_ERRORS.INVALID_PARAMS, 'invalid decision params')
          return
        }
        const params: DecisionParams = message.params
        this.decisions.set(params.requestId, params)
        const outcome = this.outcomes.get(params.requestId) ?? (params.status === 'accept' ? 'committed' : 'rejected')
        this.reply(message.id, { ok: true, outcome })
        const waiter = this.waiters.get(params.requestId)
        if (waiter !== undefined) {
          this.waiters.delete(params.requestId)
          clearTimeout(waiter.timer)
          waiter.resolve(params)
        }
        return
      }
      case METHODS.ack:
        this.reply(message.id, { ok: true })
        return
      case METHODS.autoAccept:
        this.reply(message.id, { ok: true })
        return
      case METHODS.ping:
        this.reply(message.id, { pong: true, now: Date.now() })
        return
      default:
        this.fail(message?.id ?? null, RPC_ERRORS.METHOD_NOT_FOUND, `unknown method: ${String(message?.method)}`)
    }
  }
}

function resolveWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]
  return folder?.uri.fsPath
}

function reportPathFor(workspaceRoot: string | undefined): string | undefined {
  return workspaceRoot === undefined ? undefined : join(workspaceRoot, SPIKE_DIR, REPORT_FILE)
}

async function writeReport(path: string | undefined, report: SelfTestReport, log: (message: string) => void): Promise<void> {
  if (path === undefined) {
    log(`self-test report not written: no workspace folder is open`)
    return
  }
  try {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    log(`self-test report written to ${path}`)
  } catch (error) {
    log(`self-test report could not be written: ${describeError(error)}`)
  }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, intervalMs = 50): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) return undefined
    await delay(intervalMs)
  }
}

/** Read a tree provider root synchronously-ish, normalising `ProviderResult`. */
async function childrenOf<T>(provider: vscode.TreeDataProvider<T>): Promise<readonly T[]> {
  const children = await provider.getChildren()
  return children ?? []
}

function findDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const target = uri.toString()
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === target)
}

function hasDiffTab(uri: vscode.Uri): boolean {
  return findDiffTab(uri) !== undefined
}

function findDiffTab(uri: vscode.Uri): vscode.Tab | undefined {
  const target = uri.toString()
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === target) return tab
    }
  }
  return undefined
}

async function closeSelfTestTabs(): Promise<void> {
  const tabs: vscode.Tab[] = []
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === DPR_SCHEME) {
        const requestId = requestIdOfPath(input.modified.path)
        if (requestId !== undefined && requestId.startsWith(SELF_TEST_ID_PREFIX)) tabs.push(tab)
      }
    }
  }
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs)
}

function buildFixture(directory: string, requestId: string, host?: MockHostIdentity): ReviewRequestFixture {
  const targetPath = join(directory, `${requestId}.ts`)
  const before = 'export const value = 1\n'
  const after = 'export const value = 2\n'
  const params: ReviewRequestParams = {
    requestId,
    nonce: nonce(),
    protocolVersion: PROTOCOL_VERSION,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    sessionId: 'ext-selftest',
    sessionLabel: 'VS Code extension self-test',
    toolName: 'write',
    callId: `call-${randomSuffix()}`,
    operation: 'update',
    displayPath: `src/${requestId}.ts`,
    absolutePath: targetPath,
    isNewFile: false,
    languageHint: 'typescript',
    before,
    after,
    beforeSha256: sha256(before),
    afterSha256: sha256(after),
    targetKind: 'direct-workspace',
    mode: 'tool-level',
    ...(host !== undefined ? { hostKey: host.key, hostLabel: host.label } : {}),
  }
  return { requestId, params, absolutePath: targetPath, targetPath, before, after }
}

function buildNewFileFixture(directory: string, requestId: string): ReviewRequestFixture {
  const targetPath = join(directory, `${requestId}-new.ts`)
  const after = 'export const created = true\n'
  const params: ReviewRequestParams = {
    requestId,
    nonce: nonce(),
    protocolVersion: PROTOCOL_VERSION,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    sessionId: 'ext-selftest',
    sessionLabel: 'VS Code extension self-test',
    toolName: 'write',
    callId: `call-${randomSuffix()}`,
    operation: 'create',
    displayPath: `src/${requestId}-new.ts`,
    absolutePath: targetPath,
    isNewFile: true,
    languageHint: 'typescript',
    before: null,
    after,
    beforeSha256: null,
    afterSha256: sha256(after),
    targetKind: 'direct-workspace',
    mode: 'tool-level',
  }
  return { requestId, params, absolutePath: targetPath, targetPath, before: '', after }
}

interface SessionFixture {
  stateDir: string
  socketPath?: string
  tokenPath?: string
  hostKey?: string
  hostLabel?: string
}

function buildSession(
  fixture: SessionFixture,
  options: SelfTestOptions,
  log: (message: string) => void,
): ReviewSession {
  return new ReviewSession({
    stateDir: fixture.stateDir,
    ...(fixture.socketPath !== undefined ? { socketPath: fixture.socketPath } : {}),
    ...(fixture.tokenPath !== undefined ? { tokenPath: fixture.tokenPath } : {}),
    ...(fixture.hostKey !== undefined ? { hostKey: fixture.hostKey } : {}),
    ...(fixture.hostLabel !== undefined ? { hostLabel: fixture.hostLabel } : {}),
    clientVersion: options.clientVersion,
    messages: options.messages,
    provider: options.provider,
    quiet: true,
    onLog: log,
  })
}

/**
 * Run the mock-Host self-test. Legacy scenarios:
 *  1. accept with a user edit (proposal document + language + provider save);
 *  2. reject a new file (empty `dpr:` left side);
 *  3. reject-all drains a fresh pending review.
 *
 * Phase 3 additionally instantiates the real pending/history TreeDataProviders
 * and exercises the real `ReviewHistoryStore` over the workspace state.
 *
 * Phase 4 (ADR 0002) adds two Hosts under `<root>/hosts/<key>` with real
 * `meta.json` descriptors, then checks discovery, the aggregated pending view,
 * per-Host decision routing and the Host-labelled diff title.
 *
 * Always resolves with a report (except when no workspace folder is open, in
 * which case `error` describes that limitation).
 */
export async function runExtensionSelfTest(options: SelfTestOptions): Promise<SelfTestReport> {
  const steps: SelfTestStep[] = []
  const report: SelfTestReport = { ok: false, vscodeVersion: vscode.version, steps }
  const log = (message: string): void => options.log?.(message)
  const addStep = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail })
  }

  const workspaceRoot = resolveWorkspaceRoot()
  const reportPath = reportPathFor(workspaceRoot)
  let tempDir: string | undefined
  let mock: MockHost | undefined
  let session: ReviewSession | undefined
  let pendingProvider: PendingReviewsProvider | undefined
  let historyProvider: HistoryReviewsProvider | undefined
  // Multi-Host phase (ADR 0002).
  let discoveryRoot: string | undefined
  let alphaMock: MockHost | undefined
  let betaMock: MockHost | undefined
  let alphaSession: ReviewSession | undefined
  let betaSession: ReviewSession | undefined
  let multiPendingProvider: PendingReviewsProvider | undefined
  let alphaLink: HostLink | undefined
  let betaLink: HostLink | undefined

  try {
    addStep(
      'trigger',
      workspaceRoot !== undefined,
      `${options.trigger === 'auto' ? 'auto-run ~2 s after activation' : 'command dpr.runSelfTest'}; workspace=${
        workspaceRoot ?? 'NONE'
      }`,
    )
    if (workspaceRoot === undefined) {
      throw new Error('no workspace folder is open, cannot write .spike/ext-selftest.json')
    }
    await fs.mkdir(join(workspaceRoot, SPIKE_DIR), { recursive: true })

    tempDir = await fs.mkdtemp(join(tmpdir(), 'dpr-ext-selftest-'))
    mock = new MockHost(tempDir)
    await mock.start()
    addStep('mock-host', true, `mock Host listening on ${mock.socketPath}`)

    session = buildSession(
      { stateDir: mock.stateDir, socketPath: mock.socketPath },
      options,
      log,
    )
    options.setSessions([session])
    session.start()
    const connected = await mock.waitForClient(CLIENT_WAIT_MS)
    addStep('client-connect', connected, `client authenticated with the mock Host within ${CLIENT_WAIT_MS} ms`)
    if (!connected) throw new Error('the extension IPC client did not complete the hello handshake')

    // ----- Phase 3: tree providers + real history persistence ---------------
    pendingProvider = new PendingReviewsProvider(() => (session === undefined ? [] : [session]), options.messages)
    historyProvider = new HistoryReviewsProvider(options.history, options.messages)
    const syntheticHistory: HistoryEntry = {
      requestId: `${SELF_TEST_ID_PREFIX}history-${randomSuffix()}`,
      displayPath: 'src/self-test-history.ts',
      toolName: 'write',
      mode: 'tool-level',
      status: 'committed',
      outcome: 'committed',
      edited: true,
      at: Date.now(),
    }
    await options.history.append(syntheticHistory)
    const historyReadBack = options.history.list().find(
      (entry) => entry.requestId === syntheticHistory.requestId,
    )
    const historyRows = await childrenOf(historyProvider)
    const historyRow = historyRows.find((row) => row.entry.requestId === syntheticHistory.requestId)
    await options.history.remove(syntheticHistory.requestId)
    const historyCleaned = !options.history.list().some(
      (entry) => entry.requestId === syntheticHistory.requestId,
    )
    addStep(
      'history-store',
      historyReadBack !== undefined &&
        historyReadBack.status === 'committed' &&
        historyReadBack.outcome === 'committed' &&
        historyReadBack.edited === true &&
        historyRow !== undefined &&
        historyCleaned,
      `append/read-back requestId=${syntheticHistory.requestId} read=${historyReadBack?.status ?? 'MISSING'} treeRow=${
        historyRow !== undefined
      } cleaned=${historyCleaned}`,
    )

    // ----- scenario 1: accept with a user edit ------------------------------
    const acceptFixture = buildFixture(tempDir, `${SELF_TEST_ID_PREFIX}accept-${randomSuffix()}`)
    await fs.writeFile(acceptFixture.targetPath, acceptFixture.before, 'utf8')
    mock.setOutcome(acceptFixture.requestId, 'committed')
    mock.sendReviewRequest(acceptFixture.params)
    const opened = await waitFor(() => (session?.hasPending(acceptFixture.requestId) === true ? true : undefined), UI_WAIT_MS)
    addStep('review-request-1', opened === true, `requestId=${acceptFixture.requestId} pending=${opened === true}`)

    const proposalUri = proposalUriFor(acceptFixture.requestId, acceptFixture.params.displayPath)
    const document = await waitFor(() => findDocument(proposalUri), UI_WAIT_MS)
    addStep(
      'proposal-document-1',
      document !== undefined,
      `uri=${proposalUri.toString()} opened=${document !== undefined} contentLength=${document?.getText().length ?? -1}`,
    )
    if (document === undefined) throw new Error('the proposal document did not open for scenario 1')

    addStep(
      'language-1',
      document.languageId.length > 0,
      `languageId=${document.languageId} (left doc / languageHint=${acceptFixture.params.languageHint ?? 'none'})`,
    )

    const edit = new vscode.WorkspaceEdit()
    edit.insert(document.uri, document.positionAt(document.getText().length), EDIT_MARKER)
    const editApplied = await vscode.workspace.applyEdit(edit)
    addStep(
      'apply-edit-1',
      editApplied && document.getText().includes(EDIT_MARKER),
      `applyEdit=${editApplied} isDirty=${document.isDirty} textContainsMarker=${document.getText().includes(EDIT_MARKER)}`,
    )

    await vscode.commands.executeCommand('dpr.accept', { requestId: acceptFixture.requestId })
    addStep('accept-command-1', true, 'executed dpr.accept with the pending requestId')

    const decision1 = await mock.waitForDecision(acceptFixture.requestId, DECISION_WAIT_MS)
    const finalContent = decision1.finalContent ?? ''
    addStep(
      'decision-1',
      decision1.status === 'accept' && finalContent.includes(EDIT_MARKER),
      `status=${decision1.status} finalContentLength=${finalContent.length} containsMarker=${finalContent.includes(
        EDIT_MARKER,
      )} nonceMatches=${decision1.nonce === acceptFixture.params.nonce}`,
    )

    const tabClosed = await waitFor(() => (hasDiffTab(proposalUri) ? undefined : true), UI_WAIT_MS)
    addStep('tab-closed-1', tabClosed === true, `diff tab closed after accept=${tabClosed === true}`)

    const saved = await waitFor(
      () => {
        const write = options.provider.lastWriteFor(acceptFixture.requestId)
        return write !== undefined && write.content.includes(EDIT_MARKER) ? write : undefined
      },
      UI_WAIT_MS,
    )
    addStep(
      'provider-save-1',
      saved !== undefined,
      saved === undefined
        ? 'the dpr provider never received the final text through document.save()'
        : `provider.writeFile received ${saved.content.length} chars containing the marker`,
    )

    // Settle scenario 1 before measuring the pending tree in scenario 2.
    await waitFor(() => (session?.pendingCount === 0 ? true : undefined), UI_WAIT_MS)

    // ----- scenario 2: reject a NEW file (also exercises the dpr: empty left side)
    const rejectFixture = buildNewFileFixture(tempDir, `${SELF_TEST_ID_PREFIX}reject-${randomSuffix()}`)
    mock.setOutcome(rejectFixture.requestId, 'rejected')
    mock.sendReviewRequest(rejectFixture.params)
    const openedReject = await waitFor(
      () => (session?.hasPending(rejectFixture.requestId) === true ? true : undefined),
      UI_WAIT_MS,
    )
    addStep(
      'review-request-2',
      openedReject === true,
      `new-file requestId=${rejectFixture.requestId} pending=${openedReject === true}`,
    )

    const rejectProposalUri = proposalUriFor(rejectFixture.requestId, rejectFixture.params.displayPath)
    const rejectDocument = await waitFor(() => findDocument(rejectProposalUri), UI_WAIT_MS)
    addStep(
      'proposal-document-2',
      rejectDocument !== undefined,
      `uri=${rejectProposalUri.toString()} opened=${rejectDocument !== undefined}`,
    )

    const rejectOriginalUri = emptyOriginalUriFor(rejectFixture.requestId, rejectFixture.params.displayPath)
    const rejectOriginalDocument = await waitFor(() => findDocument(rejectOriginalUri), UI_WAIT_MS / 2)
    let leftText: string | null = rejectOriginalDocument?.getText() ?? null
    if (leftText === null) {
      // Some VS Code builds open the left diff side lazily; the dpr document must
      // still read back as empty either way.
      leftText = Buffer.from(await vscode.workspace.fs.readFile(rejectOriginalUri)).toString('utf8')
    }
    addStep(
      'new-file-empty-original',
      leftText === '',
      `left side=${rejectOriginalUri.toString()} renderedDocument=${
        rejectOriginalDocument !== undefined
      } text=${JSON.stringify(leftText)} (the real file does not exist on disk)`,
    )

    const pendingRows = await childrenOf(pendingProvider)
    const pendingRow = pendingRows.find((row) => row.requestId === rejectFixture.requestId)
    addStep(
      'pending-tree-2',
      pendingRows.length === 1 &&
        pendingRow !== undefined &&
        pendingRow.contextValue === 'pendingReview' &&
        pendingRow.description === options.messages.pendingPickDescription('tool-level', 'write'),
      `rows=${pendingRows.length} requestId=${pendingRow?.requestId ?? 'MISSING'} context=${
        pendingRow?.contextValue ?? 'MISSING'
      } description=${JSON.stringify(pendingRow?.description ?? null)}`,
    )

    await vscode.commands.executeCommand('dpr.reject', {
      requestId: rejectFixture.requestId,
      reason: 'self-test rejection',
      skipPrompt: true,
    })
    addStep('reject-command-2', true, 'executed dpr.reject with skipPrompt=true')

    const decision2 = await mock.waitForDecision(rejectFixture.requestId, DECISION_WAIT_MS)
    addStep(
      'decision-2',
      decision2.status === 'reject',
      `status=${decision2.status} reason=${JSON.stringify(decision2.reason ?? null)} finalContent=${
        decision2.finalContent === undefined ? 'absent' : 'unexpectedly present'
      }`,
    )

    const rejectTabClosed = await waitFor(() => (hasDiffTab(rejectProposalUri) ? undefined : true), UI_WAIT_MS)
    addStep('tab-closed-2', rejectTabClosed === true, `diff tab closed after reject=${rejectTabClosed === true}`)

    const targetExists = await fs
      .access(rejectFixture.targetPath)
      .then(() => true)
      .catch(() => false)
    addStep(
      'original-untouched-2',
      targetExists === false,
      `new-file target ${rejectFixture.targetPath} exists=${targetExists} (the extension never writes the workspace)`,
    )

    const drained2 = await waitFor(
      () => (session?.hasPending(rejectFixture.requestId) === false ? true : undefined),
      UI_WAIT_MS,
    )
    const pendingRowsAfterReject = await childrenOf(pendingProvider)
    addStep(
      'pending-tree-empty-2',
      drained2 === true && pendingRowsAfterReject.length === 0,
      `pending=${session?.pendingCount ?? -1} rows=${pendingRowsAfterReject.length} (empty once decided)`,
    )

    // ----- scenario 3: dpr.rejectAll drains the pending queue ---------------
    const rejectAllFixture = buildFixture(tempDir, `${SELF_TEST_ID_PREFIX}rejectall-${randomSuffix()}`)
    await fs.writeFile(rejectAllFixture.targetPath, rejectAllFixture.before, 'utf8')
    mock.setOutcome(rejectAllFixture.requestId, 'rejected')
    mock.sendReviewRequest(rejectAllFixture.params)
    const openedRejectAll = await waitFor(
      () => (session?.hasPending(rejectAllFixture.requestId) === true ? true : undefined),
      UI_WAIT_MS,
    )
    addStep(
      'review-request-3',
      openedRejectAll === true,
      `requestId=${rejectAllFixture.requestId} pending=${openedRejectAll === true}`,
    )

    const rejectAllProposalUri = proposalUriFor(rejectAllFixture.requestId, rejectAllFixture.params.displayPath)
    const rejectAllDocument = await waitFor(() => findDocument(rejectAllProposalUri), UI_WAIT_MS)
    addStep(
      'proposal-document-3',
      rejectAllDocument !== undefined,
      `uri=${rejectAllProposalUri.toString()} opened=${rejectAllDocument !== undefined}`,
    )

    const rejectAllRows = await childrenOf(pendingProvider)
    const rejectAllRow = rejectAllRows.find((row) => row.requestId === rejectAllFixture.requestId)
    addStep(
      'pending-tree-3',
      rejectAllRow !== undefined && rejectAllRows.length === 1,
      `rows=${rejectAllRows.length} requestId=${rejectAllRow?.requestId ?? 'MISSING'}`,
    )

    const pendingBeforeRejectAll = session.pendingCount
    await vscode.commands.executeCommand('dpr.rejectAll')
    addStep(
      'rejectall-command-3',
      pendingBeforeRejectAll === 1 && session.pendingCount === 0,
      `dpr.rejectAll resolved; pending before=${pendingBeforeRejectAll} after=${session.pendingCount}`,
    )

    const decision3 = await mock.waitForDecision(rejectAllFixture.requestId, DECISION_WAIT_MS)
    addStep(
      'decision-3',
      decision3.status === 'reject',
      `status=${decision3.status} reason=${JSON.stringify(decision3.reason ?? null)}`,
    )

    const drained3 = await waitFor(() => (session?.pendingCount === 0 ? true : undefined), UI_WAIT_MS)
    const pendingRowsAfterRejectAll = await childrenOf(pendingProvider)
    addStep(
      'rejectall-drained-3',
      drained3 === true && pendingRowsAfterRejectAll.length === 0 && session.autoAcceptArmed === false,
      `pending=${session.pendingCount} rows=${pendingRowsAfterRejectAll.length} autoAccept=${session.autoAcceptArmed}`,
    )

    // ----- Phase 4 (ADR 0002): multi-Host discovery + routing --------------
    session.dispose()
    session = undefined
    options.setSessions([])
    discoveryRoot = join(tempDir, 'multi-root')
    const alphaIdentity: MockHostIdentity = { key: 'alpha', label: 'Alpha Desktop' }
    const betaIdentity: MockHostIdentity = { key: 'beta', label: 'Beta TUI' }
    alphaMock = new MockHost(join(discoveryRoot, 'hosts', alphaIdentity.key), alphaIdentity)
    betaMock = new MockHost(join(discoveryRoot, 'hosts', betaIdentity.key), betaIdentity)
    await alphaMock.start()
    await betaMock.start()
    await alphaMock.publishDescriptor(options.clientVersion)
    await betaMock.publishDescriptor(options.clientVersion)

    const links = await discoverHostLinks(discoveryRoot)
    const discoveredKeys = links.map((link) => link.key)
    addStep(
      'multi-host-discovery',
      links.length === 2 &&
        discoveredKeys[0] === alphaIdentity.key &&
        discoveredKeys[1] === betaIdentity.key &&
        links[0]?.label === alphaIdentity.label &&
        links[1]?.label === betaIdentity.label,
      `root=${discoveryRoot} links=${links
        .map((link) => `${link.key}:${link.label}${link.legacy ? ':legacy' : ''}`)
        .join(', ')}`,
    )
    alphaLink = links.find((link) => link.key === alphaIdentity.key)
    betaLink = links.find((link) => link.key === betaIdentity.key)
    if (alphaLink === undefined || betaLink === undefined) {
      throw new Error('multi-Host discovery did not return both mock Hosts')
    }
    if (alphaLink.legacy || betaLink.legacy) {
      throw new Error('multi-Host discovery marked a per-Host namespace as legacy')
    }

    alphaSession = buildSession(
      {
        stateDir: alphaLink.hostDir,
        socketPath: alphaLink.socketPath,
        tokenPath: alphaLink.tokenPath,
        hostKey: alphaLink.key,
        hostLabel: alphaLink.label,
      },
      options,
      log,
    )
    betaSession = buildSession(
      {
        stateDir: betaLink.hostDir,
        socketPath: betaLink.socketPath,
        tokenPath: betaLink.tokenPath,
        hostKey: betaLink.key,
        hostLabel: betaLink.label,
      },
      options,
      log,
    )
    options.setSessions([alphaSession, betaSession])
    alphaSession.start()
    betaSession.start()
    const alphaConnected = await alphaMock.waitForClient(CLIENT_WAIT_MS)
    const betaConnected = await betaMock.waitForClient(CLIENT_WAIT_MS)
    addStep(
      'multi-host-connect',
      alphaConnected && betaConnected,
      `alpha connected=${alphaConnected} (hello hostKey=${alphaSession.hostKey ?? 'none'}) beta connected=${betaConnected} (hello hostKey=${
        betaSession.hostKey ?? 'none'
      })`,
    )
    if (!alphaConnected || !betaConnected) throw new Error('the multi-Host IPC clients did not connect')

    multiPendingProvider = new PendingReviewsProvider(
      () => [alphaSession, betaSession].filter((candidate): candidate is ReviewSession => candidate !== undefined),
      options.messages,
    )

    const alphaFixture = buildFixture(tempDir, `${SELF_TEST_ID_PREFIX}alpha-${randomSuffix()}`, alphaIdentity)
    const betaFixture = buildFixture(tempDir, `${SELF_TEST_ID_PREFIX}beta-${randomSuffix()}`, betaIdentity)
    await fs.writeFile(alphaFixture.targetPath, alphaFixture.before, 'utf8')
    await fs.writeFile(betaFixture.targetPath, betaFixture.before, 'utf8')
    alphaMock.setOutcome(alphaFixture.requestId, 'committed')
    betaMock.setOutcome(betaFixture.requestId, 'rejected')
    alphaMock.sendReviewRequest(alphaFixture.params)
    betaMock.sendReviewRequest(betaFixture.params)

    const alphaPending = await waitFor(
      () => (alphaSession?.hasPending(alphaFixture.requestId) === true ? true : undefined),
      UI_WAIT_MS,
    )
    const betaPending = await waitFor(
      () => (betaSession?.hasPending(betaFixture.requestId) === true ? true : undefined),
      UI_WAIT_MS,
    )
    const aggregatePending = (alphaSession.pendingCount ?? 0) + betaSession.pendingCount
    addStep(
      'multi-host-pending',
      alphaPending === true && betaPending === true && aggregatePending === 2,
      `alphaPending=${alphaPending === true} betaPending=${betaPending === true} total=${aggregatePending}`,
    )

    const multiRows = await childrenOf(multiPendingProvider)
    const alphaRow = multiRows.find((row) => row.requestId === alphaFixture.requestId)
    const betaRow = multiRows.find((row) => row.requestId === betaFixture.requestId)
    addStep(
      'multi-host-pending-view',
      multiRows.length === 2 &&
        alphaRow?.hostKey === alphaIdentity.key &&
        betaRow?.hostKey === betaIdentity.key &&
        alphaRow.description ===
          `${options.messages.pendingPickDescription('tool-level', 'write')}${options.messages.hostSuffix(
            alphaIdentity.label,
          )}` &&
        betaRow.description ===
          `${options.messages.pendingPickDescription('tool-level', 'write')}${options.messages.hostSuffix(
            betaIdentity.label,
          )}`,
      `rows=${multiRows.length} alphaRow=${alphaRow?.hostKey ?? 'MISSING'} betaRow=${
        betaRow?.hostKey ?? 'MISSING'
      } alphaDescription=${JSON.stringify(alphaRow?.description ?? null)}`,
    )

    const alphaProposalUri = proposalUriFor(
      alphaFixture.requestId,
      alphaFixture.params.displayPath,
      alphaIdentity.key,
    )
    const alphaReview = alphaSession.pendingList().find(
      (review) => review.params.requestId === alphaFixture.requestId,
    )
    const alphaTab = await waitFor(() => findDiffTab(alphaProposalUri), UI_WAIT_MS)
    addStep(
      'multi-host-diff-title',
      alphaReview !== undefined &&
        alphaReview.diffTitle.includes(alphaIdentity.label) &&
        alphaTab !== undefined,
      `diffTitle=${JSON.stringify(alphaReview?.diffTitle ?? null)} tabFound=${alphaTab !== undefined} tabLabel=${JSON.stringify(
        alphaTab?.label ?? null,
      )}`,
    )

    // A decision must reach only the mock Host that issued the request.
    await vscode.commands.executeCommand('dpr.accept', { requestId: alphaFixture.requestId })
    const alphaDecision = await alphaMock.waitForDecision(alphaFixture.requestId, DECISION_WAIT_MS)
    await waitFor(() => (alphaSession?.pendingCount === 0 ? true : undefined), UI_WAIT_MS)
    await delay(ROUTING_SETTLE_MS)
    const betaUntouched = betaMock.hasDecision(betaFixture.requestId) === false && betaSession.hasPending(betaFixture.requestId)
    addStep(
      'multi-host-routing',
      alphaDecision.status === 'accept' &&
        alphaDecision.nonce === alphaFixture.params.nonce &&
        betaUntouched &&
        betaMock.decisionCount === 0,
      `alphaStatus=${alphaDecision.status} alphaNonceMatches=${
        alphaDecision.nonce === alphaFixture.params.nonce
      } betaDecisionReceived=${betaMock.hasDecision(betaFixture.requestId)} betaPending=${
        betaSession.hasPending(betaFixture.requestId)
      } alphaDecisionCount=${alphaMock.decisionCount} betaDecisionCount=${betaMock.decisionCount}`,
    )

    await vscode.commands.executeCommand('dpr.reject', {
      requestId: betaFixture.requestId,
      reason: 'multi-host self-test rejection',
      skipPrompt: true,
    })
    const betaDecision = await betaMock.waitForDecision(betaFixture.requestId, DECISION_WAIT_MS)
    addStep(
      'multi-host-routing-reject',
      betaDecision.status === 'reject' &&
        betaDecision.nonce === betaFixture.params.nonce &&
        alphaMock.decisionCount === 1,
      `betaStatus=${betaDecision.status} betaNonceMatches=${
        betaDecision.nonce === betaFixture.params.nonce
      } alphaDecisionCount=${alphaMock.decisionCount} betaDecisionCount=${betaMock.decisionCount}`,
    )

    report.hosts = links.map((link) => ({
      key: link.key,
      label: link.label,
      legacy: link.legacy,
      socketPath: link.socketPath,
      connected:
        link.key === alphaIdentity.key
          ? alphaMock?.clientConnected === true
          : betaMock?.clientConnected === true,
      pending:
        link.key === alphaIdentity.key
          ? (alphaSession?.pendingCount ?? 0)
          : (betaSession?.pendingCount ?? 0),
    }))

    report.ok = steps.every((step) => step.ok)
  } catch (error) {
    report.error = describeError(error)
    addStep('exception', false, report.error)
  } finally {
    options.setSessions([])
    try {
      pendingProvider?.dispose()
      historyProvider?.dispose()
      multiPendingProvider?.dispose()
    } catch (error) {
      log(`self-test tree provider cleanup failed: ${describeError(error)}`)
    }
    try {
      session?.dispose()
      alphaSession?.dispose()
      betaSession?.dispose()
    } catch (error) {
      log(`self-test session cleanup failed: ${describeError(error)}`)
    }
    try {
      await closeSelfTestTabs()
    } catch (error) {
      log(`self-test tab cleanup failed: ${describeError(error)}`)
    }
    try {
      await mock?.stop()
      await alphaMock?.stop()
      await betaMock?.stop()
    } catch (error) {
      log(`mock Host cleanup failed: ${describeError(error)}`)
    }
    if (tempDir !== undefined) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
    report.ok = report.error === undefined && steps.every((step) => step.ok)
    await writeReport(reportPath, report, log)
    const passed = steps.filter((step) => step.ok).length
    const summary = `[dpr] self-test ${report.ok ? 'PASSED' : 'FAILED'} (${passed}/${steps.length} steps) report=${
      reportPath ?? 'NOT_WRITTEN'
    }${report.error === undefined ? '' : ` error=${report.error}`}`
    console.log(summary)
    log(summary)
  }

  return report
}
