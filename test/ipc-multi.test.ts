import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { HostInUseError, IpcServer } from '../packages/dsh-plugin/src/ipc/server.ts'
import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import { resolveHostPaths, type HostPaths } from '../packages/dsh-plugin/src/paths.ts'
import { splitFrames, type ReviewRequestParams } from '../packages/shared/src/protocol.ts'

interface HostHarness {
  paths: HostPaths
  server: IpcServer
}

function hostFor(root: string, hostKey: string): HostHarness {
  const paths = resolveHostPaths(normalizeConfig({ stateDir: root, hostKey }))
  const server = new IpcServer({
    stateDir: paths.hostDir,
    socketPath: paths.socketPath,
    tokenPath: paths.tokenPath,
    hostKey: paths.hostKey,
    hostLabel: paths.hostLabel,
    serverVersion: 'test',
    handleDecision: async () => ({ outcome: 'committed' }),
  })
  return { paths, server }
}

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
    send(message: unknown): void {
      socket.write(`${JSON.stringify(message)}\n`)
    },
    next(): Promise<any> {
      return new Promise((resolve) => waiters.push(resolve))
    },
    close(): void {
      socket.destroy()
    },
  }
}

type Client = ReturnType<typeof rawClient>

async function handshake(server: IpcServer, client: Client): Promise<any> {
  const token = await server.readToken()
  client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'hello',
    params: { token, protocolVersion: 1, client: { name: 't', version: '1' } },
  })
  return client.next()
}

