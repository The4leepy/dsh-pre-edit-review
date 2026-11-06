import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../packages/dsh-plugin/src/index.ts'
import type { HostContext } from '../packages/dsh-plugin/src/host.ts'

interface CommandHost {
  ctx: HostContext & {
    fireSessionDisposed?(session: unknown): void
    fireAgentDisposed?(agent: unknown): void
    dispose(): void
  }
  stateDir: string
  hostDir: string
  command(rawInput: string, agent: any): Promise<{ kind: 'success' | 'error'; text?: string }>
}

interface CommandHostOptions {
  stateDir?: string
  hostKey?: string
  config?: Record<string, unknown>
}

const silentLogger = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined }

function agentFor(sessionId: string): any {
  return { id: `agent-${sessionId}`, session: { id: sessionId, append: (): void => undefined } }
}

async function commandHost(options: CommandHostOptions = {}): Promise<CommandHost> {
  const stateDir = options.stateDir ?? (await mkdtemp(join(tmpdir(), 'dpr-cmd-')))
  const hostKey = options.hostKey ?? 'cmd-host'
  let commandHandler: ((invocation: any) => Promise<any>) | undefined
  let disposeRuntime: (() => void) | undefined
  const listeners = new Map<string, Array<(payload: any) => void>>()

  const ctx = {
    fs: {
      resolve: async () => ({ targetKey: '/ws/a.ts', displayPath: '/ws/a.ts' }),
      contains: () => true,
      stat: async () => undefined,
      readText: async () => '',
      writeText: async () => ({ operation: 'create', version: 'v1', before: null, after: '' }),
      processPath: () => '/ws/a.ts',
    },
    tools: { get: () => undefined, register: () => () => undefined, schemas: () => [] },
    get(name: string) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      return undefined
    },
    emit: (): void => undefined,
    on(event: string, listener: (payload: any) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => undefined
    },
    inject(services: string[], callback: (scope: any) => void) {
      if (!services.includes('commands')) return
      callback({
        commands: {
          register(definition: { handler: (invocation: any) => Promise<any> }) {
            commandHandler = definition.handler
            return () => undefined
          },
        },
      })
    },
    effect(callback: () => (() => void) | void) {
      const disposer = callback()
      if (typeof disposer === 'function') disposeRuntime = disposer
    },
    logger: silentLogger,
  } as unknown as HostContext

  apply(ctx, { enabled: true, mode: 'review', stateDir, hostKey, ...(options.config ?? {}) })

  const host: CommandHost = {
    ctx: Object.assign(ctx, {
      fireSessionDisposed(session: unknown) {
        for (const listener of listeners.get('session/disposed') ?? []) listener(session)
      },
      fireAgentDisposed(agent: unknown) {
        for (const listener of listeners.get('agent/disposed') ?? []) listener({ agent })
      },
      dispose() {
        disposeRuntime?.()
      },
    }),
    stateDir,
    hostDir: join(stateDir, 'hosts', hostKey),
    command(rawInput: string, agent: any) {
      if (commandHandler === undefined) throw new Error('the /review command was not registered')
      return commandHandler({ rawInput, agent })
    },
  }
  // Wait for the async runtime start so teardown removes its socket/meta.
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      await readFile(join(host.hostDir, 'meta.json'), 'utf8')
      break
    } catch {
      if (Date.now() >= deadline) throw new Error('the plugin runtime did not start')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return host
}

