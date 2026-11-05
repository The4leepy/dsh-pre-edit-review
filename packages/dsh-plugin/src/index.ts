/**
 * dsh-pre-edit-review — Host plugin entry.
 *
 * Mounts the review gate, the `/review` command, the model-facing prompt
 * section, and the one-shot post-execute notice for user-edited proposals.
 * The only write path is the CommitTarget used by ReviewCoordinator.
 *
 * Hard requirement: this plugin must never be able to brick the profile. It
 * declares `inject`, verifies the Host capabilities it needs before installing
 * the gate, and honours an emergency kill-switch file.
 */
import { normalizeConfig, type RawPluginConfig } from './config.ts'
import type { CommandResultView, HostContext, LoggerView } from './host.ts'
import { installGate } from './gate.ts'
import { createKillSwitch } from './kill-switch.ts'
import { createRuntime, PLUGIN_VERSION, type PluginRuntime } from './runtime.ts'
import { formatHistory, readAuditHistory } from './history.ts'
import type { ReviewCoordinator } from './review-coordinator.ts'

export const name = 'pre-edit-review'
/** Cordis services this plugin reads. Missing them keeps the plugin inert. */
export const inject = ['fs', 'tools']
export { PLUGIN_VERSION }

const PROMPT_SECTION = `File changes are reviewed before they are written. Call write/edit normally; the user reviews each change as an editable diff in VS Code and may accept it, edit it, or reject it.

- If a change is rejected, the file was NOT modified: ask what should change before proposing again.
- If the file changed while it was being reviewed, the approved change is NOT written: re-read the file and propose again against the current content.
- Do not try to bypass the review (no shell redirection, script, or indirect write) to make a change land.
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

  let runtime: PluginRuntime
  try {
    runtime = createRuntime(ctx, config, logger)
  } catch (error) {
    logger.error(`[pre-edit-review] failed to assemble runtime: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const killSwitch = createKillSwitch(config.stateDir)
  const disposers: Array<() => void> = []
  disposers.push(installGate({ ctx, config, coordinator: runtime.coordinator, killSwitch }))
  disposers.push(installPostExecuteNotice(ctx, runtime.coordinator))
  installCommands(ctx, runtime, logger)
  installPromptSection(ctx)

  logger.info(
    `[pre-edit-review] mounted v${PLUGIN_VERSION} (mode=${config.mode}, reviewTools=${config.reviewTools.join(',')}, ` +
      `socket=${config.socketPath}, killSwitch=${killSwitch.path})`,
  )
  if (killSwitch.active()) {
    logger.warn(`[pre-edit-review] kill switch is ACTIVE (${killSwitch.path}); every review is bypassed until it is removed`)
  }

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

/** `/review` — status, on/off, strict/balanced. */
function installCommands(ctx: HostContext, runtime: PluginRuntime, logger: LoggerView): void {
  if (ctx.inject === undefined) return
  ctx.inject(['commands'], (sub: any) => {
    sub.commands.register({
      name: 'review',
      description: 'Pre-edit review status; switch it on/off or between strict and balanced file policy',
      input: { hint: '[status|on|off|strict|balanced|history [n]]' },
      handler: async (invocation: any): Promise<CommandResultView> => {
        const raw = String(invocation?.rawInput ?? '').trim().toLowerCase()
        const config = runtime.config
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

        if (raw === 'on') {
          config.enabled = true
          return { kind: 'success', text: 'Pre-edit review: ON' }
        }
        if (raw === 'off') {
          config.enabled = false
          return { kind: 'success', text: 'Pre-edit review: OFF (writes are no longer reviewed in this profile session)' }
        }
        if (raw === 'strict') return switchPreset('read-only')
        if (raw === 'balanced') return switchPreset('workspace-write')
        if (raw === 'history' || raw.startsWith('history ')) {
          const requested = Number(raw.slice('history'.length).trim())
          const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 50) : 10
          const entries = await readAuditHistory(config.stateDir, limit)
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
          const lines = [
            `Pre-edit review: ${config.enabled ? 'ON' : 'OFF'} (mode=${status.mode})`,
            `review client: ${status.connected ? 'connected' : 'NOT connected'}`,
            `pending reviews: ${status.pending}`,
            `file policy: ${sandboxMode} ${
              strict ? '(strict: ALL writes require approval)' : '(tool-level: shell writes are NOT reviewed)'
            }`,
            `state dir: ${status.stateDir}`,
            `socket: ${status.socketPath}`,
          ]
          if (!strict) lines.push('tip: /review strict switches this session to read-only, the only mode that cannot be bypassed.')
          return { kind: 'success', text: lines.join('\n') }
        }
        return { kind: 'error', text: `unknown /review argument "${raw}" (use status|on|off|strict|balanced|history [n])` }
      },
    })
    logger.info('[pre-edit-review] /review command registered')
  })
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
