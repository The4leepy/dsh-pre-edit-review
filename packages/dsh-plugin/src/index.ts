/**
 * dsh-pre-edit-review — Host plugin entry.
 *
 * M1 state: the config, classifier, proposal builders, CommitTarget, staging
 * store and IPC server are frozen and unit-tested. The gate and coordinator
 * bodies land in Phase 2 (M2); this entry therefore mounts without intercepting
 * anything until `experimentalGate: true` is explicitly configured.
 */
import { normalizeConfig, type RawPluginConfig } from './config.ts'
import type { HostContext } from './host.ts'

export const name = 'pre-edit-review'

export function apply(ctx: HostContext, rawConfig: RawPluginConfig = {}): void {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
  }

  if (!config.enabled) {
    logger.info('[pre-edit-review] disabled by config')
    return
  }

  logger.info(
    `[pre-edit-review] mounted (mode=${config.mode}, reviewTools=${config.reviewTools.join(',')}, stateDir=${config.stateDir}) — gate lands in Phase 2`,
  )

  // Phase 2 wires: StagingStore.open → IpcServer.start → ReviewCoordinator →
  // installGate → /review commands → systemPrompt section. Until then the
  // module must be inert: never intercept a write with an unimplemented path.
  void ctx
}

export type { RawPluginConfig } from './config.ts'
