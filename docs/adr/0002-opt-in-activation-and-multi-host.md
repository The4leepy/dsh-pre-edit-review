# ADR 0002 — Opt-in review activation and multi-Host coexistence

- Status: accepted
- Date: 2026-11-06
- Supersedes: nothing (ADR 0001 keeps `CommitTarget` unchanged)
- Target release: 0.3.0 (plugin + extension)

## Context

Two product problems surfaced after the first public release:

1. **Review is intrusive by default.** Installing the plugin into a profile means
   every session of that profile is intercepted on `write` / `edit` /
   `str_replace_editor`. The `/review off` pause exists but has to be repeated per
   session and is easy to forget. The user wants review **off unless deliberately
   switched on for the work at hand**.
2. **Two Hosts fight over one state directory.** The `desktop` profile (DSH
   Desktop app) and the `dsh-tui` profile (terminal UI) both install the plugin and
   both default to `~/.dsh/pre-edit-review`. They collide on the Unix socket, the
   token file, the staging records and the audit log. Observed consequences:
   - the later Host overwrites `<stateDir>/token` **before** it tries to bind
     (`packages/dsh-plugin/src/ipc/server.ts#start`), so the first Host's VS Code
     client starts failing auth on its next reconnect;
   - the later Host cannot bind, its `ready` promise rejects permanently, and every
     reviewed write in its process fails closed ("pre-edit review is unavailable");
   - if both ever bind (TOCTOU), the shared staging directory means one Host's
     startup `expirePending()` expires the other Host's live review, and an Accept
     can silently write nothing;
   - a losing Host's `stop()` unlinks the live winner's socket unconditionally.

Both problems are security-adjacent: the first removes the guarantee unless the
user opts in, the second makes the plugin unusable/degraded while looking healthy.

## Decision

### 1. Review is inactive by default, activated per session

- New plugin config field `defaultActive` (boolean), default **`false`** in both
  `src/config.ts` and the shipped `cordis.patch.yml`. Both must agree: the Loader
  replaces an entry's `config` wholesale, so any profile-level override row that
  omits `defaultActive` would otherwise silently re-enable review on upgrade
  (schema fallback `true` did exactly that). Set `true` explicitly to review every
  session by default.
- New `src/activation.ts` replaces `src/pause.ts` (single registry, no double
  negative). It stores **explicit per-session choices only**; absent = `defaultActive`.
  Choices are pruned on `session/disposed` / `agent/disposed` so the aggregate
  client flag cannot stay stale after a session ends (a fresh session must not be
  advertised as reviewed because a previous session had activated it).
  - Session identity is a string: `sessionKeyOf(agent) = String(agent.session?.id ?? agent.id)`
    when either exists, otherwise `undefined`.
  - A tool call with no session identity follows `defaultActive`.
  - Empty key semantics keep the registry cheap and synchronous (gate fast path).
- Gate order becomes: `kill switch → activation.isActive(agent) → classify(…) → …`.
  An inactive session gets `next()` immediately: the tool body runs untouched and
  the gate never touches `ctx.tools.get`, the coordinator, the IPC server or the
  staging store. The kill switch still wins over an active session.
- `/review on` activates the **requesting session**; `/review off` deactivates it.
  Both are user-command only (no tool, IPC method or config write can flip them),
  memory-only (Host restart returns to `defaultActive`), audited as
  `review/activated` / `review/deactivated`, and pushed to the client through the
  existing `review/mode` notification.
- `allowPause: false` now blocks **deactivation** only. `mode: 'off'` (static profile
  policy) blocks activation with an explicit error.
- Subagent / teammate sessions have their own session id and are therefore
  **independent**: activating a parent session does not review its subagents.
  Documented as a known limitation (the old pause had the same per-session scope).
