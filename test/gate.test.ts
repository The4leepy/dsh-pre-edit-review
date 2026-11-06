import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActivationRegistry } from '../packages/dsh-plugin/src/activation.ts'
import { installGate } from '../packages/dsh-plugin/src/gate.ts'
import { createKillSwitch } from '../packages/dsh-plugin/src/kill-switch.ts'
import { checkHostCapabilities } from '../packages/dsh-plugin/src/index.ts'
import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import type { HostContext, ToolExecutionResultView } from '../packages/dsh-plugin/src/host.ts'
import type { ReviewCoordinator, ReviewResult } from '../packages/dsh-plugin/src/review-coordinator.ts'

type Listener = (exec: any, next: () => Promise<ToolExecutionResultView>) => Promise<unknown>

function makeCtx(toolsGetImpl?: (name: string) => unknown): HostContext & { fire: Listener } {
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
      get: (name: string) => {
        if (toolsGetImpl !== undefined) return toolsGetImpl(name)
        return { name, description: '', parameters: {}, output: { schema: {}, render: () => [] } }
      },
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

function execFor(name: string, agent?: unknown): any {
  return {
    name,
    callId: 'c1',
    arguments: {},
    ...(agent !== undefined ? { agent } : {}),
    signal: new AbortController().signal,
  }
}

function sessionAgent(sessionId: string): any {
  return { id: `agent-${sessionId}`, session: { id: sessionId, append() {} } }
}

function coordinatorReturning(result: ReviewResult): ReviewCoordinator {
  return { review: async () => result } as unknown as ReviewCoordinator
}

const passNext = async () => ({ isError: false as const, value: 'passthrough' })
const noKillSwitch = () => createKillSwitch('/nonexistent-state-dir', 0)

test('kill switch active pauses every tool (even an explicitly active session)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-kill-'))
  await writeFile(join(dir, 'DISABLED'), '', 'utf8')
  const killSwitch = createKillSwitch(dir, 0)
  const activation = createActivationRegistry(false)
  const agent = sessionAgent('kill-switch-active')
  activation.set(agent, true)
  let reviewed = 0
  const ctx = makeCtx()
  installGate({
    ctx,
    config: normalizeConfig({ defaultActive: false }),
    coordinator: {
      review: async () => {
        reviewed += 1
        return { isError: false as const, value: 'reviewed' }
      },
    } as unknown as ReviewCoordinator,
    killSwitch,
    activation,
  })
  assert.equal(killSwitch.active(), true)
  assert.equal(activation.isActive(agent), true)
  const realToolResult = { isError: false as const, value: 'real-tool-ran' }
  let nextCalls = 0
  const result = await ctx.fire(execFor('write', agent), async () => {
    nextCalls += 1
    return realToolResult
  })
  assert.equal(result, realToolResult)
  assert.equal(nextCalls, 1)
  assert.equal(reviewed, 0)
})

test('kill switch file removal (with cache disabled) deactivates it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-kill-'))
  await writeFile(join(dir, 'DISABLED'), '', 'utf8')
  const killSwitch = createKillSwitch(dir, 0)
  assert.equal(killSwitch.active(), true)
  await unlink(join(dir, 'DISABLED'))
  assert.equal(killSwitch.active(), false)
})

test('kill switch wins over an explicitly active session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-kill-'))
  await writeFile(join(dir, 'DISABLED'), '', 'utf8')
  const activation = createActivationRegistry(false)
  const agent = sessionAgent('s1')
  activation.set(agent, true)
  const ctx = makeCtx()
  let reviewed = 0
  installGate({
    ctx,
    config: normalizeConfig({ defaultActive: false }),
    coordinator: {
      review: async () => {
        reviewed += 1
        return { isError: false, value: 'reviewed' }
      },
    } as unknown as ReviewCoordinator,
    killSwitch: createKillSwitch(dir, 0),
    activation,
  })
  let nextCalls = 0
  const result = await ctx.fire(execFor('write', agent), async () => {
    nextCalls += 1
    return { isError: false, value: 'direct' }
  })
  assert.deepEqual(result, { isError: false, value: 'direct' })
  assert.equal(nextCalls, 1)
  assert.equal(reviewed, 0)
})

test('reviewed tool goes through the coordinator and never calls next', async () => {
  let nextCalls = 0
  const ctx = makeCtx()
  const expected = { isError: false as const, value: { path: '/ws/a.ts', operation: 'update', before: 'a', after: 'b' } }
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: coordinatorReturning(expected),
    killSwitch: noKillSwitch(),
    activation: createActivationRegistry(true),
  })
  const result = await ctx.fire(execFor('write'), async () => {
    nextCalls += 1
    return { isError: false, value: 'next' }
  })
  assert.deepEqual(result, expected)
  assert.equal(nextCalls, 0)
})

