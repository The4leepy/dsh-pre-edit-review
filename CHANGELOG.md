# Changelog

All notable changes to **DeepSeek Pre-edit Review** (DSH Host plugin + VS Code extension).

## [Extension 0.3.0 / Plugin 0.3.0] — 2026-11-06 (ADR 0002)

### Changed — review is now opt-in
- **Review is inactive after install.** Installing the plugin no longer intercepts file writes. The
  user runs `/review on` in the session that should be reviewed; `/review off` returns it to the
  default. Both are user-command only, session-scoped, in-memory (a Host restart returns to the
  configured default), and audited (`review/activated` / `review/deactivated`).
- New plugin config keys: `defaultActive` (default `false` in the schema and in the shipped
  bundle, so fresh installs, upgrades and profile config overrides that omit the key all start
  inactive), `hostKey`, `hostLabel`.
- `/review status` now reports the Host key/label, the install default, whether **this session** is
  active, the client connection, pending count, file policy, host directory and socket.
- The model-facing prompt section is now state-neutral ("when the user has enabled pre-edit review
  for this session …") instead of claiming every write is reviewed.
- Extension status-bar indicator: `· OFF` / `· 未启用` while review is inactive (renamed from the
  old pause wording). `allowPause: false` now blocks deactivation only; `mode: 'off'` blocks
  activation.
- Known limitation (documented): subagent/teammate sessions are separate sessions and must be
  activated themselves.

### Added — multiple Hosts can run side by side
- **Per-Host state namespace** (ADR 0002): every Host instance writes
  `<stateDir>/hosts/<hostKey>/{ipc.sock,token,meta.json,staging/,audit/}`. `hostKey` defaults to the
  DSH profile name (`desktop`, `dsh-tui`, …), so the Desktop app and the TUI no longer fight over one
  socket, token, staging directory or audit log. The kill switch
  `<stateDir>/DISABLED` stays global.
- Each Host publishes an atomic `meta.json` (`HostDescriptor`, 0600, never contains the token) so the
  VS Code extension can discover it.
- **The extension connects to every discovered Host** (polling discovery) and keeps one review
  session per Host: the pending queue aggregates all Hosts with the Host label, Accept/Reject is
  routed back to the Host that issued the request, the status bar shows the connected-Host count and
  a per-Host tooltip, and history rows record the Host. The legacy root layout
  (`<stateDir>/ipc.sock` + `token`) is still accepted for 0.2.x Hosts.
- Protocol additions are optional/backward compatible (`hello.result.hostKey/hostLabel`,
  `review/request.hostKey/hostLabel`); `PROTOCOL_VERSION` stays 1.
- Extension self-test extended from 27 to **34 steps** with a two-mock-Host phase (discovery,
  aggregated queue, per-Host routing, Host-labelled diff titles). The committed
  `docs/evidence/ext-selftest.json` is the fresh 0.3.0 run (34/34 in VS Code 1.145).

### Fixed — IPC binding and token races (ADR 0002 §5)
- The IPC server now **binds before publishing the token**, and publishes it atomically
  (temp `0600` + rename). A second Host can no longer overwrite a live Host's token.
- `stop()` only unlinks the socket when this instance bound it — a losing Host can no longer delete
  the winner's endpoint. The same ownership rule now protects `meta.json`: a stopping instance only
  removes a descriptor whose `key`/`pid`/`startedAt` still match its own, so an HMR/restart overlap
  cannot make the newer Host invisible.
- In-process reloads are now safe: libuv unlinks a Unix socket when its listener closes, so a
  process-wide owner slot makes a new runtime bind only after the previous runtime's close finished
  (plus an inode check before `stop()` ever unlinks). A restart/HMR overlap can no longer leave the
  new Host listening on an unlinked socket.
- The kill switch is reflected in the client indicator (`paused` is pushed within ~2 s of arming or
  removing `DISABLED`), and discovery validates descriptor paths with `realpath` so a symlink inside
  a Host directory cannot route the client outside it.
- A 0.3.0 Host removes the retired 0.2.x root `ipc.sock`/`token` on start (only when nothing answers on
  that socket), so the extension stops showing a phantom offline `legacy` Host after an upgrade.
- Activation choices are pruned when a session is disposed (`session/disposed` / `agent/disposed`),
  and the new aggregate state is pushed to the client, so the status bar cannot claim review is on
  while every live session is actually unreviewed.
- macOS shortcuts now avoid `Ctrl`/`Option` entirely: accept is `⌘+Shift+A`, reject is
  `⌘+Shift+Backspace` (`⌘+Alt+A`, `⌘+Alt+Backspace`, `⌘+Ctrl+D`, `Ctrl+Alt+Enter/Backspace` remain as
  fallbacks). On this class of machine the system/IME layer delivers only modifier keydowns for
  `Ctrl`/`Option` chords, so the letter never reaches VS Code. Windows/Linux keep `Ctrl+Alt+A/R`.
- Fixed the startup diff flash: the extension self-test now auto-runs only when the workspace
  contains an explicit `.spike/auto-selftest` marker (a `.spike/` directory alone no longer triggers
  it), and stale `dpr:` editors restored from a previous window are closed on activation.
- Fixed a 0.2.5 regression: the transient-message status-bar item was created nowhere, so every
  info/warning/error message from the plugin was silently dropped. It is now created in `activate()`.
- Binding a socket held by a live Host raises a typed `HOST_IN_USE` error instead of a misleading
  "runtime failed to start" that failed every later write closed.
- Shared staging hazards are gone: `expirePending()`/crash reconciliation only see their own Host's
  records, so one Host can no longer expire another Host's live review.

### Upgrade order
Install/refresh the **VS Code extension first**, then the Host plugin in each profile (or both
together). A 0.2.x extension only knows the legacy root socket and cannot connect to a 0.3.0 Host.

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
