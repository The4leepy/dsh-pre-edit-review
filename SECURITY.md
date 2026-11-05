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
| extension 0.2.x + plugin 0.2.x | ✅ current |
| anything older | ❌ |

Only macOS with DSH Desktop 0.2.1-rc.5 is verified. Windows/Linux are untested.

## Trust boundary (short)

- The Host plugin executes **inside the DSH Host process** with the user's privileges. Installing it
  is equivalent to trusting its code. Install only from this repository or the published npm package.
- The VS Code extension can only answer a review request that the Host created; it cannot ask the
  Host to write a file.
- In tool-level mode, shell/script writes are **not** reviewed. Use strict mode when a hard guarantee
  is required.
- Review pause (`/review off`) can only be turned on by the user with a session command; agents
  cannot pause review.
