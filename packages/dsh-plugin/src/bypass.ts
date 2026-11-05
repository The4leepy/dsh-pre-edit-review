/**
 * Review bypass (放行模式).
 *
 * A user explicitly turns this on for one session (via `/review bypass`). While
 * it is on, the gate lets every file-mutating tool through untouched — the
 * agent edits code without a review request.
 *
 * Deliberate properties:
 * - **user-activated only**: no tool, model action, or IPC message can enable
 *   it; the only write path is the `/review` command handler, which the Host
 *   routes from user input;
 * - **session scoped**: another session keeps reviewing;
 * - **in-memory**: a Host restart clears every bypass (fail safe);
 * - **sandbox unchanged**: bypass skips the review, not the file policy;
 *   `read-only` still denies writes;
 * - audited on every toggle.
 */
export interface BypassRegistry {
  isBypassed(session: object | undefined): boolean
  set(session: object, enabled: boolean): void
  anyActive(): boolean
  activeCount(): number
}

export function createBypassRegistry(): BypassRegistry {
  const sessions = new Set<object>()
  return {
    isBypassed(session: object | undefined): boolean {
      return session !== undefined && sessions.has(session)
    },
    set(session: object, enabled: boolean): void {
      if (enabled) sessions.add(session)
      else sessions.delete(session)
    },
    anyActive(): boolean {
      return sessions.size > 0
    },
    activeCount(): number {
      return sessions.size
    },
  }
}
