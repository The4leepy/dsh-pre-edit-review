/**
 * Review pause (暂停审批) — the single user-facing "skip review" switch.
 *
 * `/review off` pauses review for one session; `/review on` resumes it. While
 * paused the gate lets every file-mutating tool through untouched.
 *
 * Deliberate properties:
 * - **user-activated only**: no tool, model action, or IPC message can pause;
 *   the only write path is the `/review` command handler, which the Host routes
 *   from user input;
 * - **session scoped**: another session keeps reviewing;
 * - **visible**: the Host pushes the state to VS Code, which shows `· OFF`;
 * - **audited**: every toggle appends one audit line;
 * - **in-memory**: a Host restart clears it (fail safe);
 * - **sandbox unchanged**: pausing skips the review, not the file policy;
 *   `read-only` still denies writes.
 */
export interface PauseRegistry {
  isPaused(session: object | undefined): boolean
  set(session: object, paused: boolean): void
  anyPaused(): boolean
  activeCount(): number
}

export function createPauseRegistry(): PauseRegistry {
  const sessions = new Set<object>()
  return {
    isPaused(session: object | undefined): boolean {
      return session !== undefined && sessions.has(session)
    },
    set(session: object, paused: boolean): void {
      if (paused) sessions.add(session)
      else sessions.delete(session)
    },
    anyPaused(): boolean {
      return sessions.size > 0
    },
    activeCount(): number {
      return sessions.size
    },
  }
}
