import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import type { HostContext } from '../packages/dsh-plugin/src/host.ts'
import { IpcServer } from '../packages/dsh-plugin/src/ipc/server.ts'
import { writeHostDescriptor } from '../packages/dsh-plugin/src/registry.ts'
import { createRuntime, type PluginRuntime } from '../packages/dsh-plugin/src/runtime.ts'
import type { HostDescriptor } from '../packages/shared/src/index.ts'

const silentLogger = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined }

function runtimeCtx(): HostContext {
  return {
    fs: {
      resolve: async () => ({ targetKey: '/ws/a.ts', displayPath: '/ws/a.ts' }),
      contains: () => true,
      stat: async () => undefined,
      readText: async () => '',
      writeText: async () => ({ operation: 'create', version: 'v1', before: null, after: '' }),
      processPath: () => '/ws/a.ts',
    },
    tools: { get: () => undefined, register: () => () => undefined, schemas: () => [] },
    get: () => undefined,
    emit: (): void => undefined,
    on: () => () => undefined,
  }
}

async function stateExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function makeRuntime(root: string, hostKey: string): PluginRuntime {
  return createRuntime(runtimeCtx(), normalizeConfig({ stateDir: root, hostKey }), silentLogger)
}

test('a clean runtime start publishes socket/token/meta and a clean stop removes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-'))
  const runtime = makeRuntime(root, 'alpha')
  await runtime.ready
  const socketPath = join(root, 'hosts', 'alpha', 'ipc.sock')
  const tokenPath = join(root, 'hosts', 'alpha', 'token')
  const metaPath = join(root, 'hosts', 'alpha', 'meta.json')
  try {
    assert.equal(await stateExists(socketPath), true)
    assert.equal(await stateExists(tokenPath), true)
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as HostDescriptor
    assert.equal(meta.key, 'alpha')
    assert.equal(meta.pid, process.pid)
    assert.equal(meta.stateDir, join(root, 'hosts', 'alpha'))
    assert.equal(runtime.paths.hostDir, join(root, 'hosts', 'alpha'))
    assert.equal(runtime.activation.defaultActive, false)
  } finally {
    await runtime.dispose()
  }
  assert.equal(await stateExists(socketPath), false)
  assert.equal(await stateExists(metaPath), false)
})

test('a second runtime for the same profile fails loudly and leaves the winner serving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-'))
  const winner = makeRuntime(root, 'same-profile')
  await winner.ready
  const metaPath = join(root, 'hosts', 'same-profile', 'meta.json')
  const winnerMeta = await readFile(metaPath, 'utf8')
  const loser = makeRuntime(root, 'same-profile')
  try {
    await assert.rejects(
      () => loser.ready,
      (error: unknown) =>
        error instanceof Error && (error as Error & { code?: string }).code === 'HOST_IN_USE',
    )
    await loser.dispose()
    // The loser never owned the descriptor, so it must not delete it.
    assert.equal(await readFile(metaPath, 'utf8'), winnerMeta)
    assert.equal(await stateExists(join(root, 'hosts', 'same-profile', 'ipc.sock')), true)
  } finally {
    await loser.dispose()
    await winner.dispose()
  }
})

test('a stopping instance does not delete a descriptor published by a newer instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-'))
  const runtime = makeRuntime(root, 'hmr')
  await runtime.ready
  const metaPath = join(root, 'hosts', 'hmr', 'meta.json')
  try {
    const older = JSON.parse(await readFile(metaPath, 'utf8')) as HostDescriptor
    const newer: HostDescriptor = {
      ...older,
      pid: older.pid + 1,
      startedAt: older.startedAt + 10_000,
      pluginVersion: '9.9.9',
      instanceId: 'newer-instance',
    }
    await writeHostDescriptor(metaPath, newer)
    await runtime.dispose()
    // The HMR-overlap guard keeps the newer instance discoverable.
    const current = JSON.parse(await readFile(metaPath, 'utf8')) as HostDescriptor
    assert.equal(current.pid, newer.pid)
    assert.equal(current.startedAt, newer.startedAt)
    assert.equal(current.pluginVersion, '9.9.9')
    // The socket of the stopping instance is still cleaned up.
    assert.equal(await stateExists(join(root, 'hosts', 'hmr', 'ipc.sock')), false)
  } finally {
    await runtime.dispose()
  }
})

