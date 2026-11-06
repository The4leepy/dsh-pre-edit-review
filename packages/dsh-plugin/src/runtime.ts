/**
 * Runtime assembly: store + IPC server + coordinator + commit target.
 *
 * Construction is synchronous so the gate can be installed immediately; the
 * async initialisation (state directory, socket, Host descriptor, crash
 * reconciliation) is awaited by the first review and exposed as `ready`.
 *
 * Every instance owns one namespace (`<stateDir>/hosts/<hostKey>/`), so two DSH
 * profiles on the same machine can run the plugin side by side (ADR 0002 §3).
 */
import { createActivationRegistry, type ActivationRegistry } from './activation.ts'
import type { LoggerView, HostContext } from './host.ts'
import { IpcServer } from './ipc/server.ts'
import { resolveHostPaths, type HostPaths } from './paths.ts'
import { cleanupLegacyRoot } from './legacy.ts'
import { reconcileStaging } from './recovery.ts'
import { removeHostDescriptor, writeHostDescriptor } from './registry.ts'
import { ReviewCoordinator } from './review-coordinator.ts'
import { StagingStore } from './staging/store.ts'
import { createCommitTarget, createCommitTargetHost } from './targets/index.ts'
import type { PluginConfig } from './config.ts'
import { randomHex, type HostDescriptor } from '../../shared/src/index.ts'

export const PLUGIN_VERSION = '0.3.0'

export interface PluginRuntime {
  config: PluginConfig
  paths: HostPaths
  store: StagingStore
  ipc: IpcServer
  coordinator: ReviewCoordinator
  activation: ActivationRegistry
  ready: Promise<void>
  dispose(): Promise<void>
}

export interface RuntimeOptions {
  /** Emergency stop: when true the client indicator must report review as off. */
  isKilled?: () => boolean
}

export function createRuntime(
  ctx: HostContext,
  config: PluginConfig,
  logger: LoggerView,
  options: RuntimeOptions = {},
): PluginRuntime {
  const paths = resolveHostPaths(config, ctx)
  const store = new StagingStore({ dir: paths.hostDir })
  const activation = createActivationRegistry(config.defaultActive)
  const killed = (): boolean => options.isKilled?.() === true
  let coordinatorRef: ReviewCoordinator | undefined

  const ipc = new IpcServer({
    stateDir: paths.hostDir,
    socketPath: paths.socketPath,
    tokenPath: paths.tokenPath,
    hostKey: paths.hostKey,
    hostLabel: paths.hostLabel,
    serverVersion: PLUGIN_VERSION,
    handleDecision: (decision) => {
      if (coordinatorRef === undefined) {
        return Promise.resolve({ outcome: 'failed' as const, detail: { message: 'review runtime is not ready' } })
      }
      return coordinatorRef.handleDecision(decision)
    },
    onClientChanged: (connected) => {
      logger.info(`[pre-edit-review] review client ${connected ? 'connected' : 'disconnected'}`)
      if (connected) ipc.notifyMode({ paused: killed() || activation.anyInactive() })
    },
    mode: () => killed() || activation.anyInactive(),
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

  const descriptor: HostDescriptor = {
    key: paths.hostKey,
    label: paths.hostLabel,
    pid: process.pid,
    pluginVersion: PLUGIN_VERSION,
    instanceId: randomHex(8),
    startedAt: Date.now(),
    stateDir: paths.hostDir,
    socketPath: paths.socketPath,
    tokenPath: paths.tokenPath,
  }
  // Ownership of `meta.json`: a Host that failed to bind (or never published)
  // must not delete the descriptor of a live Host in the same namespace.
  let descriptorPublished = false

  const ready = (async () => {
    await store.init()
    try {
      const legacy = await cleanupLegacyRoot(paths.root)
      if (legacy.socketRemoved) {
        logger.info(
          `[pre-edit-review] removed a stale 0.2.x root socket/token under ${paths.root}; ` +
            'Hosts now live under hosts/<hostKey>/',
        )
      }
    } catch (error) {
      logger.warn(
        `[pre-edit-review] could not clean up the retired legacy socket: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await ipc.start()
    // Discovery metadata only: failing to publish it must not disable review,
    // but the Host would be invisible to the extension, so make it loud.
    try {
      await writeHostDescriptor(paths.metaPath, descriptor)
      descriptorPublished = true
    } catch (error) {
      logger.warn(
        `[pre-edit-review] could not publish ${paths.metaPath}: ${error instanceof Error ? error.message : String(error)}; ` +
          'the VS Code extension will not discover this Host',
      )
    }
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
    paths,
    store,
    ipc,
    coordinator,
    activation,
    ready,
    dispose: async () => {
      await ipc.stop()
      if (!descriptorPublished) return
      descriptorPublished = false
      await removeHostDescriptor(paths.metaPath, descriptor).catch((error: unknown) => {
        logger.warn(
          `[pre-edit-review] could not remove ${paths.metaPath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    },
  }
}
