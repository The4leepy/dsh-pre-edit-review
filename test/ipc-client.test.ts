import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import { HostInUseError, IpcServer } from '../packages/dsh-plugin/src/ipc/server.ts'
import { resolveHostPaths } from '../packages/dsh-plugin/src/paths.ts'
import { IpcClient } from '../packages/vscode-extension/src/ipc-client.ts'

interface ServerHarness {
  root: string
  hostDir: string
  socketPath: string
  tokenPath: string
  server: IpcServer
}

async function startHost(
  root: string,
  hostKey: string,
  withIdentity = true,
  mode?: () => boolean,
): Promise<ServerHarness> {
  const paths = resolveHostPaths(normalizeConfig({ stateDir: root, hostKey }))
  const server = new IpcServer({
    stateDir: paths.hostDir,
    socketPath: paths.socketPath,
    tokenPath: paths.tokenPath,
    ...(withIdentity ? { hostKey: paths.hostKey, hostLabel: `label-${paths.hostKey}` } : {}),
    ...(mode !== undefined ? { mode } : {}),
    serverVersion: 'test',
    handleDecision: async () => ({ outcome: 'committed' }),
  })
  await server.start()
  return { root, hostDir: paths.hostDir, socketPath: paths.socketPath, tokenPath: paths.tokenPath, server }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

function makeClient(harness: ServerHarness) {
  const events: string[] = []
  const client = new IpcClient({
    stateDir: harness.hostDir,
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    hostKey: 'from-discovery',
    hostLabel: 'discovery label',
    clientVersion: 'test',
    reconnectDelayMs: 100,
    onNotification: (): void => undefined,
    onConnectionChanged: (info): void => {
      events.push(info.connected ? 'connected' : 'disconnected')
    },
    log: (): void => undefined,
  })
  return { client, events }
}

test('the extension client connects to a real per-Host server and adopts its identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-client-'))
  const harness = await startHost(root, 'alpha')
  const { client, events } = makeClient(harness)
  try {
    assert.equal(client.connected, false)
    client.start()
    assert.equal(await waitFor(() => client.connected), true)
    assert.deepEqual(events, ['connected'])
    // The Host is authoritative for its own identity.
    assert.equal(client.hostKey, 'alpha')
    assert.equal(client.hostLabel, 'label-alpha')
    assert.equal(client.tokenPath, harness.tokenPath)
    // The token this client read is the per-Host token, not a root-level one.
    const token = (await readFile(harness.tokenPath, 'utf8')).trim()
    assert.equal(token.length, 64)
    assert.equal(client.connected, true)
  } finally {
    client.stop()
    await harness.server.stop()
  }
})

test('two Host servers accept independent clients with independent tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-client-'))
  const alpha = await startHost(root, 'alpha')
  const beta = await startHost(root, 'beta')
  const alphaClient = makeClient(alpha)
  const betaClient = makeClient(beta)
  try {
    alphaClient.client.start()
    betaClient.client.start()
    assert.equal(await waitFor(() => alphaClient.client.connected), true)
    assert.equal(await waitFor(() => betaClient.client.connected), true)
    assert.equal(alphaClient.client.hostKey, 'alpha')
    assert.equal(betaClient.client.hostKey, 'beta')
    assert.notEqual(
      (await readFile(alpha.tokenPath, 'utf8')).trim(),
      (await readFile(beta.tokenPath, 'utf8')).trim(),
    )
  } finally {
    alphaClient.client.stop()
    betaClient.client.stop()
    await alpha.server.stop()
    await beta.server.stop()
  }
})

test('a server without identity fields leaves the discovery identity in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-client-'))
  const harness = await startHost(root, 'legacyish', false)
  const { client } = makeClient(harness)
  try {
    client.start()
    assert.equal(await waitFor(() => client.connected), true)
    // No hostKey in hello: the value from discovery survives.
    assert.equal(client.hostKey, 'from-discovery')
    assert.equal(client.hostLabel, 'discovery label')
  } finally {
    client.stop()
    await harness.server.stop()
  }
})

