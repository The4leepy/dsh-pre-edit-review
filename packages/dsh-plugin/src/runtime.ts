/**
 * Runtime assembly: store + IPC server + coordinator + commit target.
 *
 * Construction is synchronous so the gate can be installed immediately; the
 * async initialisation (state directory, socket, crash reconciliation) is
 * awaited by the first review and exposed as `ready`.
 */
import type { LoggerView, HostContext } from './host.ts'
import { createBypassRegistry, type BypassRegistry } from './bypass.ts'
import { IpcServer } from './ipc/server.ts'
import { reconcileStaging } from './recovery.ts'
import { ReviewCoordinator } from './review-coordinator.ts'
import { StagingStore } from './staging/store.ts'
import { createCommitTarget, createCommitTargetHost } from './targets/index.ts'
import type { PluginConfig } from './config.ts'

export const PLUGIN_VERSION = '0.1.0'

export interface PluginRuntime {
  config: PluginConfig
  store: StagingStore
  ipc: IpcServer
  coordinator: ReviewCoordinator
  bypass: BypassRegistry
  ready: Promise<void>
  dispose(): Promise<void>
}

export function createRuntime(ctx: HostContext, config: PluginConfig, logger: LoggerView): PluginRuntime {
  const store = new StagingStore({ dir: config.stateDir })
  const bypass = createBypassRegistry()
  let coordinatorRef: ReviewCoordinator | undefined

  const ipc = new IpcServer({
    stateDir: config.stateDir,
    socketPath: config.socketPath,
    serverVersion: PLUGIN_VERSION,
    handleDecision: (decision) => {
      if (coordinatorRef === undefined) {
        return Promise.resolve({ outcome: 'failed' as const, detail: { message: 'review runtime is not ready' } })
      }
      return coordinatorRef.handleDecision(decision)
    },
    onClientChanged: (connected) => {
      logger.info(`[pre-edit-review] review client ${connected ? 'connected' : 'disconnected'}`)
      if (connected) ipc.notifyMode({ bypass: bypass.anyActive() })
    },
    mode: () => bypass.anyActive(),
  })

  const target = createCommitTarget('direct-workspace')
  const coordinator = new ReviewCoordinator({
    ctx,
    config,
    store,
    ipc,
    target,
    createHost: (cwd) => createCommitTargetHost(ctx, cwd),
  })
  coordinatorRef = coordinator

  const ready = (async () => {
    await store.init()
    await ipc.start()
    const expired = await store.expirePending()
    if (expired.length > 0) {
      logger.warn(`[pre-edit-review] marked ${expired.length} pending review(s) expired after restart; nothing was committed`)
    }
    try {
      const counts = await reconcileStaging(
        store,
        target,
        createCommitTargetHost(ctx, process.cwd()),
        new AbortController().signal,
      )
      if (counts.committed > 0 || counts.conflict > 0) {
        logger.warn(
          `[pre-edit-review] crash reconciliation: ${counts.committed} accepted review(s) had already landed, ` +
            `${counts.conflict} conflicted; nothing was re-committed`,
        )
      }
    } catch (error) {
      logger.error(`[pre-edit-review] crash reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  coordinator.setReady(ready)
  ready.catch((error: unknown) => {
    logger.error(`[pre-edit-review] runtime failed to start: ${error instanceof Error ? error.message : String(error)}`)
  })

  return {
    config,
    store,
    ipc,
    coordinator,
    bypass,
    ready,
    dispose: async () => {
      await ipc.stop()
    },
  }
}
