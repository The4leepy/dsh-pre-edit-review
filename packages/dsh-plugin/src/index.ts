/**
 * dsh-pre-edit-review — Host plugin entry.
 *
 * Mounts the review gate, the `/review` command, the model-facing prompt
 * section, and the one-shot post-execute notice for user-edited proposals.
 * The only write path is the CommitTarget used by ReviewCoordinator.
 *
 * Hard requirement: this plugin must never be able to brick the profile. It
 * declares `inject`, verifies the Host capabilities it needs before installing
 * the gate, and honours an emergency kill-switch file. Review is opt-in per
 * session (ADR 0002): an inactive session is never touched by the gate.
 */
import { sessionKeyOf } from './activation.ts'
import { normalizeConfig, type RawPluginConfig } from './config.ts'
import type { CommandResultView, HostContext, LoggerView } from './host.ts'
import { installGate } from './gate.ts'
import { createKillSwitch, type KillSwitch } from './kill-switch.ts'
import { createRuntime, PLUGIN_VERSION, type PluginRuntime } from './runtime.ts'
import { formatHistory, readAuditHistory } from './history.ts'
import type { ReviewCoordinator } from './review-coordinator.ts'

export const name = 'pre-edit-review'
/** Cordis services this plugin reads. Missing them keeps the plugin inert. */
export const inject = ['fs', 'tools']
export { PLUGIN_VERSION }

const PROMPT_SECTION = `Pre-edit review may be enabled for this session. When the user has enabled it, file changes are reviewed before they are written: call write/edit normally; the user reviews each change as an editable diff in VS Code and may accept it, edit it, or reject it.

- Review state is per session, so do not assume a call is reviewed. Do not try to enable or disable review yourself; only the user can do that with the /review command.
- If a change is rejected, the file was NOT modified: ask what should change before proposing again.
- If the file changed while it was being reviewed, the approved change is NOT written: re-read the file and propose again against the current content.
- If review is enabled, do not try to bypass it (no shell redirection, script, or indirect write) to make a change land.
- If the user edited your proposal before accepting, re-read the file before your next change; the user's version is what landed.`

/**
 * Probe the Host services the gate needs. Returns a human-readable reason when
 * the plugin must stay inert instead of installing a gate it cannot serve.
 * Exported for unit tests.
 */
