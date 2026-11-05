/**
 * Minimal structural views of the Host services this plugin consumes.
 *
 * The plugin deliberately imports nothing from `@deepseek-ai/*` at runtime, so
 * every Host capability is duck-typed here. Types mirror the inspected
 * contracts of DSH 0.2.1-rc.5 (see docs/evidence).
 */
import type { CommitPrecondition, SandboxMode } from '../../shared/src/index.ts'

export type { SandboxMode }

export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  sessionId?: string
}

export interface FsInfoView {
  version: unknown
  type?: string
  size?: number
}

export interface FsWriteOutcomeView {
  operation: 'create' | 'update'
  version: unknown
  before: string | null
  after: string
}

export interface FsTargetView {
  targetKey: string
  displayPath: string
}

/** `ctx.fs` — the composing provider may be `dsh-fs-sandbox`. */
export interface FsService {
  readonly sandboxMode?: SandboxMode
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetView>
  contains(parent: unknown, child: unknown): boolean
  stat(target: unknown, signal?: AbortSignal): Promise<FsInfoView | undefined>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  writeText(
    target: unknown,
    content: string,
    expected?: CommitPrecondition,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcomeView>
  processPath(target: unknown): string
}

/** `ctx.sandboxPolicy`. */
export interface SandboxPolicyService {
  resolve(request?: { session?: unknown; mode?: SandboxMode }): SandboxExecutionPolicy
}

/** `ctx.workingDirectory`. */
export interface WorkingDirectoryService {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
  get(session: unknown): string
}

export interface ToolSchemaView {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolOutputView {
  schema: unknown
  render(args: unknown, value: unknown): unknown[]
  presentationMeta?(args: unknown, value: unknown): unknown
}

export interface ToolDefinitionView extends ToolSchemaView {
  output: ToolOutputView
  execute?(args: unknown, exec: unknown): Promise<unknown>
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: unknown): unknown
  isConcurrencySafe?(args: unknown): boolean
}

/** `ctx.tools`. */
export interface ToolsService {
  get(name: string, scope?: unknown): ToolDefinitionView | undefined
  register(definition: ToolDefinitionView): () => void
  schemas(scope?: unknown): ToolSchemaView[]
}

export interface ApprovalService {
  request(request: {
    agent?: unknown
    toolName: string
    callId: string
    reason?: string
    displayReason?: Record<string, string>
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

export interface CommandInvocationView {
  commandId?: string
  agent?: unknown
  rawInput: string
  signal?: AbortSignal
}

export type CommandResultView = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

export interface CommandsService {
  register(definition: {
    name: string
    description: string
    input?: { hint: string; attachments?: boolean }
    handler(invocation: CommandInvocationView): CommandResultView | Promise<CommandResultView>
  }): () => void
}

export interface SystemPromptService {
  section(section: { name: string; order?: number; text: string | ((context: { scope?: unknown }) => string) }): () => void
  getSectionOrder(name: string): number
}

export interface PermissionPresetsService {
  set(session: unknown, name: string): void
  current(session: unknown): string
}

export interface LoggerView {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug?(message: string): void
}

export interface AgentSessionView {
  id: string
  header?: { cwd?: string }
  append(type: string, data?: unknown): void
}

export interface AgentView {
  id: string
  session?: AgentSessionView
}

/** The subset of the Cordis context the plugin uses. */
export interface HostContext {
  fs: FsService
  tools: ToolsService
  get(name: string): unknown
  emit(event: string, ...args: unknown[]): void
  on(event: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): () => void
  inject?(services: string[], callback: (ctx: any) => void): void
  effect?(callback: () => (() => void) | void, label?: string): unknown
  logger?: LoggerView
}

/** `exec` argument of a `tools/execute` listener. */
export interface ToolExecutionView {
  name: string
  callId: string
  arguments: unknown
  agent?: AgentView
  signal: AbortSignal
  parent?: unknown
}

export interface ToolExecutionResultView {
  isError: boolean
  value?: unknown
  content?: unknown[]
  error?: { message: string; info?: unknown }
  additionalContexts?: unknown[]
}
