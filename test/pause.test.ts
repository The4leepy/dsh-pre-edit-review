import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPauseRegistry } from '../packages/dsh-plugin/src/pause.ts'
import { installGate } from '../packages/dsh-plugin/src/gate.ts'
import { createKillSwitch } from '../packages/dsh-plugin/src/kill-switch.ts'
import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import { isServerNotification, reviewPaused } from '../packages/shared/src/protocol.ts'
import type { HostContext, ToolExecutionResultView } from '../packages/dsh-plugin/src/host.ts'
import type { ReviewCoordinator } from '../packages/dsh-plugin/src/review-coordinator.ts'

test('pause registry is per session and can be cleared', () => {
  const registry = createPauseRegistry()
  const sessionA = { id: 'a' }
  const sessionB = { id: 'b' }
  assert.equal(registry.isPaused(sessionA), false)
  assert.equal(registry.anyPaused(), false)

  registry.set(sessionA, true)
  assert.equal(registry.isPaused(sessionA), true)
  assert.equal(registry.isPaused(sessionB), false)
  assert.equal(registry.isPaused(undefined), false)
  assert.equal(registry.anyPaused(), true)
  assert.equal(registry.activeCount(), 1)

  registry.set(sessionA, false)
  assert.equal(registry.anyPaused(), false)
})

test('review/mode accepts the paused field and the legacy bypass field', () => {
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { paused: true } }), true)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { paused: false } }), true)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { bypass: true } }), true)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { paused: 'yes' } }), false)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: {} }), false)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/request', params: {} }), false)
  assert.equal(reviewPaused({ paused: true }), true)
  assert.equal(reviewPaused({ bypass: true }), true)
  assert.equal(reviewPaused({ paused: false }), false)
  assert.equal(reviewPaused({}), false)
})

test('allowPause defaults to true and can be disabled by configuration', () => {
  assert.equal(normalizeConfig({}).allowPause, true)
  assert.equal(normalizeConfig({ allowPause: false }).allowPause, false)
  // legacy name still accepted
  assert.equal(normalizeConfig({ allowBypass: false }).allowPause, false)
})

type Listener = (exec: any, next: () => Promise<ToolExecutionResultView>) => Promise<unknown>

function makeCtx(): HostContext & { fire: Listener } {
  let listener: Listener | undefined
  const ctx = {
    fs: {
      resolve: async () => ({ targetKey: '/ws/a.ts', displayPath: '/ws/a.ts' }),
      contains: () => true,
      stat: async () => undefined,
      readText: async () => '',
      writeText: async () => ({ operation: 'create', version: 'v1', before: null, after: '' }),
      processPath: () => '/ws/a.ts',
    },
    tools: {
      get: () => ({ name: 'write', description: '', parameters: {}, output: { schema: {}, render: () => [] } }),
      register: () => () => undefined,
      schemas: () => [],
    },
    get: () => undefined,
    emit: () => undefined,
    on: (_event: string, handler: Listener) => {
      listener = handler
      return () => undefined
    },
  } as unknown as HostContext & { fire: Listener }
  Object.defineProperty(ctx, 'fire', {
    value: (exec: any, next: () => Promise<ToolExecutionResultView>) => {
      if (listener === undefined) throw new Error('gate listener was not installed')
      return listener(exec, next)
    },
  })
  return ctx
}

function execFor(session: object): any {
  return { name: 'write', callId: 'c1', arguments: {}, agent: { id: 'a1', session }, signal: new AbortController().signal }
}

test('a paused session goes straight to the tool body', async () => {
  const ctx = makeCtx()
  const pause = createPauseRegistry()
  const session = { id: 'paused' }
  pause.set(session, true)
  let reviewed = 0
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: {
      review: async () => {
        reviewed += 1
        return { passthrough: true } as never
      },
    } as unknown as ReviewCoordinator,
    killSwitch: createKillSwitch('/nonexistent-state-dir', 0),
    pause,
  })
  let nextCalls = 0
  await ctx.fire(execFor(session), async () => {
    nextCalls += 1
    return { isError: false, value: 'direct' }
  })
  assert.equal(nextCalls, 1)
  assert.equal(reviewed, 0)
})

test('another session still goes through review while one session is paused', async () => {
  const ctx = makeCtx()
  const pause = createPauseRegistry()
  pause.set({ id: 'paused' }, true)
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: { review: async () => ({ isError: false, value: 'reviewed' }) } as unknown as ReviewCoordinator,
    killSwitch: createKillSwitch('/nonexistent-state-dir', 0),
    pause,
  })
  let nextCalls = 0
  const result = (await ctx.fire(execFor({ id: 'reviewed' }), async () => {
    nextCalls += 1
    return { isError: false, value: 'direct' }
  })) as ToolExecutionResultView
  assert.equal(nextCalls, 0)
  assert.deepEqual(result, { isError: false, value: 'reviewed' })
})
