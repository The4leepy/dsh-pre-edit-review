/**
 * IPC server (Unix domain socket, JSON-RPC 2.0 over NDJSON).
 *
 * Security posture:
 * - socket file 0600 inside a 0700 state directory, plus a 32-byte token in
 *   `<stateDir>/token` (0600); the first frame must be `hello` with that token.
 * - the protocol has no write/commit method: the only mutating method is
 *   `decision`, and it must name an existing pending request.
 * - one client at a time; a disconnect cancels every pending review.
 *
 * The decision handler runs *inside* the decision frame handling, so the
 * extension's reply carries the real commit outcome (committed / conflict / …).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  METHODS,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  encodeFrame,
  isAckParams,
  isAutoAcceptParams,
  isDecisionParams,
  isHelloParams,
  splitFrames,
  type DecisionResult,
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
  stateDir: string
  socketPath: string
  serverVersion: string
  handleDecision: DecisionHandler
  onClientChanged?(connected: boolean): void
  onAutoAccept?(): void
  now?: () => number
}

interface Pending {
  requestId: string
  resolve(value: { decision: ReviewDecision; outcome: DecisionHandling }): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  signal: AbortSignal
  onAbort: () => void
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

function tokenDigest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

export class IpcServer {
  private readonly options: IpcServerOptions
  private server: Server | undefined
  private socket: Socket | undefined
  private buffer = ''
  private authed = false
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

  /** Create the state directory, publish a fresh token, and listen. */
  async start(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    this.token = randomBytes(32).toString('hex')
    const tokenPath = join(this.options.stateDir, 'token')
    await writeFile(tokenPath, this.token, { encoding: 'utf8', mode: 0o600 })
    await chmod(tokenPath, 0o600).catch(() => undefined)
    await this.listen()
  }

  private async listen(): Promise<void> {
    const connect = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const server = createServer((socket) => this.accept(socket))
        server.once('error', reject)
        server.listen(this.options.socketPath, () => {
          server.removeListener('error', reject)
          server.on('error', () => undefined)
          resolve()
        })
        this.server = server
      })

    try {
      await connect()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      // Distinguish a crashed Host's stale socket from a live listener.
      if (await probeSocket(this.options.socketPath)) {
        throw new Error(
          `another pre-edit review host is already listening on ${this.options.socketPath}; ` +
            'share one profile or configure a different stateDir/socketPath',
        )
      }
      await unlink(this.options.socketPath).catch(() => undefined)
      await connect()
    }
    await chmod(this.options.socketPath, 0o600).catch(() => undefined)
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.signal.removeEventListener('abort', pending.onAbort)
      pending.reject(new Error('IPC server stopped'))
    }
    this.pending.clear()
    this.socket?.destroy()
    this.socket = undefined
    await new Promise<void>((resolve) => {
      if (this.server === undefined) return resolve()
      this.server.close(() => resolve())
    })
    this.server = undefined
    await unlink(this.options.socketPath).catch(() => undefined)
  }

  /** Read the token the extension must present (also used by tooling/tests). */
  async readToken(): Promise<string> {
    return readFile(join(this.options.stateDir, 'token'), 'utf8')
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
      this.reply(message.id, { ok: true, serverVersion: this.options.serverVersion, stateDir: this.options.stateDir })
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
        resolve,
        reject,
        timer,
        signal: options.signal,
        onAbort,
      })
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.send({ jsonrpc: '2.0', method: METHODS.reviewRequest, params })
    })
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