export function checkHostCapabilities(ctx: HostContext): string | undefined {
  try {
    const fs = ctx.fs
    if (typeof fs?.resolve !== 'function' || typeof fs?.readText !== 'function' || typeof fs?.writeText !== 'function') {
      return 'the filesystem service (ctx.fs) is not usable'
    }
    const tools = ctx.tools
    if (typeof tools?.get !== 'function' || typeof tools?.register !== 'function') {
      return 'the tool registry (ctx.tools) is not usable'
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function apply(ctx: HostContext, rawConfig: RawPluginConfig = {}): void {
  const logger: LoggerView = ctx.logger ?? {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
  }

  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    logger.error(`[pre-edit-review] invalid config: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!config.enabled) {
    logger.info('[pre-edit-review] disabled by config')
    return
  }

  const capabilityProblem = checkHostCapabilities(ctx)
  if (capabilityProblem !== undefined) {
    logger.error(
      `[pre-edit-review] NOT mounting the review gate: ${capabilityProblem}. ` +
        'The plugin stays inert so tool calls keep working; fix the composition and reinstall.',
    )
    return
  }

  const killSwitch = createKillSwitch(config.stateDir)
  let runtime: PluginRuntime
  try {
    runtime = createRuntime(ctx, config, logger, { isKilled: () => killSwitch.active() })
  } catch (error) {
    logger.error(`[pre-edit-review] failed to assemble runtime: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const disposers: Array<() => void> = []
  disposers.push(installGate({ ctx, config, coordinator: runtime.coordinator, killSwitch, activation: runtime.activation }))
  disposers.push(installPostExecuteNotice(ctx, runtime.coordinator))
  disposers.push(installSessionLifecycleRefresh(ctx, runtime, killSwitch))
  installCommands(ctx, runtime, killSwitch, logger)
  installPromptSection(ctx)

  logger.info(
    `[pre-edit-review] mounted v${PLUGIN_VERSION} (host=${runtime.paths.hostKey}, mode=${config.mode}, ` +
      `defaultActive=${config.defaultActive}, reviewTools=${config.reviewTools.join(',')}, ` +
      `hostDir=${runtime.paths.hostDir}, socket=${runtime.paths.socketPath}, killSwitch=${killSwitch.path})`,
  )
  if (!config.defaultActive) {
    logger.info('[pre-edit-review] review is INACTIVE by default; a session opts in with /review on')
  }
  if (runtime.paths.hostKey === 'default') {
    logger.warn(
      '[pre-edit-review] could not derive a Host key from profileContext/DSH_PROFILE; using "default". ' +
        'Two profiles will collide on the same namespace — set hostKey in the plugin config or run a DSH version that exposes profileContext.',
    )
  }
  if (killSwitch.active()) {
    logger.warn(`[pre-edit-review] kill switch is ACTIVE (${killSwitch.path}); every review is bypassed until it is removed`)
  }

  // The kill switch is a file, so nothing notifies us when it changes; poll it
  // and push the aggregate "review off" flag so the VS Code indicator stays
  // truthful (ADR 0002: the state must stay observable).
  let lastKilled = killSwitch.active()
  const killWatch = setInterval(() => {
    const killed = killSwitch.active()
    if (killed === lastKilled) return
    lastKilled = killed
    try {
      runtime.ipc.notifyMode({ paused: killed || runtime.activation.anyInactive() })
    } catch {
      // the client indicator must never break the Host
    }
  }, 2_000)
  killWatch.unref?.()
  disposers.push(() => clearInterval(killWatch))

  const dispose = (): void => {
    for (const disposeOne of disposers.splice(0)) {
      try {
        disposeOne()
      } catch {
        // disposal must not throw during teardown
      }
    }
    void runtime.dispose()
  }

  if (ctx.effect !== undefined) {
    ctx.effect(() => dispose, 'pre-edit-review teardown')
  }
}

/**
 * Append the "the user edited your proposal" notice to the tool result content.
 * Runs after every other post-execute policy so it observes the final decision.
 */
function installPostExecuteNotice(ctx: HostContext, coordinator: ReviewCoordinator): () => void {
  return ctx.on(
    'tools/post-execute',
    async (exec: any, result: any, next: () => Promise<any>) => {
      const decision = await next()
      const notice = coordinator.takeNotice(exec)
      if (notice === undefined || decision?.kind !== 'accept') return decision
      const base = Array.isArray(decision.content) ? decision.content : Array.isArray(result?.content) ? result.content : []
      return { ...decision, content: [...base, { type: 'text', text: notice }] }
    },
    { prepend: false },
  )
}

/** `/review` — status, activation on/off, strict/balanced, history. */
function installCommands(ctx: HostContext, runtime: PluginRuntime, killSwitch: KillSwitch, logger: LoggerView): void {
  if (ctx.inject === undefined) return
  ctx.inject(['commands'], (sub: any) => {
    sub.commands.register({
      name: 'review',
      description:
        'Pre-edit review status; enable/disable review for this session, switch the file policy, or show history',
      input: { hint: '[status|on|off|strict|balanced|history [n]]' },
      handler: async (invocation: any): Promise<CommandResultView> => {
        const raw = String(invocation?.rawInput ?? '').trim().toLowerCase()
        const config = runtime.config
        const paths = runtime.paths
        const agent = invocation?.agent

        const switchPreset = (name: string): CommandResultView => {
          const permission = ctx.get('permissionPresets') as
            | { set(session: unknown, preset: string): void }
            | undefined
          if (permission === undefined || agent?.session === undefined) {
            return { kind: 'error', text: 'permission presets are not available in this composition' }
          }
          try {
            permission.set(agent.session, name)
            return { kind: 'success', text: `Pre-edit review: switched file policy to ${name}` }
          } catch (error) {
            return {
              kind: 'error',
              text: `could not switch to ${name}: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        }

        /** Enable or disable review for the requesting session. */
        const setActivation = async (active: boolean): Promise<CommandResultView> => {
          const key = sessionKeyOf(agent)
          if (key === undefined) {
            return { kind: 'error', text: 'pre-edit review activation needs an agent session' }
          }
          if (!active && !config.allowPause) {
            return { kind: 'error', text: 'pre-edit review deactivation is disabled by configuration (allowPause: false)' }
          }
          if (active && config.mode === 'off') {
            return {
              kind: 'error',
              text:
                'pre-edit review is disabled by the profile configuration (mode: "off"), so /review on cannot enable it. ' +
                'Set mode: review in the plugin config and restart the Host.',
            }
          }
          const was = runtime.activation.isActive(agent)
          if (!runtime.activation.set(agent, active)) {
            return { kind: 'error', text: 'pre-edit review could not identify this session' }
          }
          runtime.ipc.notifyMode({ paused: killSwitch.active() || runtime.activation.anyInactive() })
          if (was !== active) {
            try {
              await runtime.store.audit({
                event: active ? 'review/activated' : 'review/deactivated',
                sessionId: key,
              })
            } catch (error) {
              logger.warn(
                `[pre-edit-review] could not write the activation audit line: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
          if (active) {
            return {
              kind: 'success',
              text:
                'Pre-edit review: ACTIVE for this session — file writes are reviewed before they are written.\n' +
                '已为本会话开启修改前审阅：文件修改会先提交审批，同意后才写入。',
            }
          }
          return {
            kind: 'success',
            text:
              'Pre-edit review: INACTIVE for this session — the agent writes files directly, without a review request. ' +
              'The sandbox policy is unchanged (read-only still denies writes). Run /review on to enable review again.\n' +
              '已关闭本会话的修改前审阅：文件修改将直接执行、不再弹出审批；文件策略不变。输入 /review on 重新开启。',
          }
        }

        if (raw === 'on') return await setActivation(true)
        if (raw === 'off') return await setActivation(false)
        if (raw === 'strict') return switchPreset('read-only')
        if (raw === 'balanced') return switchPreset('workspace-write')
        if (raw === 'history' || raw.startsWith('history ')) {
          const requested = Number(raw.slice('history'.length).trim())
          const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 50) : 10
          const entries = await readAuditHistory(paths.auditDir, limit)
          return { kind: 'success', text: formatHistory(entries, limit) }
        }
        if (raw === '' || raw === 'status') {
          const status = runtime.coordinator.status()
          const policy = ctx.get('sandboxPolicy') as
            | { resolve(request?: { session?: unknown }): { mode: string } }
            | undefined
          let sandboxMode = 'unknown'
          try {
            sandboxMode =
              policy?.resolve({ ...(agent?.session !== undefined ? { session: agent.session } : {}) }).mode ?? 'unknown'
          } catch {
            sandboxMode = 'unknown'
          }
          const strict = sandboxMode === 'read-only'
          const sessionActive = runtime.activation.isActive(agent)
          const hostLine = paths.hostLabel === paths.hostKey ? paths.hostKey : `${paths.hostKey} (${paths.hostLabel})`
          const lines = [
            `Pre-edit review: v${PLUGIN_VERSION} (mode=${status.mode})`,
            `host: ${hostLine}`,
            `install default: ${config.defaultActive ? 'active' : 'inactive'}`,
            `this session: ${sessionActive ? 'ACTIVE — writes are reviewed before they are written' : 'INACTIVE — writes go through without review'}`,
            `review client: ${status.connected ? 'connected' : 'NOT connected'}`,
            `pending reviews: ${status.pending}`,
            `file policy: ${sandboxMode} ${
              strict ? '(strict: ALL writes require approval)' : '(tool-level: shell writes are NOT reviewed)'
            }`,
            `host dir: ${paths.hostDir}`,
            `socket: ${paths.socketPath}`,
            `kill switch: ${
              killSwitch.active() ? `ACTIVE (${killSwitch.path}) — every review is bypassed` : 'not active'
            }`,
          ]
          if (!strict) lines.push('tip: /review strict switches this session to read-only, the only mode that cannot be bypassed.')
          if (!sessionActive && config.mode !== 'off') lines.push('tip: /review on enables review for this session.')
          return { kind: 'success', text: lines.join('\n') }
        }
        return {
          kind: 'error',
          text: `unknown /review argument "${raw}" (use status|on|off|strict|balanced|history [n])`,
        }
      },
    })
    logger.info('[pre-edit-review] /review command registered')
  })
}

/** Payload shapes of the DSH lifecycle events we prune activation choices from. */
interface LifecyclePayloadView {
  agent?: { id?: unknown; session?: { id?: unknown } | null } | null
  session?: { id?: unknown } | null
  id?: unknown
}

/**
 * Keep the client-facing "review inactive" flag truthful when sessions end.
 *
 * The activation registry only holds explicit per-session choices, so without
 * pruning a finished session would keep the Host's aggregate state (and the VS
 * Code indicator) stale: e.g. session A runs `/review on`, A ends, a fresh
 * session B is not reviewed, yet the indicator would still claim review is on.
 * DSH emits `session/disposed` and `agent/disposed`; both payloads carry an
 * object `sessionKeyOf` understands. When pruning flips the aggregate state we
 * push it to the client. Lifecycle cleanup must never throw into the Host.
 */
function installSessionLifecycleRefresh(ctx: HostContext, runtime: PluginRuntime, killSwitch: KillSwitch): () => void {
  const disposers: Array<() => void> = []
  const refresh = (candidate: LifecyclePayloadView | undefined): void => {
    try {
      const was = runtime.activation.anyInactive()
      const removed = runtime.activation.forget(candidate)
      if (!removed) return
      const now = runtime.activation.anyInactive()
      if (now !== was) runtime.ipc.notifyMode({ paused: killSwitch.active() || now })
    } catch {
      // never let session teardown fail through the plugin
    }
  }
  const listeners: Array<[string, (payload: unknown) => LifecyclePayloadView | undefined]> = [
    ['session/disposed', (payload) => (payload ?? undefined) as LifecyclePayloadView | undefined],
    ['agent/disposed', (payload) => ((payload as LifecyclePayloadView | undefined)?.agent ?? payload ?? undefined) as
      | LifecyclePayloadView
      | undefined],
  ]
  for (const [event, select] of listeners) {
    try {
      disposers.push(ctx.on(event, (payload: unknown) => refresh(select(payload))))
    } catch {
      // older/different Host composition: the indicator simply stays aggregate
    }
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // teardown must not throw
      }
    }
  }
}

/** Tell the model how review behaves; keeps it from refusing work under read-only policy. */
function installPromptSection(ctx: HostContext): void {
  if (ctx.inject === undefined) return
  ctx.inject(['systemPrompt'], (sub: any) => {
    sub.systemPrompt.section({
      name: 'pre-edit-review',
      order: 900,
      text: PROMPT_SECTION,
    })
  })
}
