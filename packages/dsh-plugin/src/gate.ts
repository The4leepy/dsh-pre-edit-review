/**
 * The `tools/execute` gate.
 *
 * Registered with `{ prepend: true }` so it sees the call before any timeout or
 * metrics wrapper. Returning without calling `next()` means the tool body never
 * runs; every reviewed call must therefore produce a synthetic
 * `ToolExecutionResult` (see ReviewCoordinator).
 */
import { classify } from './classifier.ts'
import type { PluginConfig } from './config.ts'
import type { HostContext, ToolExecutionResultView, ToolExecutionView } from './host.ts'
import { failureResult, type ReviewCoordinator } from './review-coordinator.ts'
import { hasProposalBuilder } from './proposal.ts'

export interface GateDeps {
  ctx: HostContext
  config: PluginConfig
  coordinator: ReviewCoordinator
}

/** Install the gate; returns a disposer. */
export function installGate(deps: GateDeps): () => void {
  const { ctx, config, coordinator } = deps
  return ctx.on(
    'tools/execute',
    async (exec: ToolExecutionView, next: () => Promise<ToolExecutionResultView>) => {
      const definition = ctx.tools.get(exec.name)
      const classification = classify({
        toolName: exec.name,
        args: exec.arguments,
        definition,
        config,
        hasBuilder: hasProposalBuilder,
      })

      if (classification.action === 'pass') return next()
      if (classification.action === 'deny') {
        return failureResult(classification.reason)
      }
      return coordinator.review(exec)
    },
    { prepend: true },
  )
}
