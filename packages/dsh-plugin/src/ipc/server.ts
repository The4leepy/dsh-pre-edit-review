/**
 * IPC server (Unix domain socket, JSON-RPC 2.0 over NDJSON).
 *
 * Security posture:
 * - one namespace per Host: socket and token live in the Host directory
 *   (`<stateDir>/hosts/<hostKey>/`), both `0600` inside a `0700` directory; the
 *   first frame must be `hello` with the 32-byte token from `tokenPath`.
 * - the token is published **after** the socket is bound, atomically (temp
 *   `0600` + rename). A Host that loses the bind race therefore cannot corrupt
 *   the winner's token — the 0.2.x failure mode (ADR 0002 §5).
 * - `stop()` unlinks the socket only when this instance bound it; a Host that
 *   never bound must never remove a live peer's endpoint.
 * - the protocol has no write/commit method: the only mutating method is
 *   `decision`, and it must name an existing pending request.
 * - one client at a time; a disconnect cancels every pending review.
 *
 * The decision handler runs *inside* the decision frame handling, so the
 * extension's reply carries the real commit outcome (committed / conflict / …).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import {
  METHODS,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  encodeFrame,
  isAckParams,
  isAutoAcceptParams,
  isDecisionParams,
  isHelloParams,
  randomHex,
  splitFrames,
  type DecisionResult,
  type ReviewModeParams,
  type ReviewRequestParams,
  type RpcResponse,
} from '../../../shared/src/index.ts'

export interface ReviewDecision {
  requestId: string
  status: 'accept' | 'reject'
  finalContent?: string
  reason?: string
  by: 'user' | 'auto'
}

export interface DecisionHandling {
  outcome: DecisionResult['outcome']
  detail?: { code?: string; message?: string }
}

export type DecisionHandler = (decision: ReviewDecision) => Promise<DecisionHandling>

export interface IpcServerOptions {
  /** Per-Host state directory (contains `token` unless `tokenPath` overrides). */
  stateDir: string
  socketPath: string
  /** Token file; defaults to `<stateDir>/token`. */
  tokenPath?: string
  /** Host identity advertised in `hello` / `review/request` (ADR 0002). */
  hostKey?: string
  hostLabel?: string
  serverVersion: string
  handleDecision: DecisionHandler
  onClientChanged?(connected: boolean): void
  onAutoAccept?(): void
  /** Whether review is not active for the sessions this Host knows about. */
  mode?(): boolean
  now?: () => number
}

/**
 * Another live Host owns the socket path. `code` is stable so callers can
 * branch on it without parsing the message (ADR 0002 §5).
 */
export class HostInUseError extends Error {
  readonly code = 'HOST_IN_USE'
  readonly socketPath: string
  readonly hostKey: string | undefined

  constructor(socketPath: string, hostKey?: string, detail?: string) {
    const where = hostKey === undefined ? socketPath : `${socketPath} (host "${hostKey}")`
    super(
      `another pre-edit review host is already listening on ${where}; ` +
        'only one Host per profile is supported — stop the other instance, or configure a different stateDir/socketPath' +
        (detail === undefined ? '' : ` (${detail})`),
    )
    this.name = 'HostInUseError'
    this.socketPath = socketPath
    this.hostKey = hostKey
  }
}

/** Hard cap on one NDJSON frame; protects the Host from a hostile/buggy client. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** How many stale-socket reclaim attempts are allowed before giving up. */
const MAX_RECLAIMS = 2

interface Pending {
  requestId: string
  nonce: string
  resolve(value: { decision: ReviewDecision; outcome: DecisionHandling }): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  signal: AbortSignal
  onAbort: () => void
}

/** Resolve true when something accepts a connection on `path` right now. */
export function probeSocketPath(path: string, timeoutMs = 300): Promise<boolean> {
  return probeSocket(path, timeoutMs)
}

/** Resolve true when something accepts a connection on `path` right now. */
function probeSocket(path: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(path)
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
}

/**
 * Process-wide socket ownership serialization.
 *
 * libuv unlinks a Unix socket path when its listening handle is closed. During
 * an in-process reload (hot installer / HMR) the *old* runtime's `close()` can
 * therefore delete the socket that a *new* runtime already bound at the same
 * path, leaving the new Host listening on an unlinked inode. Since both
 * runtimes live in the same process, a process-global owner slot serializes
 * them: a new instance waits until the previous owner finished closing before
 * it binds. Cross-process starts are still handled by the bind probe /
 * `HostInUseError` path, and the inode guard below is the second line of
 * defence for any remaining ordering surprise.
 */
