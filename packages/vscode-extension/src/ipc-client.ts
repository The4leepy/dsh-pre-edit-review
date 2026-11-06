/**
 * UDS client for the Host plugin's JSON-RPC 2.0 / NDJSON server.
 *
 * Connection lifecycle:
 *   connecting → hello (token read from `tokenPath`, which defaults to
 *   `<stateDir>/token`, retried while the Host has not written it yet) →
 *   connected → on drop, an automatic 3 s backoff reconnect. Every attempt
 *   re-reads the token, so a Host restart with a fresh token is picked up
 *   transparently.
 *
 * Multi-Host (ADR 0002): one client = one Host. `hostKey`/`hostLabel` come from
 * discovery and are refreshed from the `hello` result when the Host sends them.
 *
 * The client only sends `hello` / `decision`; it answers a server initiated
 * `ping` if one ever arrives (the Host currently does not send it).
 */

import { readFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'

import { isHostKey } from '../../shared/src/host.ts'
import {
  METHODS,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  encodeFrame,
  isServerNotification,
  splitFrames,
} from '../../shared/src/protocol.ts'
import type {
  DecisionParams,
  DecisionResult,
  HelloParams,
  HelloResult,
  RpcError,
  ServerNotification,
} from '../../shared/src/protocol.ts'
import { delay, describeError, isRecord } from './util.ts'

export class IpcRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'IpcRpcError'
    this.code = code
    this.data = data
  }
}

export type IpcClientState = 'idle' | 'connecting' | 'connected' | 'offline'

export interface IpcConnectionInfo {
  connected: boolean
  /** Set when the Host rejected our token / protocol version. */
  authFailed?: boolean
  error?: string
  /** True when this client had a live connection at least once before. */
  wasConnected?: boolean
  /** True when the Host reports review paused (`/review off`) for some live session. */
  paused?: boolean
}

export interface IpcClientOptions {
  /** Directory that holds the Host's `ipc.sock` and `token` (a per-Host namespace in 0.3.0). */
  stateDir: string
  socketPath?: string
  /** Token file path; defaults to `<stateDir>/token`. */
  tokenPath?: string
  /** Host identity from discovery (ADR 0002); a hello result may refresh it. */
  hostKey?: string
  /** Human-readable Host label from discovery; a hello result may refresh it. */
  hostLabel?: string
  clientName?: string
  clientVersion: string
  reconnectDelayMs?: number
  connectTimeoutMs?: number
  /** How long to wait for the Host to publish the token file. */
  tokenWaitMs?: number
  requestTimeoutMs?: number
  onNotification(notification: ServerNotification): void
  onConnectionChanged(info: IpcConnectionInfo): void
  log?(message: string): void
}

