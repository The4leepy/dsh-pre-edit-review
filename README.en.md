# Pre-edit Review for DeepSeek Harness

<!-- badges -->
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/The4leepy.deepseek-pre-edit-review?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=The4leepy.deepseek-pre-edit-review) [![CI](https://github.com/The4leepy/dsh-pre-edit-review/actions/workflows/ci.yml/badge.svg)](https://github.com/The4leepy/dsh-pre-edit-review/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/The4leepy/dsh-pre-edit-review?display_name=tag)](https://github.com/The4leepy/dsh-pre-edit-review/releases/latest)


**Unofficial community project — not affiliated with DeepSeek.**

Review agent-proposed file changes **before they are written**. The DSH Host plugin intercepts a
file-mutating tool call, stages the proposal, and asks the VS Code extension to show an
**editable side-by-side diff**. The original file is only touched after the user clicks **Accept**;
the content that lands is whatever the user finally approved (including their own edits).

[中文说明](README.md) · [**Handover (start here if you maintain this)**](HANDOVER.md) · [Install](docs/install.md) · [Usage](docs/usage.md) · [Security model](docs/security.md) · [Troubleshooting](docs/troubleshooting.md)

> **0.3.0: installing the plugin no longer enables review.** Review is inactive until the user runs
> `/review on` in a session; only then are that session's writes intercepted. See
> [docs/usage.md](docs/usage.md).
>
> **Multiple Hosts coexist**: the Desktop profile and the TUI profile can both install the plugin and
> connect to the same VS Code at once. Each Host owns its own
> `~/.dsh/pre-edit-review/hosts/<hostKey>/{ipc.sock,token,staging,audit}` (ADR 0002).

## Why

Agentic coding tools write first and diff later. This project flips that around:

- **Pre-edit approval** — the tool body never runs before a decision; there is no "apply then roll back".
- **Editable proposal** — fix the agent's change directly in the diff, then accept your version.
- **Atomic, conflict-aware commit** — compare-and-swap on the file version; if the file changed during
  review, the write is refused instead of overwriting.
- **Honest security boundary** — tool-level mode reviews tool writes; **strict mode** (session
  `read-only`) is the only mode that can claim "nothing is written before approval", because the OS
  sandbox blocks shell/script writes too.

## Components

| Part | What it does |
|---|---|
| **DSH Host plugin** `dsh-pre-edit-review` | Intercepts `write` / `edit` / `str_replace_editor`, builds the full proposed content, stages it under `~/.dsh/pre-edit-review/hosts/<hostKey>/`, talks to VS Code over a per-Host Unix socket, and commits with a CAS precondition. |
| **VS Code extension** `The4leepy.deepseek-pre-edit-review` | Opens one editable `vscode.diff` per request, adds Accept/Reject buttons in the editor title, pending/history views, notifications and status bar. |
| **Safety rails** | Kill switch (`DISABLED`, global across Hosts), crash reconciliation, nonce-bound IPC, per-session review activation (`/review on` / `/review off`, inactive by default), per-Host state namespaces. |

## Install

```bash
git clone git@github.com:The4leepy/dsh-pre-edit-review.git
cd dsh-pre-edit-review
pnpm install && pnpm run build

# VS Code Marketplace (recommended for users):
code --install-extension The4leepy.deepseek-pre-edit-review

# or build and install locally:
scripts/install-extension.sh --build
scripts/install-plugin.sh              # arms the kill switch, then installs the DSH plugin
scripts/doctor.sh                      # health check
# once everything is OK:
rm ~/.dsh/pre-edit-review/DISABLED
# then, in the session you want reviewed: /review on   (review is OFF by default in 0.3.0)
```

The packaged Desktop build has no `dsh` CLI on `PATH`; `install-plugin.sh` then prints the exact
Web GUI / `plugin_manager install_bundle` step. See [docs/install.md](docs/install.md).

## Daily use

```text
Agent writes a file  →  VS Code shows Original | Proposed (Proposed is editable)
Accept (title bar ✓ / ⌘+Shift+A on macOS, Ctrl+Alt+A elsewhere)  →  your final content is committed
Reject (title bar ✗ / ⌘+Shift+Backspace on macOS, Ctrl+Alt+R elsewhere)  →  file unchanged, agent told why
```

Commands: `/review status`, `/review on` (enable review for this session), `/review off` (disable it),
`/review strict|balanced` (file policy), `/review history [n]`.

## Security

Read [docs/security.md](docs/security.md) before relying on this. The short version:

- **Review is inactive after install.** It is not a protection until the user runs `/review on` for a
  session; the plugin never pretends otherwise (status bar `· OFF`, `/review status`, startup log).
- **Tool-level mode (once activated)** reviews tool writes only; `bash`/scripts can bypass it. This
  mode does **not** claim a security guarantee.
- **Strict mode** (`/review strict`, session `read-only`) blocks every write through the OS sandbox;
  the only write path is the approved commit. Strict mode without activation simply denies writes.
- **Activation** (`/review on` / `/review off`) is user-only, session-scoped and in-memory; it decides
  whether review runs, never the sandbox. Subagent/teammate sessions are separate (known limitation).
- The kill switch `~/.dsh/pre-edit-review/DISABLED` makes **every Host** inert within a second and is
  the recovery path if a plugin bug ever blocks tool calls.
- **Multi-Host isolation**: each Host owns `hosts/<hostKey>/{ipc.sock,token,staging,audit}`; one
  Host's token cannot authenticate to another and the discovery `meta.json` never contains the token.
  Two instances of the *same* profile cannot coexist (`HOST_IN_USE`).
- The plugin runs inside the DSH Host process and is trusted code: install it only from a source you
  trust.

## Repository layout

```
packages/shared/            protocol v1, CommitTarget, review record, text semantics
packages/dsh-plugin/        DSH Host plugin (npm package + cordis.patch.yml bundle)
packages/vscode-extension/  VS Code extension (local VSIX)
packages/spikes/            verification probes kept as regression tools
scripts/                    build / install / uninstall / doctor / e2e client
docs/                       feasibility, phase reports, security, install/usage/troubleshooting
test/                       node --test unit and integration tests
```

## Development

```bash
pnpm install
pnpm run check   # typecheck + dependency boundaries + unit tests
pnpm run build   # plugin bundle + extension bundle
```

> Developing this repository itself: **do not install the plugin into your own profile** unless you
> need to test it — use the kill switch (see [docs/install.md](docs/install.md)) so your own edits are
> not reviewed.

## License

Apache-2.0. See [LICENSE](LICENSE).