interface SocketOwnerSlot {
  released: Promise<void>
  release(): void
  /** True once the owning instance started closing its listener. */
  closing: boolean
}

const PROCESS_OWNERS = Symbol.for('dsh-pre-edit-review.ipc-socket-owners')

function ownerSlots(): Map<string, SocketOwnerSlot> {
  const global = globalThis as unknown as Record<symbol, Map<string, SocketOwnerSlot> | undefined>
  let slots = global[PROCESS_OWNERS]
  if (slots === undefined) {
    slots = new Map<string, SocketOwnerSlot>()
    global[PROCESS_OWNERS] = slots
  }
  return slots
}

/** How long a new instance waits for a previous in-process owner to close. */
const OWNER_WAIT_MS = 10_000

function claimSocketOwner(socketPath: string): SocketOwnerSlot {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const slot: SocketOwnerSlot = { released, release, closing: false }
  ownerSlots().set(socketPath, slot)
  return slot
}

async function waitForPreviousOwner(socketPath: string): Promise<void> {
  const previous = ownerSlots().get(socketPath)
  // A live sibling is handled by the bind probe (`HostInUseError`), not by
  // waiting. Only an owner that is actively tearing down needs to be awaited,
  // because libuv unlinks the path during that close.
  if (previous === undefined || !previous.closing) return
  await Promise.race([
    previous.released,
    new Promise<void>((resolve) => setTimeout(resolve, OWNER_WAIT_MS).unref?.()),
  ])
}

function tokenDigest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

export class IpcServer {
  private readonly options: IpcServerOptions
  private server: Server | undefined
  private socket: Socket | undefined
  private buffer = ''
  private authed = false
  /** True only when this instance successfully bound the socket path. */
  private boundToPath = false
  /**
   * Device/inode of the socket file this instance bound. `stop()` only unlinks
   * the path when it still resolves to that inode: a newer instance may have
   * reclaimed the path between our `server.close()` and the unlink (HMR or a
   * fast restart), and deleting its socket would make it undiscoverable.
   */
  private boundIdentity: { dev: number; ino: number } | undefined
  /** Process-wide owner slot held from start until the close finished. */
  private owner: SocketOwnerSlot | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly now: () => number
  private token = ''

  constructor(options: IpcServerOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  get connected(): boolean {
    return this.socket !== undefined && this.authed
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get socketPath(): string {
    return this.options.socketPath
  }

  get tokenPath(): string {
    return this.options.tokenPath ?? join(this.options.stateDir, 'token')
  }

  /** True only while this instance owns the socket path it bound. */
  get bound(): boolean {
    return this.boundToPath
  }

  /**
   * Create the state directory, bind the socket, then publish a fresh token.
   * Order matters: a losing Host must never overwrite the winner's token.
   */
  async start(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 })
    // An in-process reload must wait for the previous owner's close: libuv
    // unlinks the path when that close runs, even if we already bound it.
    await waitForPreviousOwner(this.options.socketPath)
    this.token = randomBytes(32).toString('hex')
    try {
      await this.listen()
      // Claim only after binding: a failed bind (live sibling) must not steal
      // the owner slot from the instance that is actually serving.
      this.owner = claimSocketOwner(this.options.socketPath)
      await this.publishToken()
    } catch (error) {
      if (this.boundToPath) await this.stop().catch(() => undefined)
      this.releaseOwner()
      throw error
    }
  }

  /** Release the process-wide owner slot exactly once. */
  private releaseOwner(): void {
    const slot = this.owner
    if (slot === undefined) return
    this.owner = undefined
    if (ownerSlots().get(this.options.socketPath) === slot) ownerSlots().delete(this.options.socketPath)
    slot.release()
  }

