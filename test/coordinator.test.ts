import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewCoordinator } from '../packages/dsh-plugin/src/review-coordinator.ts'
import { normalizeConfig } from '../packages/dsh-plugin/src/config.ts'
import { StagingStore } from '../packages/dsh-plugin/src/staging/store.ts'
import { DirectWorkspaceTarget } from '../packages/dsh-plugin/src/targets/direct-workspace.ts'
import type { CommitTargetHost } from '../packages/shared/src/commit-target.ts'
import type { DecisionHandling, ReviewDecision } from '../packages/dsh-plugin/src/ipc/server.ts'
import type { ReviewRequestParams } from '../packages/shared/src/protocol.ts'
import type { ToolExecutionView, ToolExecutionResultView } from '../packages/dsh-plugin/src/host.ts'
import type { ReviewResult } from '../packages/dsh-plugin/src/review-coordinator.ts'

function expectResult(result: ReviewResult): ToolExecutionResultView {
  if ('passthrough' in result) throw new Error('unexpected passthrough')
  return result
}

const ROOT = '/ws'

class FakeHost implements CommitTargetHost {
  readonly files = new Map<string, string>()
  readonly versions = new Map<string, string>()
  readonly writes: string[] = []
  private counter = 0

  async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }) {
    return { targetKey: path.startsWith('/') ? path : join(options?.cwd ?? ROOT, path), displayPath: path }
  }
  contains(parent: unknown, child: unknown): boolean {
    const p = parent as { targetKey: string }
    const c = child as { targetKey: string }
    return c.targetKey === p.targetKey || c.targetKey.startsWith(`${p.targetKey}/`)
  }
  async stat(target: unknown) {
    const version = this.versions.get((target as { targetKey: string }).targetKey)
    return version === undefined ? undefined : { version }
  }
  async readText(target: unknown) {
    const content = this.files.get((target as { targetKey: string }).targetKey)
    if (content === undefined) throw new Error('not found')
    return content
  }
  async writeText(target: unknown, content: string, expected?: { kind: string; version?: unknown }) {
    const key = (target as { targetKey: string }).targetKey
    const exists = this.files.has(key)
    if (expected?.kind === 'createIfAbsent' && exists) throw Object.assign(new Error('exists'), { code: 'FS_NOT_OBSERVED' })
    if (expected?.kind === 'replaceIfVersion') {
      if (!exists) throw Object.assign(new Error('missing'), { code: 'FS_STALE_VERSION' })
      if (this.versions.get(key) !== expected.version) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
    }
    const before = exists ? (this.files.get(key) as string) : null
    this.files.set(key, content)
    const version = `v${++this.counter}`
    this.versions.set(key, version)
    this.writes.push(key)
    return { operation: exists ? ('update' as const) : ('create' as const), version, before, after: content }
  }
  processPath(target: unknown): string {
    return (target as { targetKey: string }).targetKey
  }
  observe(): void {}
  async workspaceRoot(): Promise<string> {
    return ROOT
  }
}

class FakeIpc {
  connected = true
  pending = 0
  coordinator: ReviewCoordinator | undefined
  decision: ReviewDecision | 'none' = 'none'
  lastParams: ReviewRequestParams | undefined

  async waitForClient(): Promise<boolean> {
    return this.connected
  }

  async request(params: ReviewRequestParams): Promise<{ decision: ReviewDecision; outcome: DecisionHandling }> {
    this.lastParams = params
    const coordinator = this.coordinator
    if (coordinator === undefined) throw new Error('coordinator not wired')
    const decision: ReviewDecision =
      this.decision === 'none'
        ? { requestId: params.requestId, status: 'accept', finalContent: params.after, by: 'user' }
        : this.decision
    const outcome = await coordinator.handleDecision(decision)
    return { decision, outcome }
  }
}

async function setup(options: { decision: ReviewDecision | 'none'; connected?: boolean; beforeDecision?: () => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dpr-coord-'))
  const store = new StagingStore({ dir })
  await store.init()
  const host = new FakeHost()
  const ipc = new FakeIpc()
  ipc.connected = options.connected ?? true
  ipc.decision = options.decision
  const config = normalizeConfig({ stateDir: dir, clientConnectTimeoutMs: 100, approvalTimeoutMs: 2_000, fallback: 'deny' })
  const ctx = {
    fs: {},
    tools: { get: () => undefined, register: () => () => undefined, schemas: () => [] },
    get(name: string) {
      if (name === 'workingDirectory') return { ensure: async () => ROOT }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ROOT }) }
      return undefined
    },
    emit() {},
    on() {
      return () => undefined
    },
  }
  const coordinator = new ReviewCoordinator({
    ctx: ctx as any,
    config,
    store,
    ipc: ipc as any,
    target: new DirectWorkspaceTarget(),
    createHost: () => host,
  })
  ipc.coordinator = coordinator
  return { dir, store, host, ipc, coordinator, config }
}