async function auditLines(hostDir: string): Promise<string[]> {
  const auditDir = join(hostDir, 'audit')
  const files = (await readdir(auditDir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'))
  const lines: string[] = []
  for (const file of files) {
    lines.push(...(await readFile(join(auditDir, file), 'utf8')).split('\n').filter((line) => line.length > 0))
  }
  return lines
}

test('/review status reports the host, the install default and this session state', async () => {
  const host = await commandHost()
  try {
    const status = await host.command('status', agentFor('s1'))
    assert.equal(status.kind, 'success')
    assert.match(status.text ?? '', /host: cmd-host/)
    assert.match(status.text ?? '', /install default: inactive/)
    assert.match(status.text ?? '', /this session: INACTIVE/)
    assert.match(status.text ?? '', /host dir: .*hosts\/cmd-host/)
  } finally {
    host.ctx.dispose()
  }
})

test('/review on and /review off toggle only the requesting session and are audited', async () => {
  const host = await commandHost({ hostKey: 'toggler' })
  const agentA = agentFor('session-a')
  const agentB = agentFor('session-b')
  try {
    const on = await host.command('on', agentA)
    assert.equal(on.kind, 'success')
    assert.match(on.text ?? '', /ACTIVE for this session/)

    const statusA = await host.command('status', agentA)
    assert.match(statusA.text ?? '', /this session: ACTIVE/)
    const statusB = await host.command('status', agentB)
    assert.match(statusB.text ?? '', /this session: INACTIVE/)

    const lines = await auditLines(host.hostDir)
    assert.equal(lines.some((line) => line.includes('review/activated') && line.includes('session-a')), true)

    const off = await host.command('off', agentA)
    assert.equal(off.kind, 'success')
    const statusA2 = await host.command('status', agentA)
    assert.match(statusA2.text ?? '', /this session: INACTIVE/)
    const linesAfter = await auditLines(host.hostDir)
    assert.equal(linesAfter.some((line) => line.includes('review/deactivated') && line.includes('session-a')), true)
  } finally {
    host.ctx.dispose()
  }
})

test('allowPause: false blocks deactivation but not activation', async () => {
  const host = await commandHost({ hostKey: 'strict-cfg', config: { allowPause: false } })
  const agent = agentFor('s1')
  try {
    const on = await host.command('on', agent)
    assert.equal(on.kind, 'success')
    const off = await host.command('off', agent)
    assert.equal(off.kind, 'error')
    assert.match(off.text ?? '', /allowPause: false/)
    const status = await host.command('status', agent)
    assert.match(status.text ?? '', /this session: ACTIVE/)
  } finally {
    host.ctx.dispose()
  }
})

test('mode: "off" blocks activation with an explicit error and the tip stays hidden', async () => {
  const host = await commandHost({ hostKey: 'mode-off', config: { mode: 'off' } })
  const agent = agentFor('s1')
  try {
    const on = await host.command('on', agent)
    assert.equal(on.kind, 'error')
    assert.match(on.text ?? '', /mode: "off"/)
    const status = await host.command('status', agent)
    assert.match(status.text ?? '', /this session: INACTIVE/)
    assert.equal((status.text ?? '').includes('tip: /review on enables review'), false)
  } finally {
    host.ctx.dispose()
  }
})

test('/review history reads this Host audit directory', async () => {
  const host = await commandHost({ hostKey: 'history-host' })
  try {
    await host.command('on', agentFor('session-history'))
    const history = await host.command('history 5', agentFor('session-history'))
    assert.equal(history.kind, 'success')
    assert.match(history.text ?? '', /activated/)
  } finally {
    host.ctx.dispose()
  }
})

test('a disposed session is forgotten so the aggregate state cannot stay stale', async () => {
  const host = await commandHost({ hostKey: 'lifecycle' })
  const agent = agentFor('session-gone')
  try {
    await host.command('on', agent)
    assert.match((await host.command('status', agent)).text ?? '', /this session: ACTIVE/)
    host.ctx.fireSessionDisposed?.({ id: 'session-gone' })
    // A new session (no explicit choice) must report inactive again.
    const fresh = await host.command('status', agentFor('session-new'))
    assert.match(fresh.text ?? '', /this session: INACTIVE/)
    // The forgotten session follows the install default too.
    assert.match((await host.command('status', agent)).text ?? '', /this session: INACTIVE/)
  } finally {
    host.ctx.dispose()
  }
})


test('an agent disposed event prunes the activation choice too', async () => {
  const host = await commandHost({ hostKey: 'agent-lifecycle' })
  const agent = agentFor('agent-gone')
  try {
    await host.command('on', agent)
    assert.match((await host.command('status', agent)).text ?? '', /this session: ACTIVE/)
    host.ctx.fireAgentDisposed?.(agent)
    assert.match((await host.command('status', agent)).text ?? '', /this session: INACTIVE/)
  } finally {
    host.ctx.dispose()
  }
})
