import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBypassRegistry } from '../packages/dsh-plugin/src/bypass.ts'
import { installGate } from '../packages/dsh-plugin/src/gate.ts'
import { createKillSwitch } from '../packages/dsh-plugin/src/kill-switch.ts'
import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import { isServerNotification } from '../packages/shared/src/protocol.ts'
import type { HostContext, ToolExecutionResultView } from '../packages/dsh-plugin/src/host.ts'
import type { ReviewCoordinator } from '../packages/dsh-plugin/src/review-coordinator.ts'

test('bypass registry is per session and can be cleared', () => {
  const registry = createBypassRegistry()
  const sessionA = { id: 'a' }
  const sessionB = { id: 'b' }
  assert.equal(registry.isBypassed(sessionA), false)
  assert.equal(registry.anyActive(), false)

  registry.set(sessionA, true)
  assert.equal(registry.isBypassed(sessionA), true)
  assert.equal(registry.isBypassed(sessionB), false)
  assert.equal(registry.isBypassed(undefined), false)
  assert.equal(registry.anyActive(), true)
  assert.equal(registry.activeCount(), 1)

  registry.set(sessionA, false)
  assert.equal(registry.anyActive(), false)
})

test('review/mode is a valid server notification only with a boolean bypass', () => {
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { bypass: true } }), true)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { bypass: false } }), true)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: { bypass: 'yes' } }), false)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/mode', params: {} }), false)
  assert.equal(isServerNotification({ jsonrpc: '2.0', method: 'review/request', params: {} }), false)
})

test('allowBypass defaults to true and can be disabled by configuration', () => {
  assert.equal(normalizeConfig({}).allowBypass, true)
  assert.equal(normalizeConfig({ allowBypass: false }).allowBypass, false)
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

test('a bypassed session goes straight to the tool body', async () => {
  const ctx = makeCtx()
  const bypass = createBypassRegistry()
  const session = { id: 'bypassed' }
  bypass.set(session, true)
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
    bypass,
  })
  let nextCalls = 0
  await ctx.fire(execFor(session), async () => {
    nextCalls += 1
    return { isError: false, value: 'direct' }
  })
  assert.equal(nextCalls, 1)
  assert.equal(reviewed, 0)
})

test('another session still goes through review while one session is bypassed', async () => {
  const ctx = makeCtx()
  const bypass = createBypassRegistry()
  bypass.set({ id: 'bypassed' }, true)
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: { review: async () => ({ isError: false, value: 'reviewed' }) } as unknown as ReviewCoordinator,
    killSwitch: createKillSwitch('/nonexistent-state-dir', 0),
    bypass,
  })
  let nextCalls = 0
  const result = (await ctx.fire(execFor({ id: 'reviewed' }), async () => {
    nextCalls += 1
    return { isError: false, value: 'direct' }
  })) as ToolExecutionResultView
  assert.equal(nextCalls, 0)
  assert.equal(result.value, 'reviewed')
})