function execFor(name: string, args: Record<string, unknown>): ToolExecutionView {
  return {
    name,
    callId: 'call-1',
    arguments: args,
    agent: { id: 'agent-1', session: { id: 'session-1', append() {} } } as any,
    signal: new AbortController().signal,
  }
}

test('accept commits the proposed content and returns the tool success value', async () => {
  const { host, coordinator, store } = await setup({ decision: 'none' })
  host.files.set('/ws/src/a.ts', 'a\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const exec = execFor('write', { file_path: 'src/a.ts', content: 'b\n' })
  // The fake IPC needs a decision that references the real request id.
  const original = coordinator.handleDecision.bind(coordinator)
  coordinator.handleDecision = async (decision) => {
    host.files.set('/ws/src/a.ts', 'b\n')
    return original({ ...decision, status: 'accept', finalContent: 'b\n' })
  }
  const result = expectResult(await coordinator.review(exec))
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, {
    path: '/ws/src/a.ts',
    operation: 'update',
    before: 'a\n',
    after: 'b\n',
  })
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0].state, 'committed')
})

test('accept with a user edit writes the edited content and attaches a notice', async () => {
  const { host, coordinator } = await setup({ decision: 'none' })
  host.files.set('/ws/src/a.ts', 'a\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const original = coordinator.handleDecision.bind(coordinator)
  coordinator.handleDecision = async (decision) => original({ ...decision, status: 'accept', finalContent: 'user-version\n' })
  const exec = execFor('write', { file_path: 'src/a.ts', content: 'agent-version\n' })
  const result = expectResult(await coordinator.review(exec))
  assert.equal(result.isError, false)
  assert.equal(host.files.get('/ws/src/a.ts'), 'user-version\n')
  assert.match(coordinator.takeNotice(exec) ?? '', /EDITED the proposal/)
  // Notice is one-shot.
  assert.equal(coordinator.takeNotice(exec), undefined)
})

test('reject returns an error and never writes', async () => {
  const { host, coordinator, store } = await setup({ decision: 'none' })
  host.files.set('/ws/src/a.ts', 'a\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const original = coordinator.handleDecision.bind(coordinator)
  coordinator.handleDecision = async (decision) => original({ ...decision, status: 'reject', reason: 'needs tests' })
  const result = expectResult(await coordinator.review(execFor('write', { file_path: 'src/a.ts', content: 'b\n' })))
  assert.equal(result.isError, true)
  assert.match(result.error?.message ?? '', /rejected/)
  assert.equal(host.writes.length, 0)
  assert.equal((await store.list())[0].state, 'rejected')
})

test('a stale version during commit surfaces as a conflict and does not overwrite', async () => {
  const { host, coordinator } = await setup({ decision: 'none' })
  host.files.set('/ws/src/a.ts', 'a\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const original = coordinator.handleDecision.bind(coordinator)
  coordinator.handleDecision = async (decision) => {
    // Simulate an external write between approval and commit.
    host.files.set('/ws/src/a.ts', 'external\n')
    host.versions.set('/ws/src/a.ts', 'v-ext')
    return original({ ...decision, status: 'accept', finalContent: 'b\n' })
  }
  const result = expectResult(await coordinator.review(execFor('write', { file_path: 'src/a.ts', content: 'b\n' })))
  assert.equal(result.isError, true)
  assert.match(result.error?.message ?? '', /changed while it was being approved/)
  assert.equal(host.files.get('/ws/src/a.ts'), 'external\n')
})

test('no connected client fails closed without writing', async () => {
  const { host, coordinator } = await setup({ decision: 'none', connected: false })
  host.files.set('/ws/src/a.ts', 'a\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const result = expectResult(await coordinator.review(execFor('write', { file_path: 'src/a.ts', content: 'b\n' })))
  assert.equal(result.isError, true)
  assert.match(result.error?.message ?? '', /no review client is connected/)
  assert.equal(host.writes.length, 0)
})

test('passthrough is returned when the proposal cannot be built (ambiguous edit)', async () => {
  const { host, coordinator } = await setup({ decision: 'none' })
  host.files.set('/ws/src/a.ts', 'x\nx\n')
  host.versions.set('/ws/src/a.ts', 'v0')
  const result = await coordinator.review(execFor('edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }))
  assert.deepEqual(result, { passthrough: true })
})

test('non-reviewable tool names are not routed through the coordinator', async () => {
  const { coordinator } = await setup({ decision: 'none' })
  const result = expectResult(await coordinator.review(execFor('bash', { command: 'echo hi' })))
  assert.equal(result.isError, true)
  assert.match(result.error?.message ?? '', /cannot locate the target path/)
})
