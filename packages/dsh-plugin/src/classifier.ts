/**
 * Decide which tool calls enter the pre-edit review.
 *
 * Requirement 4: never rely on tool names alone. The name allowlist is only
 * the first check; tools that declare a diff presentation, or whose names look
 * mutating, are handled explicitly, and unknown mutating tools default to deny.
 * In strict mode the real guarantee comes from the OS sandbox, not this module.
 */
import type { ToolDefinitionView } from './host.ts'
import type { PluginConfig } from './config.ts'

export type Classification =
  | { action: 'review'; toolName: string }
  | { action: 'pass' }
  | { action: 'deny'; toolName: string; reason: string }

export interface ClassifierInput {
  toolName: string
  args: unknown
  definition: ToolDefinitionView | undefined
  config: PluginConfig
  /** Whether a proposal builder exists for the tool; injected for testability. */
  hasBuilder(name: string): boolean
}

function presentsDiff(definition: ToolDefinitionView | undefined, args: unknown): boolean {
  if (definition?.presentCall === undefined) return false
  try {
    const view = definition.presentCall(args) as { card?: unknown } | undefined
    return view?.card === 'diff'
  } catch {
    // A throwing presentation callback must never silently unlock a write.
    return true
  }
}

export function classify(input: ClassifierInput): Classification {
  const { toolName, args, definition, config, hasBuilder } = input
  if (config.enabled !== true || config.mode === 'off') return { action: 'pass' }
  if (config.exemptTools.includes(toolName)) return { action: 'pass' }

  if (config.reviewTools.includes(toolName)) {
    return hasBuilder(toolName)
      ? { action: 'review', toolName }
      : {
          action: 'deny',
          toolName,
          reason: `tool "${toolName}" is configured for pre-edit review but no proposal builder exists`,
        }
  }

  if (presentsDiff(definition, args)) {
    return hasBuilder(toolName)
      ? { action: 'review', toolName }
      : {
          action: 'deny',
          toolName,
          reason: `tool "${toolName}" presents a file diff but has no proposal builder; refusing to run it unreviewed`,
        }
  }

  if (config.mutationNamePatterns.some((pattern) => pattern.test(toolName))) {
    return config.unknownToolPolicy === 'deny'
      ? {
          action: 'deny',
          toolName,
          reason: `tool "${toolName}" looks like a file mutation and is not reviewable; denying by policy`,
        }
      : { action: 'pass' }
  }

  return { action: 'pass' }
}