function requestParams(overrides: Partial<ReviewRequestParams> = {}): ReviewRequestParams {
  return {
    requestId: 'req-multi',
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

/** Give the server a tick to notice a probe/disconnect before the next client. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('two Hosts in two host directories coexist and report their identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-multi-'))
  const desktop = hostFor(root, 'desktop')
  const tui = hostFor(root, 'tui')
  try {
    await desktop.server.start()
    await tui.server.start()
    assert.notEqual(desktop.paths.socketPath, tui.paths.socketPath)
    assert.notEqual(await desktop.server.readToken(), await tui.server.readToken())

    const desktopClient = rawClient(desktop.paths.socketPath)
    const desktopHello = await handshake(desktop.server, desktopClient)
    assert.equal(desktopHello.result.ok, true)
    assert.equal(desktopHello.result.hostKey, 'desktop')
    assert.equal(desktopHello.result.hostLabel, 'desktop')
    assert.equal(desktopHello.result.stateDir, desktop.paths.hostDir)

    const tuiClient = rawClient(tui.paths.socketPath)
    const tuiHello = await handshake(tui.server, tuiClient)
    assert.equal(tuiHello.result.hostKey, 'tui')
    assert.equal(tuiHello.result.stateDir, tui.paths.hostDir)

    // review/request carries the origin Host additively.
    const pending = desktop.server.request(requestParams(), { timeoutMs: 5_000, signal: new AbortController().signal })
    const notification = await desktopClient.next()
    assert.equal(notification.method, 'review/request')
    assert.equal(notification.params.hostKey, 'desktop')
    desktopClient.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'decision',
      params: { requestId: 'req-multi', nonce: 'n'.repeat(32), status: 'reject' },
    })
    await desktopClient.next()
    await pending

    // Both tokens stay private, both sockets exist.
    assert.equal((await stat(desktop.paths.tokenPath)).mode & 0o777, 0o600)
    assert.equal((await stat(tui.paths.tokenPath)).mode & 0o777, 0o600)
    assert.equal(existsSync(desktop.paths.socketPath), true)
    assert.equal(existsSync(tui.paths.socketPath), true)
    desktopClient.close()
    tuiClient.close()
  } finally {
    await desktop.server.stop()
    await tui.server.stop()
  }
})

test("a second Host on an occupied socket fails with HOST_IN_USE and keeps the winner's socket/token intact", async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-multi-'))
  const first = hostFor(root, 'desktop')
  const contender = hostFor(root, 'desktop')
  try {
    await first.server.start()
    const tokenBefore = await readFile(first.paths.tokenPath, 'utf8')

    await assert.rejects(
      () => contender.server.start(),
      (error: unknown) => {
        assert.equal(error instanceof HostInUseError, true)
        assert.equal((error as HostInUseError).code, 'HOST_IN_USE')
        assert.equal((error as HostInUseError).socketPath, first.paths.socketPath)
        assert.match((error as Error).message, /already listening/)
        return true
      },
    )
    assert.equal(contender.server.bound, false)

    // The winner's token is byte-identical: publish happens only after binding.
    assert.equal(await readFile(first.paths.tokenPath, 'utf8'), tokenBefore)
    // The loser's stop() must not unlink the winner's socket.
    await contender.server.stop()
    assert.equal(existsSync(first.paths.socketPath), true)
    await settle()

    const client = rawClient(first.paths.socketPath)
    const hello = await handshake(first.server, client)
    assert.equal(hello.result.ok, true)
    assert.equal(hello.result.hostKey, 'desktop')
    client.close()
  } finally {
    await first.server.stop()
    await contender.server.stop()
  }
})

test('a Host that fails to bind never publishes its own token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-multi-'))
  const first = hostFor(root, 'desktop')
  const otherTokenPath = join(root, 'other', 'token')
  const contender = new IpcServer({
    stateDir: join(root, 'other'),
    socketPath: first.paths.socketPath,
    tokenPath: otherTokenPath,
    serverVersion: 'test',
    handleDecision: async () => ({ outcome: 'committed' }),
  })
  try {
    await first.server.start()
    await assert.rejects(() => contender.start(), HostInUseError)
    assert.equal(existsSync(otherTokenPath), false)
  } finally {
    await first.server.stop()
  }
})

test('a server without host identity keeps the legacy handshake shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-multi-'))
  const server = new IpcServer({
    stateDir: root,
    socketPath: join(root, 'ipc.sock'),
    serverVersion: 'test',
    handleDecision: async () => ({ outcome: 'rejected' }),
  })
  try {
    await server.start()
    const client = rawClient(join(root, 'ipc.sock'))
    const hello = await handshake(server, client)
    assert.equal(hello.result.ok, true)
    assert.equal('hostKey' in hello.result, false)
    assert.equal('hostLabel' in hello.result, false)
    client.close()
  } finally {
    await server.stop()
  }
})

test('a stale socket file from a crashed Host is reclaimed after a probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-multi-'))
  const host = hostFor(root, 'desktop')
  await mkdir(host.paths.hostDir, { recursive: true })
  // A crashed Host leaves the socket path behind; it is not a live listener.
  await writeFile(host.paths.socketPath, '', 'utf8')
  try {
    await host.server.start()
    assert.equal(host.server.bound, true)
    assert.equal((await stat(host.paths.socketPath)).mode & 0o777, 0o600)
    const client = rawClient(host.paths.socketPath)
    const hello = await handshake(host.server, client)
    assert.equal(hello.result.hostKey, 'desktop')
    client.close()
  } finally {
    await host.server.stop()
  }
  assert.equal(existsSync(host.paths.socketPath), false)
})

test('an in-process handoff serializes close and bind so the new socket survives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-multi-'))
  const first = hostFor(root, 'handoff')
  await first.server.start()
  try {
    // HMR/restart ordering: the old runtime starts closing while the new runtime
    // starts. libuv unlinks the path during the old close, so the new instance
    // must bind only afterwards (process-wide owner serialization).
    const stopping = first.server.stop()
    const second = hostFor(root, 'handoff')
    await second.server.start()
    await stopping
    assert.equal(existsSync(second.paths.socketPath), true)
    const client = rawClient(second.paths.socketPath)
    const hello = await handshake(second.server, client)
    assert.equal(hello.result.ok, true)
    client.close()
    await second.server.stop()
    assert.equal(existsSync(second.paths.socketPath), false)
  } finally {
    await first.server.stop()
  }
})

test('a live Host owns the single client slot: a second connection is destroyed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-multi-'))
  const host = hostFor(root, 'single-client')
  await host.server.start()
  try {
    const first = rawClient(host.paths.socketPath)
    const hello = await handshake(host.server, first)
    assert.equal(hello.result.ok, true)
    assert.equal(host.server.connected, true)

    const second = rawClient(host.paths.socketPath)
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000)
      second.socket.once('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
      second.socket.once('error', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    assert.equal(closed, true)
    // The authenticated client keeps the slot.
    assert.equal(host.server.connected, true)
    first.close()
  } finally {
    await host.server.stop()
  }
})