interface PendingRpc {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

const DEFAULT_RECONNECT_MS = 3000
const DEFAULT_CONNECT_TIMEOUT_MS = 5000
const DEFAULT_TOKEN_WAIT_MS = 2500
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class IpcClient {
  private readonly options: IpcClientOptions
  private readonly socketPath: string
  private readonly tokenFile: string
  private readonly reconnectDelayMs: number
  private readonly connectTimeoutMs: number
  private readonly tokenWaitMs: number
  private readonly requestTimeoutMs: number

  private socket: Socket | undefined
  private state: IpcClientState = 'idle'
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRpc>()
  private reconnectTimer: NodeJS.Timeout | undefined
  private attempt = 0
  private disposed = false
  private everConnected = false
  /** Identity announced by the Host in its hello result (wins over discovery). */
  private adoptedHostKey: string | undefined
  private adoptedHostLabel: string | undefined

  constructor(options: IpcClientOptions) {
    this.options = options
    this.socketPath = options.socketPath ?? join(options.stateDir, 'ipc.sock')
    this.tokenFile = options.tokenPath ?? join(options.stateDir, 'token')
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.tokenWaitMs = options.tokenWaitMs ?? DEFAULT_TOKEN_WAIT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  get connected(): boolean {
    return this.state === 'connected'
  }

  get currentState(): IpcClientState {
    return this.state
  }

  get endpoint(): string {
    return this.socketPath
  }

  get stateDir(): string {
    return this.options.stateDir
  }

  get tokenPath(): string {
    return this.tokenFile
  }

  /** Host identity: hello result first, discovery second. */
  get hostKey(): string | undefined {
    return this.adoptedHostKey ?? this.options.hostKey
  }

  get hostLabel(): string | undefined {
    return this.adoptedHostLabel ?? this.options.hostLabel
  }

  /** Start (or resume) connecting. Safe to call repeatedly. */
  start(): void {
    if (this.disposed) return
    if (this.state === 'connecting' || this.state === 'connected') return
    this.connect()
  }

  stop(): void {
    this.disposed = true
    this.attempt += 1
    this.clearReconnectTimer()
    this.teardownSocket()
    this.rejectAllPending(new Error('IPC client stopped'))
    this.state = 'idle'
  }

  /** Drop the current socket and retry immediately. */
  reconnect(): void {
    if (this.disposed) return
    this.attempt += 1
    this.clearReconnectTimer()
    this.teardownSocket()
    this.rejectAllPending(new Error('IPC client reconnecting'))
    this.state = 'offline'
    this.connect()
  }

  async decide(params: DecisionParams): Promise<DecisionResult> {
    const result = await this.request(METHODS.decision, params, this.requestTimeoutMs)
    if (!isRecord(result) || result['ok'] !== true || typeof result['outcome'] !== 'string') {
      throw new Error('malformed decision reply from the Host')
    }
    return result as unknown as DecisionResult
  }

  // -- connection ----------------------------------------------------------

  private connect(): void {
    if (this.disposed) return
    const attempt = (this.attempt += 1)
    this.state = 'connecting'
    void this.runConnect(attempt)
  }

  private async runConnect(attempt: number): Promise<void> {
    try {
      const token = await this.readToken(attempt)
      if (token === undefined) return
      const socket = await this.openSocket(attempt)
      if (socket === undefined) return
      this.socket = socket
      this.buffer = ''
      this.attachSocket(socket, attempt)

      const hello: HelloParams = {
        token,
        protocolVersion: PROTOCOL_VERSION,
        client: { name: this.options.clientName ?? 'vscode', version: this.options.clientVersion },
      }
      const result = await this.request<HelloResult>(METHODS.hello, hello, this.connectTimeoutMs)
      if (!this.isCurrent(attempt) || this.socket !== socket) return
      if (!isRecord(result) || result['ok'] !== true) {
        throw new Error('Host rejected the hello handshake')
      }
      this.adoptIdentity(result)
      this.everConnected = true
      this.state = 'connected'
      this.log(`connected to ${this.socketPath} (hostKey=${this.hostKey ?? 'legacy'})`)
      this.options.onConnectionChanged({ connected: true, paused: result['paused'] === true || result['bypass'] === true })
    } catch (error) {
      if (!this.isCurrent(attempt)) return
      const authFailed = error instanceof IpcRpcError && error.code === RPC_ERRORS.AUTH_FAILED
      this.teardownSocket()
      this.rejectAllPending(error instanceof Error ? error : new Error(describeError(error)))
      this.state = 'offline'
      this.log(`connect attempt failed: ${describeError(error)}`)
      this.options.onConnectionChanged({
        connected: false,
        authFailed,
        error: describeError(error),
        wasConnected: this.everConnected,
        paused: false,
      })
      this.scheduleReconnect()
    }
  }

  private async readToken(attempt: number): Promise<string | undefined> {
    const deadline = Date.now() + this.tokenWaitMs
    for (;;) {
      try {
        const raw = await readFile(this.tokenFile, 'utf8')
        const token = raw.trim()
        if (token.length >= 32) return token
      } catch {
        // The Host might not have written the token yet (or it is restarting).
      }
      if (!this.isCurrent(attempt)) return undefined
      if (Date.now() >= deadline) {
        throw new Error(`token not available at ${this.tokenFile} (waited ${this.tokenWaitMs} ms)`)
      }
      await delay(250)
    }
  }

  /** Remember who answered the hello handshake (the Host is authoritative). */
  private adoptIdentity(result: Record<string, unknown>): void {
    const hostKey = result['hostKey']
    if (typeof hostKey === 'string' && isHostKey(hostKey)) this.adoptedHostKey = hostKey
    const hostLabel = result['hostLabel']
    if (typeof hostLabel === 'string' && hostLabel.length > 0) this.adoptedHostLabel = hostLabel
  }

  private async openSocket(attempt: number): Promise<Socket | undefined> {
    const socket = createConnection(this.socketPath)
    socket.setEncoding('utf8')
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`connect timed out after ${this.connectTimeoutMs} ms`))
        }, this.connectTimeoutMs)
        const onConnect = (): void => {
          cleanup()
          resolve()
        }
        const onError = (error: Error): void => {
          cleanup()
          reject(error)
        }
        const onClose = (): void => {
          cleanup()
          reject(new Error('socket closed before the connection was established'))
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          socket.removeListener('connect', onConnect)
          socket.removeListener('error', onError)
          socket.removeListener('close', onClose)
        }
        socket.once('connect', onConnect)
        socket.once('error', onError)
        socket.once('close', onClose)
      })
    } catch (error) {
      socket.removeAllListeners()
      socket.destroy()
      throw error
    }
    if (!this.isCurrent(attempt)) {
      socket.removeAllListeners()
      socket.destroy()
      return undefined
    }
    return socket
  }

  private attachSocket(socket: Socket, attempt: number): void {
    socket.on('data', (chunk: string) => {
      if (this.socket !== socket) return
      this.onData(chunk)
    })
    socket.on('error', (error: Error) => {
      this.handleSocketLoss(socket, attempt, error)
    })
    socket.on('close', () => {
      this.handleSocketLoss(socket, attempt, undefined)
    })
  }

  private handleSocketLoss(socket: Socket, attempt: number, error: Error | undefined): void {
    if (this.socket !== socket) return
    const lostAfterConnect = this.state === 'connected'
    this.socket = undefined
    this.buffer = ''
    this.rejectAllPending(new Error(`IPC connection lost${error === undefined ? '' : `: ${error.message}`}`))
    if (!this.isCurrent(attempt) || this.disposed) return
    this.state = 'offline'
    this.log(`connection lost${error === undefined ? '' : `: ${error.message}`}`)
    this.options.onConnectionChanged({
      connected: false,
      error: error === undefined ? 'connection closed' : describeError(error),
      wasConnected: this.everConnected && lostAfterConnect,
    })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.disposed) return
      this.connect()
    }, this.reconnectDelayMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private teardownSocket(): void {
    const socket = this.socket
    this.socket = undefined
    this.buffer = ''
    if (socket === undefined) return
    socket.removeAllListeners()
    socket.destroy()
  }

  private isCurrent(attempt: number): boolean {
    return !this.disposed && this.attempt === attempt
  }

  // -- RPC ----------------------------------------------------------------

  private request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket
      if (socket === undefined || socket.destroyed) {
        reject(new Error(`${method} failed: not connected`))
        return
      }
      const id = this.nextId
      this.nextId += 1
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      })
      socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  // -- framing ------------------------------------------------------------

  private onData(chunk: string): void {
    this.buffer += chunk
    const { lines, rest } = splitFrames(this.buffer)
    this.buffer = rest
    for (const line of lines) this.onLine(line)
  }

  private onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.log(`ignoring malformed frame: ${line.slice(0, 200)}`)
      return
    }
    if (!isRecord(message)) return
    const method = message['method']
    const id = message['id']
    const hasId = typeof id === 'number' || typeof id === 'string'

    if (hasId && ('result' in message || 'error' in message)) {
      this.resolveResponse(message, id)
      return
    }
    if (typeof method !== 'string') return
    if (hasId) {
      this.handleServerRequest(method, id, message['params'])
      return
    }
    if (!isServerNotification(message)) {
      this.log(`ignoring unknown server notification: ${method}`)
      return
    }
    this.options.onNotification(message)
  }

  private resolveResponse(message: Record<string, unknown>, id: number | string): void {
    if (typeof id !== 'number') {
      this.log(`ignoring response for unexpected id type: ${String(id)}`)
      return
    }
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    const rawError = message['error']
    if (isRecord(rawError)) {
      const code = typeof rawError['code'] === 'number' ? rawError['code'] : RPC_ERRORS.INTERNAL_ERROR
      const text = typeof rawError['message'] === 'string' ? rawError['message'] : 'unspecified IPC error'
      pending.reject(new IpcRpcError(code, text, (rawError as unknown as RpcError).data))
      return
    }
    pending.resolve(message['result'])
  }

  /** The Host currently sends only notifications; answer a request anyway. */
  private handleServerRequest(method: string, id: number | string, params: unknown): void {
    const socket = this.socket
    if (socket === undefined) return
    if (method === METHODS.ping) {
      socket.write(encodeFrame({ jsonrpc: '2.0', id, result: { pong: true, now: Date.now() } }))
      return
    }
    const notification = { jsonrpc: '2.0', method, params }
    if (isServerNotification(notification)) {
      this.options.onNotification(notification)
      socket.write(encodeFrame({ jsonrpc: '2.0', id, result: { ok: true } }))
      return
    }
    socket.write(
      encodeFrame({
        jsonrpc: '2.0',
        id,
        error: { code: RPC_ERRORS.METHOD_NOT_FOUND, message: `unknown method: ${method}` },
      }),
    )
  }

  private log(message: string): void {
    this.options.log?.(message)
  }
}