test('a second Host on the same namespace fails with HOST_IN_USE and keeps the winner serving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-client-'))
  const winner = await startHost(root, 'same-profile')
  const client = makeClient(winner)
  const loser = new IpcServer({
    stateDir: winner.hostDir,
    socketPath: winner.socketPath,
    tokenPath: winner.tokenPath,
    hostKey: 'same-profile',
    serverVersion: 'test',
    handleDecision: async () => ({ outcome: 'committed' }),
  })
  const winnerToken = (await readFile(winner.tokenPath, 'utf8')).trim()
  try {
    client.client.start()
    assert.equal(await waitFor(() => client.client.connected), true)

    await assert.rejects(
      () => loser.start(),
      (error: unknown) => error instanceof HostInUseError && error.code === 'HOST_IN_USE',
    )
    // The loser must not have rewritten the winner's token or socket.
    assert.equal((await readFile(winner.tokenPath, 'utf8')).trim(), winnerToken)
    assert.equal(winner.server.bound, true)
    // The winner keeps serving its authenticated client.
    assert.equal(client.client.connected, true)
    await loser.stop()
    assert.equal(winner.server.bound, true)
    assert.equal(client.client.connected, true)
  } finally {
    client.client.stop()
    await winner.server.stop()
  }
})

test('a rejected hello destroys the connection and reports a disconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-client-'))
  const harness = await startHost(root, 'authy')
  // A syntactically valid but wrong token: the Host must reject the hello.
  const wrongTokenPath = join(harness.hostDir, 'not-the-token')
  await writeFile(wrongTokenPath, `${'a'.repeat(64)}\n`, { encoding: 'utf8', mode: 0o600 })
  const events: string[] = []
  const client = new IpcClient({
    stateDir: harness.hostDir,
    socketPath: harness.socketPath,
    // Point at a token the Host never published so the hello is rejected.
    tokenPath: wrongTokenPath,
    clientVersion: 'test',
    reconnectDelayMs: 10_000,
    onNotification: (): void => undefined,
    onConnectionChanged: (info): void => {
      events.push(info.connected ? 'connected' : info.authFailed === true ? 'auth-failed' : 'disconnected')
    },
    log: (): void => undefined,
  })
  try {
    client.start()
    assert.equal(await waitFor(() => events.length > 0), true)
    assert.equal(client.connected, false)
    assert.equal(events.includes('auth-failed'), true)
    assert.equal(harness.server.connected, false)
  } finally {
    client.stop()
    await harness.server.stop()
  }
})


test('the hello result and review/mode push carry the review-inactive flag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-client-'))
  let paused = true
  const harness = await startHost(root, 'mode-flag', true, () => paused)
  const connections: Array<{ connected: boolean; paused?: boolean }> = []
  const notifications: any[] = []
  const client = new IpcClient({
    stateDir: harness.hostDir,
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    clientVersion: 'test',
    reconnectDelayMs: 10_000,
    onNotification: (notification): void => {
      notifications.push(notification)
    },
    onConnectionChanged: (info): void => {
      connections.push({ connected: info.connected, ...(info.paused !== undefined ? { paused: info.paused } : {}) })
    },
    log: (): void => undefined,
  })
  try {
    client.start()
    assert.equal(await waitFor(() => client.connected), true)
    // defaultActive=false with no active session: the Host reports inactive.
    assert.deepEqual(connections, [{ connected: true, paused: true }])

    paused = false
    harness.server.notifyMode({ paused: false })
    assert.equal(await waitFor(() => notifications.some((n) => n.method === 'review/mode')), true)
    const mode = notifications.find((n) => n.method === 'review/mode')
    assert.equal(mode.params.paused, false)
  } finally {
    client.stop()
    await harness.server.stop()
  }
})
