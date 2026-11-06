# Pre-edit Review for DeepSeek Harness

<!-- badges -->
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/The4leepy.deepseek-pre-edit-review?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=The4leepy.deepseek-pre-edit-review) [![CI](https://github.com/The4leepy/dsh-pre-edit-review/actions/workflows/ci.yml/badge.svg)](https://github.com/The4leepy/dsh-pre-edit-review/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/The4leepy/dsh-pre-edit-review?display_name=tag)](https://github.com/The4leepy/dsh-pre-edit-review/releases/latest)


**Unofficial community project — not affiliated with DeepSeek.**

Review agent-proposed file changes **before they are written**. The DSH Host plugin intercepts a
file-mutating tool call, stages the proposal, and asks the VS Code extension to show an
**editable side-by-side diff**. The original file is only touched after the user clicks **Accept**;
the content that lands is whatever the user finally approved (including their own edits).

[中文说明](README.md) · [**Handover (start here if you maintain this)**](HANDOVER.md) · [Install](docs/install.md) · [Usage](docs/usage.md) · [Security model](docs/security.md) · [Troubleshooting](docs/troubleshooting.md)

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
| **DSH Host plugin** `dsh-pre-edit-review` | Intercepts `write` / `edit` / `str_replace_editor`, builds the full proposed content, stages it under `~/.dsh/pre-edit-review`, talks to VS Code over a Unix socket, and commits with a CAS precondition. |
| **VS Code extension** `The4leepy.deepseek-pre-edit-review` | Opens one editable `vscode.diff` per request, adds Accept/Reject buttons in the editor title, pending/history views, notifications and status bar. |
| **Safety rails** | Kill switch (`DISABLED`), crash reconciliation, nonce-bound IPC, session-scoped review pause (`/review off`). |

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
```

The packaged Desktop build has no `dsh` CLI on `PATH`; `install-plugin.sh` then prints the exact
Web GUI / `plugin_manager install_bundle` step. See [docs/install.md](docs/install.md).

## Daily use

```text
Agent writes a file  →  VS Code shows Original | Proposed (Proposed is editable)
Accept (title bar ✓ / Ctrl+Alt+A)  →  your final content is committed
Reject (title bar ✗ / Ctrl+Alt+R)  →  file unchanged, agent told why
```

Commands: `/review status`, `/review on|off` (pause/resume this session),
`/review strict|balanced` (file policy), `/review history [n]`.

## Security

Read [docs/security.md](docs/security.md) before relying on this. The short version:

- **Tool-level mode (default)** reviews tool writes only; `bash`/scripts can bypass it. This mode
  does **not** claim a security guarantee.
- **Strict mode** (`/review strict`, session `read-only`) blocks every write through the OS sandbox;
  the only write path is the approved commit.
- **Review pause** (`/review off`) is user-only, session-scoped and in-memory; it skips review but
  does not change the sandbox.
- The kill switch `~/.dsh/pre-edit-review/DISABLED` makes the plugin inert within a second and is the
  recovery path if a plugin bug ever blocks tool calls.
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
