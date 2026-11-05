import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IpcServer } from '../packages/dsh-plugin/src/ipc/server.ts'
import type { DecisionHandling, ReviewDecision } from '../packages/dsh-plugin/src/ipc/server.ts'
import type { ReviewRequestParams } from '../packages/shared/src/protocol.ts'
import { splitFrames } from '../packages/shared/src/protocol.ts'

interface Harness {
  dir: string
  server: IpcServer
  decisions: ReviewDecision[]
  stop(): Promise<void>
}

async function harness(handle?: (decision: ReviewDecision) => Promise<DecisionHandling>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-ipc-'))
  const decisions: ReviewDecision[] = []
  const server = new IpcServer({
    stateDir: dir,
    socketPath: join(dir, 'ipc.sock'),
    serverVersion: 'test',
    handleDecision: async (decision) => {
      decisions.push(decision)
      return handle === undefined ? { outcome: decision.status === 'accept' ? 'committed' : 'rejected' } : await handle(decision)
    },
  })
  await server.start()
  return {
    dir,
    server,
    decisions,
    stop: async () => {
      await server.stop()
    },
  }
}

/** Minimal raw client that exposes a promise for one reply matching a predicate. */
function rawClient(socketPath: string) {
  const socket = connect(socketPath)
  let buffer = ''
  const waiters: Array<(message: any) => void> = []
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
    send(message: unknown) {
      socket.write(`${JSON.stringify(message)}\n`)
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
    requestId: 'req-1',
    nonce: 'n'.repeat(32),
    protocolVersion: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    sessionId: 'session-1',
    sessionLabel: 'ws#session',
    toolName: 'write',
    callId: 'call-1',
    operation: 'update',
    displayPath: 'src/a.ts',
    absolutePath: '/ws/src/a.ts',
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

test('handshake, review request, and decision round-trip', async () => {
  const h = await harness()
  try {
    const token = await h.server.readToken()
    const client = rawClient(join(h.dir, 'ipc.sock'))
    client.send({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token, protocolVersion: 1, client: { name: 't', version: '1' } } })
    const hello = await client.next()
    assert.equal(hello.result.ok, true)
    assert.equal(h.server.connected, true)

    const pending = h.server.request(requestParams(), { timeoutMs: 5_000, signal: new AbortController().signal })
    const notification = await client.next()
    assert.equal(notification.method, 'review/request')
    assert.equal(notification.params.requestId, 'req-1')

    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'decision',
      params: { requestId: 'req-1', nonce: 'n'.repeat(32), status: 'accept', finalContent: 'edited\n' },
    })
    const reply = await client.next()
    assert.equal(reply.result.outcome, 'committed')
    const resolved = await pending
    assert.equal(resolved.outcome.outcome, 'committed')
    assert.equal(h.decisions[0].finalContent, 'edited\n')
    client.close()
  } finally {
    await h.stop()
  }
})

test('wrong token is rejected and the socket closes', async () => {
  const h = await harness()
  try {
    const client = rawClient(join(h.dir, 'ipc.sock'))
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'hello',
      params: { token: 'x'.repeat(64), protocolVersion: 1, client: { name: 't', version: '1' } },
    })
    const reply = await client.next()
    assert.equal(reply.error.code, -32001)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(h.server.connected, false)
    client.close()
  } finally {
    await h.stop()
  }
})

test('a request without a connected client rejects immediately', async () => {
  const h = await harness()
  try {
    await assert.rejects(
      () => h.server.request(requestParams(), { timeoutMs: 1_000, signal: new AbortController().signal }),
      /no review client connected/,
    )
  } finally {
    await h.stop()
  }
})

test('an unanswered request times out and fails closed', async () => {
  const h = await harness()
  try {
    const token = await h.server.readToken()
    const client = rawClient(join(h.dir, 'ipc.sock'))
    client.send({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token, protocolVersion: 1, client: { name: 't', version: '1' } } })
    await client.next()
    await assert.rejects(
      () => h.server.request(requestParams(), { timeoutMs: 120, signal: new AbortController().signal }),
      /timed out/,
    )
    client.close()
  } finally {
    await h.stop()
  }
})

test('a duplicate decision is answered with already-decided and handled once', async () => {
  const h = await harness()
  try {
    const token = await h.server.readToken()
    const client = rawClient(join(h.dir, 'ipc.sock'))
    client.send({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token, protocolVersion: 1, client: { name: 't', version: '1' } } })
    await client.next()

    const pending = h.server.request(requestParams(), { timeoutMs: 5_000, signal: new AbortController().signal })
    await client.next()
    const decision = {
      jsonrpc: '2.0',
      id: 2,
      method: 'decision',
      params: { requestId: 'req-1', nonce: 'n'.repeat(32), status: 'reject', reason: 'no' },
    }
    client.send(decision)
    const first = await client.next()
    assert.equal(first.result.outcome, 'rejected')
    client.send({ ...decision, id: 3 })
    const second = await client.next()
    assert.equal(second.result.outcome, 'already-decided')
    await pending
    assert.equal(h.decisions.length, 1)
    client.close()
  } finally {
    await h.stop()
  }
})

test('a disconnect rejects outstanding requests', async () => {
  const h = await harness()
  try {
    const token = await h.server.readToken()
    const client = rawClient(join(h.dir, 'ipc.sock'))
    client.send({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token, protocolVersion: 1, client: { name: 't', version: '1' } } })
    await client.next()
    const pending = h.server.request(requestParams(), { timeoutMs: 5_000, signal: new AbortController().signal })
    await client.next()
    client.socket.destroy()
    await assert.rejects(() => pending, /disconnected/)
  } finally {
    await h.stop()
  }
})
