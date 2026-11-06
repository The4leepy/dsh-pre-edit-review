# Security Policy

This project modifies how an AI agent writes files. Please read
[docs/security.md](docs/security.md) for the full threat model and the guarantees each mode makes.

## Reporting a vulnerability

Please **do not** open a public issue for a vulnerability.

- Preferred: open a [private security advisory](https://github.com/The4leepy/dsh-pre-edit-review/security/advisories/new)
  on this repository.
- Include: affected version (extension and plugin), DSH version, a minimal reproduction, and the
  impact you observed.

The maintainer is the only contributor; expect a best-effort response.

## Supported versions

| Version | Supported |
|---|---|
| extension 0.3.x + plugin 0.3.x | ✅ current |
| extension/plugin 0.2.x (review always-on, shared state dir) | ⚠️ superseded — no multi-Host support; upgrade |
| anything older | ❌ |

Only macOS with DSH Desktop 0.2.2-rc.1 is verified. Windows/Linux are untested.

## Trust boundary (short)

- **Review is inactive by default after install (0.3.0).** Until a user runs `/review on` in a
  session, the plugin does not intercept anything. Installing the plugin is not, by itself, a
  protection.
- The Host plugin executes **inside the DSH Host process** with the user's privileges. Installing it
  is equivalent to trusting its code. Install only from this repository or the published npm package.
- Only the user's session command can enable (`/review on`) or disable (`/review off`) review; agents
  and IPC messages cannot toggle it. It is memory-only, per session and audited.
- The VS Code extension can only answer a review request that the Host created; it cannot ask the
  Host to write a file.
- In tool-level mode, shell/script writes are **not** reviewed. Use strict mode when a hard guarantee
  is required.
- Each Host instance has its own socket/token/staging namespace under
  `~/.dsh/pre-edit-review/hosts/<hostKey>/`; the discovery file `meta.json` never contains the token.
  The kill switch `~/.dsh/pre-edit-review/DISABLED` is global and stops every Host.
