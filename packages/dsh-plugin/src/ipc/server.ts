/**
 * IPC server (Unix domain socket, JSON-RPC 2.0 over NDJSON).
 *
 * Security posture:
 * - socket file 0600 inside a 0700 directory, plus a 32-byte token written to
 *   `token` (0600); the first frame must be `hello` with that token.
 * - the protocol has no write/commit method: the only mutating method is
 *   `decision`, and it must name an existing pending request + nonce.
 * - one client at a time; a disconnect cancels every pending review.
 *
 * Phase 2 owns the production hardening (frame size caps, heartbeat timeouts,
 * back-pressure). This file stabilises the seams the coordinator codes against.
 */
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  METHODS,
  RPC_ERRORS,
  PROTOCOL_VERSION,
  encodeFrame,
  isAckParams,
  isAutoAcceptParams,
  isDecisionParams,
  isHelloParams,
  splitFrames,
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

export interface IpcServerOptions {
  stateDir: string
  socketPath: string
  serverVersion: string
  now?: () => number
  /** Called for every accepted/rejected decision; must never throw. */
  onDecision(decision: ReviewDecision): void
  /** Called once per request the client cancels or when the client disconnects. */
  onCancel(requestId: string, reason: string): void
  onClientChanged?(connected: boolean): void
}

interface Pending {
  requestId: string
  params: ReviewRequestParams
  resolve(decision: ReviewDecision): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

function sha256(text: string): Buffer {
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

  get tokenValue(): string {
    return this.token
  }

  /** Prepare the state directory, publish a fresh token and start listening. */
  async start(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    this.token = randomBytes(32).toString('hex')
    const tokenPath = join(this.options.stateDir, 'token')
    await writeFile(tokenPath, this.token, { encoding: 'utf8', mode: 0o600 })
    await chmod(tokenPath, 0o600).catch(() => undefined)

    this.server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.options.socketPath, () => resolve())
    })
    await chmod(this.options.socketPath, 0o600).catch(() => undefined)
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
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
  }

  /** Read the token the extension must present. Used by tooling/tests. */
  async readToken(): Promise<string> {
    return readFile(join(this.options.stateDir, 'token'), 'utf8')
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
    for (const [requestId, pending] of this.pending) {
      this.cancel(requestId, 'review client disconnected')
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
        this.fail(message.id ?? null, RPC_ERRORS.AUTH_FAILED, 'unsupported protocol or malformed hello')
        this.socket?.destroy()
        return
      }
      const presented = Buffer.from(message.params.token, 'utf8')
      const expected = Buffer.from(this.token, 'utf8')
      if (presented.length !== expected.length || !timingSafeEqual(sha256(presented.toString()), sha256(expected.toString()))) {
        this.fail(message.id ?? null, RPC_ERRORS.AUTH_FAILED, 'invalid token')
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
      case METHODS.decision: {
        if (!isDecisionParams(message.params)) {
          this.fail(message.id, RPC_ERRORS.INVALID_PARAMS, 'invalid decision params')
          return
        }
        const decision: ReviewDecision = {
          requestId: message.params.requestId,
          status: message.params.status,
          ...(message.params.finalContent !== undefined ? { finalContent: message.params.finalContent } : {}),
          ...(message.params.reason !== undefined ? { reason: message.params.reason } : {}),
          by: 'user',
        }
        this.settle(decision)
        this.reply(message.id, { ok: true, outcome: 'pending-commit' })
        return
      }
      case METHODS.ack: {
        this.reply(message.id, { ok: isAckParams(message.params) })
        return
      }
      case METHODS.ping: {
        this.reply(message.id, { pong: true, now: this.now() })
        return
      }
      case METHODS.autoAccept: {
        this.reply(message.id, { ok: isAutoAcceptParams(message.params) })
        return
      }
      default:
        this.fail(message?.id ?? null, RPC_ERRORS.METHOD_NOT_FOUND, `unknown method: ${String(message?.method)}`)
    }
  }

  private settle(decision: ReviewDecision): void {
    const pending = this.pending.get(decision.requestId)
    if (pending === undefined) {
      // Late or duplicate decision: ignored by design (idempotency).
      return
    }
    this.pending.delete(decision.requestId)
    clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
    pending.resolve(decision)
    this.options.onDecision(decision)
  }

  /**
   * Ask the client to review one request. Rejects on timeout, abort, or a
   * disconnect, so the coordinator can fail closed.
   */
  request(params: ReviewRequestParams, options: { timeoutMs: number; signal: AbortSignal }): Promise<ReviewDecision> {
    return new Promise<ReviewDecision>((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('no review client connected'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(params.requestId)
        this.send({ jsonrpc: '2.0', method: METHODS.reviewCancel, params: { requestId: params.requestId, reason: 'timeout' } })
        reject(new Error(`review timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)

      const onAbort = (): void => {
        this.cancel(params.requestId, 'cancelled')
        reject(new Error('review cancelled'))
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(params.requestId, {
        requestId: params.requestId,
        params,
        resolve,
        reject,
        timer,
        signal: options.signal,
        onAbort,
      })
      if (options.signal.aborted) {
        onAbort()
        return
      }
      this.send({ jsonrpc: '2.0', method: METHODS.reviewRequest, params })
    })
  }

  /** Withdraw an outstanding request (timeout, cancellation, disconnect). */
  cancel(requestId: string, reason: string): void {
    if (!this.pending.has(requestId)) return
    this.pending.delete(requestId)
    this.send({ jsonrpc: '2.0', method: METHODS.reviewCancel, params: { requestId, reason } })
    this.options.onCancel(requestId, reason)
  }
}
