/**
 * Review activation registry (ADR 0002 §1).
 *
 * Review is inactive by default after install; the user turns it on per session
 * with `/review on` and off with `/review off`. The registry stores only the
 * **explicit** per-session choices; a session with no entry follows
 * `defaultActive` (the schema default and the shipped bundle are both `false`).
 *
 * Deliberate properties (same security posture as the 0.2.x pause registry):
 * - **user-command only**: the only write path is the `/review` handler, which
 *   the Host routes from user input; no tool, IPC method or config write can
 *   flip a session;
 * - **session scoped**: another session keeps its own state; subagents have
 *   their own session id and are independent;
 * - **synchronous, memory only**: the gate fast path runs on every tool call,
 *   so this registry does no I/O; a Host restart returns to `defaultActive`;
 * - **sandbox unchanged**: deactivation skips review, not the file policy;
 *   `read-only` still denies writes.
 */
export interface ActivationAgentView {
  id?: unknown
  session?: { id?: unknown } | null | undefined
}

export interface ActivationRegistry {
  /** Whether a session without an explicit choice is reviewed. */
  readonly defaultActive: boolean
  /** Effective state for this agent (explicit choice, else `defaultActive`). */
  isActive(agent: ActivationAgentView | undefined | null): boolean
  /**
   * Record an explicit choice for this agent's session. Returns `false` when
   * the agent carries no session identity (nothing was recorded).
   */
  set(agent: ActivationAgentView | undefined | null, active: boolean): boolean
  /**
   * Drop the explicit choice for this agent's session so it follows
   * `defaultActive` again (session lifecycle cleanup). Returns whether a choice
   * was actually removed.
   */
  forget(agent: ActivationAgentView | undefined | null): boolean
  /**
   * True when review is not active for the sessions this Host knows about:
   * `defaultActive === true` → some session deactivated it;
   * `defaultActive === false` → no session activated it.
   */
  anyInactive(): boolean
  /** Sessions with an explicit active choice. */
  activeCount(): number
  /** Sessions with an explicit inactive choice. */
  inactiveCount(): number
}

/** A non-empty string/number identity, else `undefined`. */
function identityOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * Stable session identity: the session id when present, else the agent id.
 * `undefined` means the call has no session identity and follows the default.
 */
export function sessionKeyOf(agent: ActivationAgentView | undefined | null): string | undefined {
  return identityOf(agent?.session?.id) ?? identityOf(agent?.id)
}

/** Create the in-memory activation registry for one Host instance. */
export function createActivationRegistry(defaultActive: boolean): ActivationRegistry {
  const choices = new Map<string, boolean>()
  return {
    defaultActive,
    isActive(agent: ActivationAgentView | undefined | null): boolean {
      const key = sessionKeyOf(agent)
      if (key === undefined) return defaultActive
      return choices.get(key) ?? defaultActive
    },
    set(agent: ActivationAgentView | undefined | null, active: boolean): boolean {
      const key = sessionKeyOf(agent)
      if (key === undefined) return false
      choices.set(key, active)
      return true
    },
    forget(agent: ActivationAgentView | undefined | null): boolean {
      const key = sessionKeyOf(agent)
      if (key === undefined) return false
      return choices.delete(key)
    },
    anyInactive(): boolean {
      return defaultActive ? this.inactiveCount() > 0 : this.activeCount() === 0
    },
    activeCount(): number {
      let count = 0
      for (const active of choices.values()) if (active) count += 1
      return count
    },
    inactiveCount(): number {
      let count = 0
      for (const active of choices.values()) if (!active) count += 1
      return count
    },
  }
}