  /**
   * Bind the socket. On `EADDRINUSE` probe first: a live listener is never
   * displaced (typed `HostInUseError`); a stale socket is reclaimed after a
   * probe, and the probe is repeated before any second unlink attempt.
   */
  private async listen(): Promise<void> {
    let reclaims = 0
    for (;;) {
      try {
        await this.bind()
        this.boundToPath = true
        this.boundIdentity = await this.socketIdentity()
        await chmod(this.options.socketPath, 0o600).catch(() => undefined)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        if (await probeSocket(this.options.socketPath)) {
          throw new HostInUseError(this.options.socketPath, this.options.hostKey)
        }
        if (reclaims >= MAX_RECLAIMS) {
          throw new HostInUseError(this.options.socketPath, this.options.hostKey, 'socket path could not be reclaimed')
        }
        await unlink(this.options.socketPath).catch(() => undefined)
        reclaims += 1
      }
    }
  }

  private bind(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket))
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        server.close(() => undefined)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        server.on('error', () => undefined)
        this.server = server
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.socketPath)
    })
  }

  /** Current socket file identity, `undefined` when the path cannot be stat'ed. */
  private async socketIdentity(): Promise<{ dev: number; ino: number } | undefined> {
    try {
      const info = await stat(this.options.socketPath)
      return info.dev === undefined || info.ino === undefined ? undefined : { dev: info.dev, ino: info.ino }
    } catch {
      return undefined
    }
  }

  /** True when the path still points at the socket this instance bound. */
  private async stillOwnsSocket(): Promise<boolean> {
    const expected = this.boundIdentity
    if (expected === undefined) {
      // Cannot prove ownership (old runtime / stat failed): reclaiming the path
      // is safer than deleting a possible peer's socket.
      return false
    }
    const current = await this.socketIdentity()
    return current !== undefined && current.dev === expected.dev && current.ino === expected.ino
  }

  /** Write the token atomically so a client never reads a partial file. */
  private async publishToken(): Promise<void> {
    const tokenPath = this.tokenPath
    const temp = `${tokenPath}.${randomHex(6)}.tmp`
    try {
      const handle = await open(temp, 'w', 0o600)
      try {
        await handle.writeFile(this.token, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, tokenPath)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
    await chmod(tokenPath, 0o600).catch(() => undefined)
  }

  async stop(): Promise<void> {
    if (this.owner !== undefined) this.owner.closing = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.signal.removeEventListener('abort', pending.onAbort)
      pending.reject(new Error('IPC server stopped'))
    }
    this.pending.clear()
    this.socket?.destroy()
    this.socket = undefined
    this.authed = false
    this.buffer = ''
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve) => {
      if (server === undefined) return resolve()
      server.close(() => resolve())
    })
    // Only the instance that bound the path — and whose socket file is still
    // the one on disk — may remove it. An instance that failed to bind, or one
    // whose path was reclaimed by a newer instance during teardown, must not
    // unlink a live peer's endpoint (ADR 0002 §5).
    if (this.boundToPath) {
      this.boundToPath = false
      if (await this.stillOwnsSocket()) await unlink(this.options.socketPath).catch(() => undefined)
      this.boundIdentity = undefined
    }
    this.releaseOwner()
  }

  /** Read the token the extension must present (also used by tooling/tests). */
  async readToken(): Promise<string> {
    return readFile(this.tokenPath, 'utf8')
  }

  /** Wait until a client completes the handshake, or the deadline passes. */
  async waitForClient(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (this.connected) return true
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      if (this.connected) return true
      if (signal.aborted) return false
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    return this.connected
  }

  /** Host identity fields, included only when configured (additive protocol). */
  private identity(): { hostKey?: string; hostLabel?: string } {
    return {
      ...(this.options.hostKey !== undefined ? { hostKey: this.options.hostKey } : {}),
      ...(this.options.hostLabel !== undefined ? { hostLabel: this.options.hostLabel } : {}),
    }
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
    const wasConnected = this.connected
    this.socket = undefined
    this.authed = false
    const outstanding = [...this.pending.values()]
    this.pending.clear()
    for (const pending of outstanding) {
      clearTimeout(pending.timer)
      pending.signal.removeEventListener('abort', pending.onAbort)
      pending.reject(new Error('review client disconnected'))
    }
    if (wasConnected) this.options.onClientChanged?.(false)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    const { lines, rest } = splitFrames(this.buffer)
    this.buffer = rest
    for (const line of lines) this.onFrame(line)
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.fail(null, RPC_ERRORS.INVALID_REQUEST, 'frame exceeds the maximum size')
      this.socket?.destroy()
    }
  }

  private send(message: unknown): void {
    this.socket?.write(encodeFrame(message))
  }

  private reply(id: string | number | null, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  private fail(id: string | number | null, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } } satisfies RpcResponse)
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
      const presented = tokenDigest(message.params.token)
      const expected = tokenDigest(this.token)
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, 'invalid token')
        this.socket?.destroy()
        return
      }
      this.authed = true
      this.options.onClientChanged?.(true)
      this.reply(message.id, {
        ok: true,
        serverVersion: this.options.serverVersion,
        stateDir: this.options.stateDir,
        paused: this.options.mode?.() === true,
        ...this.identity(),
      })
      return
    }

    if (!this.authed) {
      this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, 'hello required before any other method')
      return
    }

    switch (message?.method) {
      case METHODS.decision:
        void this.onDecisionFrame(message)
        return
      case METHODS.ack:
        this.reply(message.id, { ok: isAckParams(message.params) })
        return
      case METHODS.ping:
        this.reply(message.id, { pong: true, now: this.now() })
        return
      case METHODS.autoAccept:
        if (isAutoAcceptParams(message.params)) this.options.onAutoAccept?.()
        this.reply(message.id, { ok: true })
        return
      default:
        this.fail(message?.id ?? null, RPC_ERRORS.METHOD_NOT_FOUND, `unknown method: ${String(message?.method)}`)
    }
  }

  private async onDecisionFrame(message: any): Promise<void> {
    if (!isDecisionParams(message?.params)) {
      this.fail(message?.id ?? null, RPC_ERRORS.INVALID_PARAMS, 'invalid decision params')
      return
    }
    const params = message.params
    const pending = this.pending.get(params.requestId)
    if (pending === undefined) {
      this.reply(message.id, { ok: true, outcome: 'already-decided' })
      return
    }
    // The nonce binds this decision to the exact request we sent; a mismatch is
    // a forged or stale reply and must not settle the review.
    if (params.nonce !== pending.nonce) {
      this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, 'decision nonce does not match the pending review')
      return
    }
    this.pending.delete(params.requestId)
    clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.onAbort)

    const decision: ReviewDecision = {
      requestId: params.requestId,
      status: params.status,
      ...(params.finalContent !== undefined ? { finalContent: params.finalContent } : {}),
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      by: 'user',
    }

    let handling: DecisionHandling
    try {
      handling = await this.options.handleDecision(decision)
    } catch (error) {
      handling = { outcome: 'failed', detail: { message: error instanceof Error ? error.message : String(error) } }
    }
    this.reply(message.id, { ok: true, ...handling })
    pending.resolve({ decision, outcome: handling })
  }

  /**
   * Ask the client to review one request.
   * Resolves only after the decision was handled (so `outcome` is final);
   * rejects on timeout, abort, disconnect, or server shutdown.
   */
  request(params: ReviewRequestParams, options: { timeoutMs: number; signal: AbortSignal }): Promise<{
    decision: ReviewDecision
    outcome: DecisionHandling
  }> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('no review client connected'))
        return
      }
      if (options.signal.aborted) {
        reject(new Error('review cancelled'))
        return
      }

      const onAbort = (): void => {
        this.cancel(params.requestId, 'cancelled')
        reject(new Error('review cancelled'))
      }
      const timer = setTimeout(() => {
        this.cancel(params.requestId, 'timeout')
        reject(new Error(`review timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)

      this.pending.set(params.requestId, {
        requestId: params.requestId,
        nonce: params.nonce,
        resolve,
        reject,
        timer,
        signal: options.signal,
        onAbort,
      })
      options.signal.addEventListener('abort', onAbort, { once: true })
      // Host identity is additive metadata for multi-Host clients (ADR 0002 §4).
      this.send({ jsonrpc: '2.0', method: METHODS.reviewRequest, params: { ...params, ...this.identity() } })
    })
  }

  /** Push the current review-activation state to the client. */
  notifyMode(params: ReviewModeParams): void {
    if (!this.connected) return
    this.send({ jsonrpc: '2.0', method: METHODS.reviewMode, params })
  }

  /** Withdraw an outstanding request (timeout, cancellation, disconnect). */
  cancel(requestId: string, reason: string): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.onAbort)
    this.send({ jsonrpc: '2.0', method: METHODS.reviewCancel, params: { requestId, reason } })
  }
}