test('review inactive by default: the tool runs untouched and the registry is never consulted', async () => {
  let toolsGetCalls = 0
  const ctx = makeCtx(() => {
    toolsGetCalls += 1
    throw new Error('the inactive fast path must not look up tool definitions')
  })
  let reviewed = 0
  installGate({
    ctx,
    config: normalizeConfig({ defaultActive: false }),
    coordinator: {
      review: async () => {
        reviewed += 1
        return { isError: false, value: 'reviewed' }
      },
    } as unknown as ReviewCoordinator,
    killSwitch: noKillSwitch(),
    activation: createActivationRegistry(false),
  })
  let nextCalls = 0
  const result = await ctx.fire(execFor('write'), async () => {
    nextCalls += 1
    return { isError: false, value: 'direct' }
  })
  assert.deepEqual(result, { isError: false, value: 'direct' })
  assert.equal(nextCalls, 1)
  assert.equal(reviewed, 0)
  assert.equal(toolsGetCalls, 0)
})

test('an explicitly inactive session bypasses review while another session is reviewed', async () => {
  const activation = createActivationRegistry(true)
  const inactiveAgent = sessionAgent('off')
  const activeAgent = sessionAgent('on')
  activation.set(inactiveAgent, false)
  const ctx = makeCtx()
  let reviewed = 0
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: {
      review: async () => {
        reviewed += 1
        return { isError: false, value: 'reviewed' }
      },
    } as unknown as ReviewCoordinator,
    killSwitch: noKillSwitch(),
    activation,
  })
  let nextCalls = 0
  const bypassed = await ctx.fire(execFor('write', inactiveAgent), async () => {
    nextCalls += 1
    return { isError: false, value: 'direct' }
  })
  assert.deepEqual(bypassed, { isError: false, value: 'direct' })
  assert.equal(nextCalls, 1)
  assert.equal(reviewed, 0)

  const reviewedResult = await ctx.fire(execFor('write', activeAgent), passNext)
  assert.deepEqual(reviewedResult, { isError: false, value: 'reviewed' })
  assert.equal(reviewed, 1)
})

test('a coordinator bug fails closed for the reviewed call only', async () => {
  const ctx = makeCtx()
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: {
      review: async () => {
        throw new Error('boom')
      },
    } as unknown as ReviewCoordinator,
    killSwitch: noKillSwitch(),
    activation: createActivationRegistry(true),
  })
  const result = (await ctx.fire(execFor('write'), passNext)) as ToolExecutionResultView
  assert.equal(result.isError, true)
  assert.match(String(result.error?.message), /boom/)
})

test('non-reviewed tools pass through untouched', async () => {
  const ctx = makeCtx()
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: coordinatorReturning({ passthrough: true }),
    killSwitch: noKillSwitch(),
    activation: createActivationRegistry(true),
  })
  let nextCalls = 0
  await ctx.fire(execFor('bash'), async () => {
    nextCalls += 1
    return { isError: false, value: 'ok' }
  })
  assert.equal(nextCalls, 1)
})

test('a broken tool registry cannot lock out non-review tools', async () => {
  const ctx = makeCtx(() => {
    throw new Error('cannot get property "tools" without inject')
  })
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: coordinatorReturning({ passthrough: true }),
    killSwitch: noKillSwitch(),
    activation: createActivationRegistry(true),
  })
  let bashCalls = 0
  await ctx.fire(execFor('bash'), async () => {
    bashCalls += 1
    return { isError: false, value: 'ok' }
  })
  assert.equal(bashCalls, 1)
})

test('mutating-looking unknown tools are denied by default', async () => {
  const ctx = makeCtx()
  installGate({
    ctx,
    config: normalizeConfig({}),
    coordinator: coordinatorReturning({ passthrough: true }),
    killSwitch: noKillSwitch(),
    activation: createActivationRegistry(true),
  })
  const result = (await ctx.fire(execFor('delete_file'), passNext)) as ToolExecutionResultView
  assert.equal(result.isError, true)
})

test('checkHostCapabilities reports missing services instead of throwing', () => {
  assert.equal(checkHostCapabilities(makeCtx() as any), undefined)
  const missingFs = { ...makeCtx(), fs: {} } as any
  assert.match(String(checkHostCapabilities(missingFs)), /filesystem/)
  const missingTools = { ...makeCtx(), tools: {} } as any
  assert.match(String(checkHostCapabilities(missingTools)), /tool registry/)
  const throwing = {
    get fs(): never {
      throw new Error('cannot get property "fs" without inject')
    },
    tools: {},
  } as any
  assert.match(String(checkHostCapabilities(throwing)), /without inject/)
})