- The model-facing prompt section becomes state-neutral ("when the user has enabled
  pre-edit review for this session …"), because `systemPrompt.section` text only
  receives `{ scope, signal }` and cannot be made per-session.

### 2. Client indicator semantics (`paused` stays on the wire)

`HelloResult.paused` and `ReviewModeParams.paused` keep their name and type for
wire compatibility, but mean **"review is not active for the sessions this Host
knows about"**:

- `defaultActive === true` → `paused = deactivatedCount > 0` (today's meaning);
- `defaultActive === false` → `paused = activeCount === 0`.

The deprecated `bypass` field is still accepted and never sent. `PROTOCOL_VERSION`
stays `1`; only optional, additive fields are added (see §4).

### 3. Per-Host state namespace

```
<stateDir>/                                   root (0700)
├── DISABLED                                  global kill switch (unchanged)
└── hosts/<hostKey>/                          one Host instance (0700)
    ├── ipc.sock                              UDS (0600)
    ├── token                                 per-Host secret (0600, atomic rename)
    ├── meta.json                             HostDescriptor (0600, atomic)
    ├── staging/<requestId>.json              review records (0600)
    └── audit/YYYY-MM.jsonl                   audit (0600)
```

- `hostKey` resolution order: `config.hostKey` → `ctx.get('profileContext').name` →
  `process.env.DSH_PROFILE` → `'default'`; sanitized to `[A-Za-z0-9._-]{1,64}`
  (other characters → `_`, empty → `default`).
- `hostLabel` = `config.hostLabel` → `hostKey`; display only.
- `kill switch` stays **global** at `<stateDir>/DISABLED`: one emergency stop stops
  every Host. This is deliberate; document it.
- An explicitly configured `socketPath` still wins (expert override); the token
  stays at `<hostsDir>/<hostKey>/token` and `meta.json` records the real paths.
  Caveat: the extension rejects descriptors whose socket/token path escapes the
  Host directory, so an expert `socketPath` outside `<hostsDir>/<hostKey>/`
  makes that Host undiscoverable by the 0.3.0 client.
- Every Host writes `meta.json` atomically on start and removes it on clean stop;
  a crashed Host leaves a stale descriptor that the client prunes by pid liveness.
- Two instances of the *same* profile keep the same `hostKey`; the second one fails
  to bind and degrades loudly (see §5) — cross-profile coexistence is the supported
  case.

### 4. Additive protocol fields

`packages/shared/src/host.ts` (new) owns `HostDescriptor` + `isHostDescriptor` +
`HOSTS_DIR_NAME`. Protocol additions (all optional):

- `HelloResult.hostKey?`, `HelloResult.hostLabel?` — who am I talking to.
- `ReviewRequestParams.hostKey?`, `ReviewRequestParams.hostLabel?` — display only.

Older clients ignore unknown fields; a missing `hostKey` means "legacy single-Host
layout at `<stateDir>/ipc.sock`".

### 5. IPC server hardening (must land regardless of multi-Host)

- Bind **before** publishing the token; publish the token atomically
  (temp file `0600` + `rename`).
- Track `bound`; `stop()` unlinks the socket **only if this instance bound it AND
  the path still resolves to the inode it bound**. libuv unlinks the path when a
  listening handle closes, so in-process reloads are additionally serialized by a
  process-wide owner slot: the new runtime binds only after the previous
  runtime's close finished (see `ipc/server.ts`).
- Replace the anonymous bind error with a typed `HostInUseError`
  (`code: 'HOST_IN_USE'`) whose message names the socket and the profile/hostKey.
- Keep the stale-socket reclaim path, but never blindly `unlink` twice: re-probe
  before a second attempt.
- The second Host of the same profile therefore degrades with a clear error instead
  of corrupting the first Host's endpoint or token.

### 6. Extension: one connection per Host

- New `packages/vscode-extension/src/host-registry.ts` (no `vscode` import, unit
  testable): scan `<stateDir>/hosts/*/meta.json`, validate the descriptor and that
  `socketPath` / `tokenPath` stay inside that host directory, probe liveness, and
  also accept the legacy root layout (`<stateDir>/ipc.sock` + `<stateDir>/token`)
  as host key `legacy`.
- `extension.ts` owns `Map<hostKey, ReviewSession>`; a poll (≈2.5 s) reconciles
  discovery with live sessions (connect new, dispose removed, refresh labels).
- Routing: every pending review belongs to exactly one session; Accept/Reject/
  Open/Accept-All/Reject-All resolve the owning session from the request id / URI
  and fall back to "the only session with pending items".
- Aggregate UI: status bar shows connected host count, total pending and the
  "· OFF" suffix only when **every connected Host** reports inactive; tooltip lists
  one line per Host; pending/history rows show the Host label.
- `dpr.stateDir` remains the **root** directory.
- Backward compatibility: new extension + old Host works through the legacy link;
  new Host + old extension is **not** supported (the old client only knows the root
  socket). Document upgrade order: extension first, plugin second (or both).

### 7. Explicit non-goals

- No Host-to-Host relay / owner election (rejected: adds a trusted hop and a SPOF).
- No lazy IPC start in 0.3.0 (keeping the socket up keeps status honest and the
  discovery model simple; revisit if idle sockets become a problem).
- No per-workspace activation (session scope is the product decision for 0.3.0).
- No automatic migration of existing staging/audit records into the new layout;
  the state dir is disposable by design (`scripts/uninstall.sh --purge`), and the
  legacy root is still read for old Hosts.

## Consequences

- **Security documentation changes**: the "tool-level (default)" column of the
  guarantee matrix becomes "tool-level, review activated"; a new first column
  "installed, review inactive (default)" has no review guarantee. `SECURITY.md`
  wording "agents cannot enable **or disable** review" is extended.
  `docs/usage.md` gains the four-state table, `docs/install.md` the "activate first"
  reminder, and `HANDOVER.md` the new architecture/config/commands.
- `HANDOVER.md` invariants gain: "inactive means untouched — no registry lookup
  beyond the session map"; "one Host ↔ one token ↔ one staging namespace".
- Version alignment: plugin 0.3.0 + extension 0.3.0, `PLUGIN_VERSION` in
  `runtime.ts`, `market/index.json` regenerated.
- Tests: activation/gate/config/host-paths/registry/ipc-multi/recovery-isolation
  for the Host; `host-registry` discovery for the extension; self-test extended
  with a two-Host phase.
