# Changelog

All notable changes to **DeepSeek Pre-edit Review** (DSH Host plugin + VS Code extension).

## [Extension 0.2.5] — 2026-11-05 (message UX)

### Changed
- **All transient plugin messages now appear in the bottom-right status bar for exactly 5 s** (`dpr.messageDurationMs`, 1000–30000, default 5000) instead of VS Code native notification toasts, whose lifetime is fixed by VS Code and cannot be changed by an extension.
- Warning/error messages use yellow/red status-bar backgrounds; every message is also appended to the **DeepSeek Pre-edit Review** output channel.
- `dpr.useNativeNotifications` (default false) restores native notifications if preferred.
- Empty Pending/History views now show persistent `viewsWelcome` guidance, so the 5 s hint is no longer the only way to learn the ✓/✗ entry points.
- Interactive dialogs (Accept All confirmation, Clear History confirmation, reject-reason input) are unchanged and never auto-dismiss.
- This release builds on 0.2.4 (pause refactor); it also corrects an accidental version downgrade to 0.2.2 in the build metadata.

## [Extension 0.2.4] — 2026-11-05 (user-driven)

- Review bypass was unified into `/review off` (pause) semantics: the session-scoped pause is user-activated, in-memory, audited, and does not change the sandbox; the plugin sends `paused` (legacy `bypass` still accepted) and the extension shows `· 已关闭 / · OFF`.

## [Extension 0.2.3] — 2026-11-05 (user-driven)

- Reliable Accept/Reject shortcuts: keybindings now match the extension's own context keys.

## [Extension 0.2.5 / Plugin 0.2.1] — 2026-11-05 (interaction-test follow-ups)

### Changed
- Extension: decision result messages now appear in the status bar for exactly 5 seconds instead of transient notifications (0.2.2), and the accidental version downgrade was corrected (0.2.5).
- **Review pause replaces review bypass**: `/review off` pauses review for the current session, `/review on` resumes it;
  the previous `/review bypass` command and `allowBypass` config key remain accepted as deprecated aliases.
  Protocol payloads accept both `paused` and legacy `bypass`.
- Keybindings fixed and expanded: `Ctrl+Alt+A` accept / `Ctrl+Alt+R` reject (plus the legacy `Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace`).

### Fixed
- Keybindings no longer depend on `resourceScheme == 'dpr'`; they use the extension's own context keys so they work inside the diff editor and avoid other extensions' bindings (0.2.2/0.2.3).

## [Extension 0.2.1] — 2026-11-05 (M3.1)

## [Extension 0.2.1 / Plugin 0.2.0] — 2026-11-05 (Phase 4)

### Added
- **Crash reconciliation**: on startup, `decided` records are compared read-only against the file's SHA-256; landed writes become `committed`, mismatches `conflict`, `pending` records `expired`. Never re-commits.
- **Security hardening**: decisions must carry the pending request's nonce (forged decisions rejected and the request stays pending); 8 MiB NDJSON frame cap.
- **Review bypass (放行模式)**: user-only `/review bypass [on|off]`; session-scoped, in-memory, audited, sandbox unchanged; extension shows `· 放行` in the status bar.
- `docs/security.md` threat model and guarantee matrix.
- `packages/spikes/sandbox-probe` strict-mode verification probe.

### Fixed
- `ReviewRecord` records `workspaceRoot` for recovery; old records stay valid.

## [Extension 0.2.0 / Plugin 0.1.0] — 2026-11-05 (Phase 3)

### Added
- **`str_replace_editor` review support**: `create` / `str_replace` (raw-byte unique match) / `insert`; `view` and doomed preconditions pass through to the real tool.
- **Pending / History tree views** in the activity bar with badge count, inline accept/reject, view-title Accept All / Reject All / Clear History.
- **Decision history** persisted in `workspaceState` (last 50, deduped, corrupt-tolerant).
- `/review history [n]` reads the audit JSONL.
- Extension self-test extended to 27 steps.

## [Extension 0.1.2] — 2026-11-05 (M2.2 UX, user-driven)

- Single decision entry point: editor-title ✓/✗ buttons; status bar keeps one highlighted pending indicator.
- Once-per-VS-Code-session onboarding hint; no per-request toast.

## [Extension 0.1.1] — 2026-11-05 (M2.1 UX)

- Persistent Accept/Reject affordances (later consolidated into 0.1.2).

## [Extension 0.1.0 / Plugin 0.1.0] — 2026-11-05 (Phase 2, M2)

### Added
- Host gate on `tools/execute`: file-mutating tools are short-circuited and reviewed before any write.
- `CommitTarget` abstraction (`DirectWorkspaceTarget`; `GitWorktreeTarget` reserved) with CAS commit, atomic write, realpath containment, `fs/observed` bookkeeping.
- Staging store (`~/.dsh/pre-edit-review`, 0600), audit JSONL, crash-safe pending records.
- UDS + JSON-RPC 1.0 client/server with token handshake, timeout/disconnect cancellation.
- VS Code client: editable `dpr:` diff, Accept/Reject, queue, status bar, keybindings, zh/en i18n, in-process self-test.
- `/review` command (status/on/off/strict/balanced), model-facing prompt section, user-edit notice.

## [Phase 1.5, M1] — 2026-11-05

- Feasibility spikes S1/S2/S3 (see `docs/spike-s1.md`, `spike-s2.md`, `spike-s3.md`): `tools/execute` short-circuit, editable VS Code diff, read-only sandbox + CAS commit.
- Frozen interfaces in `packages/shared`; ADR 0001 for `CommitTarget`.
