/**
 * The `tools/execute` gate.
 *
 * Registered with `{ prepend: true }` so it sees the call before any timeout or
 * metrics wrapper. Returning without calling `next()` means the tool body never
 * runs; every reviewed call therefore produces a synthetic
 * `ToolExecutionResult` (see ReviewCoordinator).
 *
 * Defence in depth against a self-locking plugin (prod incident 2026-11-05):
 * - the kill switch file bypasses the gate entirely;
 * - tool-definition lookup can never throw out of the gate before a decision,
 *   so an unusable service degrades to the name/file policy instead of failing
 *   every tool call;
 * - coordinator errors fail closed but only for the reviewed call.
 */
import { classify } from './classifier.ts'
import type { PluginConfig } from './config.ts'
import type { HostContext, ToolDefinitionView, ToolExecutionResultView, ToolExecutionView } from './host.ts'
import type { BypassRegistry } from './bypass.ts'
import type { KillSwitch } from './kill-switch.ts'
import { failureResult, type ReviewCoordinator, type ReviewResult } from './review-coordinator.ts'
import { hasProposalBuilder } from './proposal.ts'

export interface GateDeps {
  ctx: HostContext
  config: PluginConfig
  coordinator: ReviewCoordinator
  killSwitch: KillSwitch
  bypass: BypassRegistry
}

function isPassthrough(result: ReviewResult): result is { passthrough: true } {
  return 'passthrough' in result
}

/** Safe definition lookup: a broken service must not fail every tool call. */
function lookupDefinition(ctx: HostContext, name: string): ToolDefinitionView | undefined {
  try {
    return ctx.tools.get(name)
  } catch {
    return undefined
  }
}

/** Install the gate; returns a disposer. */
export function installGate(deps: GateDeps): () => void {
  const { ctx, config, coordinator, killSwitch, bypass } = deps
  return ctx.on(
    'tools/execute',
    async (exec: ToolExecutionView, next: () => Promise<ToolExecutionResultView>) => {
      if (killSwitch.active()) return next()
      // User-selected release mode for this session: let the tool write directly.
      if (bypass.isBypassed(exec.agent?.session)) return next()

      let classification
      try {
        classification = classify({
          toolName: exec.name,
          args: exec.arguments,
          definition: lookupDefinition(ctx, exec.name),
          config,
          hasBuilder: hasProposalBuilder,
        })
      } catch (error) {
        // Fail closed only for calls that look like mutations; everything else
        // (including bash, the recovery path) passes through.
        const looksMutating = config.reviewTools.includes(exec.name)
        if (!looksMutating) return next()
        return failureResult(
          `pre-edit review could not classify "${exec.name}" (${error instanceof Error ? error.message : String(error)}); the call was NOT executed`,
        )
      }

      if (classification.action === 'pass') return next()
      if (classification.action === 'deny') return failureResult(classification.reason)
      try {
        const result = await coordinator.review(exec)
        return isPassthrough(result) ? next() : result
      } catch (error) {
        // The coordinator handles its own failures; this is the last-resort
        // fail-closed guard so a bug can never fall through to the tool body.
        return failureResult(
          `pre-edit review failed before dispatch (${error instanceof Error ? error.message : String(error)}); the file was NOT modified`,
        )
      }
    },
    { prepend: true },
  )
}
