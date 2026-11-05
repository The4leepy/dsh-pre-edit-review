/**
 * `CommitTarget` — the only component allowed to write into the user's working
 * copy (see docs/adr/0001-commit-target.md).
 *
 * The staging store, IPC server, protocol, and VS Code extension must never
 * import a concrete target implementation; they only ever see `targetKind`.
 * `GitWorktreeTarget` is a reserved implementation of this same interface.
 */

export type CommitTargetKind = 'direct-workspace' | 'git-worktree'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type ReviewMode = 'tool-level' | 'strict'

/** Immutable snapshot of one file at approval time. Never mutated. */
export interface FileSnapshot {
  /** Path shown to the user (workspace-relative when possible). */
  displayPath: string
  /** Canonical absolute path inside the commit target's root. */
  absolutePath: string
  /** Whether the file existed when the proposal was created. */
  exists: boolean
  isNewFile: boolean
  /** LF-normalised original content; `null` when the file did not exist. */
  content: string | null
  /**
   * Original content exactly as read (line endings preserved). Present when a
   * proposal builder must mirror a tool whose matching is raw, e.g.
   * `str_replace_editor`. Optional so existing snapshots stay valid.
   */
  rawContent?: string | null
  sha256: string | null
  /** Opaque provider version token (`FsVersion`); never interpreted by callers. */
  version: unknown
  lineEndings: 'LF' | 'CRLF'
  mode: ReviewMode
}

export type CommitPrecondition =
  | { kind: 'replaceIfVersion'; version: unknown }
  | { kind: 'createIfAbsent' }

export interface CommitResult {
  ok: true
  operation: 'create' | 'update'
  /** LF-normalised content observed before the write (may be `null`). */
  before: string | null
  /** LF-normalised content after the write (what the model is told landed). */
  after: string
  versionAfter: unknown
}

export type CommitConflictCode = 'FS_STALE_VERSION' | 'FS_NOT_OBSERVED' | 'FS_SANDBOX_DENIED' | 'FS_NOT_TEXT' | 'OUT_OF_SCOPE' | 'UNKNOWN'

export class CommitConflict extends Error {
  readonly code: CommitConflictCode
  constructor(code: CommitConflictCode, message: string) {
    super(message)
    this.name = 'CommitConflict'
    this.code = code
  }
}

/** Read-only observation used for crash reconciliation; never triggers a write. */
export interface InspectResult {
  exists: boolean
  sha256: string | null
  version: unknown
}

/**
 * Minimal structural view of the Host services a target needs. Kept as an
 * interface so the target can be unit-tested without a live Cordis context.
 */
export interface CommitTargetHost {
  /** `ctx.fs.resolve(path, { cwd, signal })` */
  resolve(path: string, options: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  /** `ctx.fs.contains(parent, child)` */
  contains(parent: unknown, child: unknown): boolean
  /** `ctx.fs.stat(target, signal)` */
  stat(target: unknown, signal?: AbortSignal): Promise<{ version: unknown; size?: number } | undefined>
  /** `ctx.fs.readText(target, signal)` */
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  /** `ctx.fs.writeText(target, content, expected, signal, sandboxPolicy)` */
  writeText(
    target: unknown,
    content: string,
    expected: CommitPrecondition | undefined,
    signal: AbortSignal | undefined,
    sandboxPolicy: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string },
  ): Promise<{ operation: 'create' | 'update'; version: unknown; before: string | null; after: string }>
  /** `ctx.fs.processPath(target)` */
  processPath(target: unknown): string
  /** `ctx.emit('fs/observed', target, { kind: 'present', version }, actor)` */
  observe(target: unknown, version: unknown, actor: unknown): void
  /** Absolute root of the session workspace. */
  workspaceRoot(): Promise<string>
}

export interface CommitTarget {
  readonly kind: CommitTargetKind
  /**
   * Resolve the requested path inside the target root and read a snapshot.
   * Read-only: never modifies the working copy. Throws `CommitConflict('OUT_OF_SCOPE')`
   * for paths outside the root.
   */
  prepare(
    host: CommitTargetHost,
    requestedPath: string,
    signal: AbortSignal,
    options?: { mode?: ReviewMode },
  ): Promise<FileSnapshot>
  /** Atomically apply an approved content. Never writes when the precondition fails. */
  commit(
    host: CommitTargetHost,
    snapshot: FileSnapshot,
    finalContent: string,
    precondition: CommitPrecondition,
    signal: AbortSignal,
    actor?: unknown,
  ): Promise<CommitResult>
  /** Read-only comparison used by startup reconciliation. */
  inspect(host: CommitTargetHost, snapshot: FileSnapshot, signal: AbortSignal): Promise<InspectResult>
}