test('two profiles run side by side and keep independent state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-'))
  const desktop = makeRuntime(root, 'desktop')
  const tui = makeRuntime(root, 'tui')
  try {
    await Promise.all([desktop.ready, tui.ready])
    const desktopMeta = JSON.parse(
      await readFile(join(root, 'hosts', 'desktop', 'meta.json'), 'utf8'),
    ) as HostDescriptor
    const tuiMeta = JSON.parse(await readFile(join(root, 'hosts', 'tui', 'meta.json'), 'utf8')) as HostDescriptor
    assert.equal(desktopMeta.key, 'desktop')
    assert.equal(tuiMeta.key, 'tui')
    assert.notEqual(desktopMeta.socketPath, tuiMeta.socketPath)
    assert.notEqual(
      (await readFile(desktopMeta.tokenPath, 'utf8')).trim(),
      (await readFile(tuiMeta.tokenPath, 'utf8')).trim(),
    )
  } finally {
    await desktop.dispose()
    await tui.dispose()
  }
})

test('the aggregate indicator combines activation and the kill switch', async () => {
  const { IpcClient } = await import('../packages/vscode-extension/src/ipc-client.ts')
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-'))
  let killed = false
  const runtime = createRuntime(runtimeCtx(), normalizeConfig({ stateDir: root, hostKey: 'indicator' }), silentLogger, {
    isKilled: () => killed,
  })
  await runtime.ready
  const connectOnce = async (): Promise<boolean | undefined> => {
    let paused: boolean | undefined
    const client = new IpcClient({
      stateDir: runtime.paths.hostDir,
      socketPath: runtime.paths.socketPath,
      tokenPath: runtime.paths.tokenPath,
      clientVersion: 'test',
      reconnectDelayMs: 10_000,
      onNotification: (): void => undefined,
      onConnectionChanged: (info): void => {
        if (info.connected) paused = info.paused
      },
      log: (): void => undefined,
    })
    client.start()
    const deadline = Date.now() + 3000
    while (!client.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const connected = client.connected
    client.stop()
    return connected ? paused : undefined
  }
  try {
    // Review activated for a live session: the aggregate is "on".
    runtime.activation.set({ id: 'agent-live', session: { id: 'session-live' } }, true)
    assert.equal(await connectOnce(), false)
    // The install default alone (no active session) is "off".
    runtime.activation.forget({ id: 'agent-live', session: { id: 'session-live' } })
    assert.equal(await connectOnce(), true)
    // Arming the kill switch reports "off" even with an active session.
    runtime.activation.set({ id: 'agent-live', session: { id: 'session-live' } }, true)
    killed = true
    assert.equal(await connectOnce(), true)
  } finally {
    await runtime.dispose()
  }
})

test('start removes a stale 0.2.x root socket/token pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-'))
  await writeFile(join(root, 'ipc.sock'), '', 'utf8')
  await writeFile(join(root, 'token'), 'd'.repeat(64), 'utf8')
  const runtime = makeRuntime(root, 'fresh')
  try {
    await runtime.ready
    assert.equal(await stateExists(join(root, 'ipc.sock')), false)
    assert.equal(await stateExists(join(root, 'token')), false)
    assert.equal(await stateExists(join(root, 'hosts', 'fresh', 'ipc.sock')), true)
  } finally {
    await runtime.dispose()
  }
})

test('start never touches a live 0.2.x root Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-'))
  const legacy = new IpcServer({
    stateDir: root,
    socketPath: join(root, 'ipc.sock'),
    serverVersion: '0.2.1',
    handleDecision: async () => ({ outcome: 'committed' }),
  })
  await legacy.start()
  const runtime = makeRuntime(root, 'observer')
  try {
    await runtime.ready
    assert.equal(await stateExists(join(root, 'ipc.sock')), true)
    assert.equal(await stateExists(join(root, 'token')), true)
  } finally {
    await runtime.dispose()
    await legacy.stop()
  }
})
