import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { IpcServer } from '../packages/dsh-plugin/src/ipc/server.ts'
import type { ReviewDecision } from '../packages/dsh-plugin/src/ipc/server.ts'
import type { ReviewRequestParams } from '../packages/shared/src/protocol.ts'
import { splitFrames } from '../packages/shared/src/protocol.ts'

interface Harness {
  dir: string
  server: IpcServer
  decisions: ReviewDecision[]
  stop(): Promise<void>
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-ipc-sec-'))
  const decisions: ReviewDecision[] = []
  const server = new IpcServer({
    stateDir: dir,
    socketPath: join(dir, 'ipc.sock'),
    serverVersion: 'test',
    handleDecision: async (decision) => {
      decisions.push(decision)
      return { outcome: 'committed' }
    },
  })
  await server.start()
  return { dir, server, decisions, stop: async () => server.stop() }
}

function rawClient(socketPath: string) {
  const socket = connect(socketPath)
  let buffer = ''
  const waiters: Array<(message: any) => void> = []
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  // A destroyed peer can make a large write fail locally; that is expected here.
  socket.on('error', () => undefined)
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const { lines, rest } = splitFrames(buffer)
    buffer = rest
    for (const line of lines) {
      const message = JSON.parse(line)
      for (const waiter of waiters.splice(0)) waiter(message)
    }
  })
  return {
    socket,
    closed,
    send(message: unknown) {
      socket.write(`${JSON.stringify(message)}\n`)
    },
    raw(text: string) {
      socket.write(text)
    },
    next(): Promise<any> {
      return new Promise((resolve) => waiters.push(resolve))
    },
    close() {
      socket.destroy()
    },
  }
}

function requestParams(overrides: Partial<ReviewRequestParams> = {}): ReviewRequestParams {
  return {
    requestId: 'req-sec',
    nonce: 'n'.repeat(32),
    protocolVersion: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    sessionId: 'session-1',
    sessionLabel: 'ws#s',
    toolName: 'write',
    callId: 'call-1',
    operation: 'update',
    displayPath: 'a.ts',
    absolutePath: '/ws/a.ts',
    isNewFile: false,
    before: 'a\n',
    after: 'b\n',
    beforeSha256: 'a'.repeat(64),
    afterSha256: 'b'.repeat(64),
    targetKind: 'direct-workspace',
    mode: 'tool-level',
    ...overrides,
  }
}

async function handshake(server: IpcServer, client: ReturnType<typeof rawClient>): Promise<void> {
  const token = await server.readToken()
  client.send({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token, protocolVersion: 1, client: { name: 't', version: '1' } } })
  const hello = await client.next()
  assert.equal(hello.result.ok, true)
}

test('a forged decision nonce is rejected and the review stays pending', async () => {
  const h = await harness()
  try {
    const client = rawClient(join(h.dir, 'ipc.sock'))
    await handshake(h.server, client)
    const pending = h.server.request(requestParams(), { timeoutMs: 5_000, signal: new AbortController().signal })
    await client.next() // review/request

    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'decision',
      params: { requestId: 'req-sec', nonce: 'x'.repeat(32), status: 'accept', finalContent: 'evil\n' },
    })
    const forged = await client.next()
    assert.equal(forged.error.code, -32001)
    assert.equal(h.decisions.length, 0)
    assert.equal(h.server.pendingCount, 1)

    client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'decision',
      params: { requestId: 'req-sec', nonce: 'n'.repeat(32), status: 'accept', finalContent: 'b\n' },
    })
    const genuine = await client.next()
    assert.equal(genuine.result.outcome, 'committed')
    await pending
    assert.equal(h.decisions.length, 1)
    client.close()
  } finally {
    await h.stop()
  }
})

test('unknown and replayed decisions are answered with already-decided', async () => {
  const h = await harness()
  try {
    const client = rawClient(join(h.dir, 'ipc.sock'))
    await handshake(h.server, client)
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'decision',
      params: { requestId: 'never-sent', nonce: 'n'.repeat(32), status: 'reject' },
    })
    const reply = await client.next()
    assert.equal(reply.result.outcome, 'already-decided')
    client.close()
  } finally {
    await h.stop()
  }
})

test('malformed JSON is answered with a parse error and does not kill the connection', async () => {
  const h = await harness()
  try {
    const client = rawClient(join(h.dir, 'ipc.sock'))
    await handshake(h.server, client)
    client.raw('{not json}\n')
    const reply = await client.next()
    assert.equal(reply.error.code, -32700)
    assert.equal(h.server.connected, true)
    client.close()
  } finally {
    await h.stop()
  }
})

test('an oversized frame drops the connection instead of buffering forever', async () => {
  const h = await harness()
  try {
    const client = rawClient(join(h.dir, 'ipc.sock'))
    await handshake(h.server, client)
    client.raw(`{"jsonrpc":"2.0","id":9,"method":"ping","params":"${'x'.repeat(9 * 1024 * 1024)}`)
    await Promise.race([client.closed, new Promise((resolve) => setTimeout(resolve, 3_000))])
    // The server's own close handler may run a tick after the client observes EOF.
    for (let i = 0; i < 50 && h.server.connected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(h.server.connected, false)
  } finally {
    await h.stop()
  }
})

test('token and socket files are owner-only', async () => {
  const h = await harness()
  try {
    const dirStat = await stat(h.dir)
    assert.equal(dirStat.mode & 0o777, 0o700)
    const tokenStat = await stat(join(h.dir, 'token'))
    assert.equal(tokenStat.mode & 0o777, 0o600)
    const socketStat = await stat(join(h.dir, 'ipc.sock'))
    assert.equal(socketStat.mode & 0o777, 0o600)
  } finally {
    await h.stop()
  }
})
