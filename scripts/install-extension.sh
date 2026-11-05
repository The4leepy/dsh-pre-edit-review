#!/usr/bin/env bash
# Install (or reinstall) the VS Code extension from the newest packaged VSIX.
#
# Usage:
#   scripts/install-extension.sh            # use the newest .vsix
#   scripts/install-extension.sh --build    # rebuild the bundle and repackage first
#
# The extension is a local, unsigned VSIX installed with --force so upgrades work.

set -euo pipefail
# shellcheck source=_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

BUILD=0
[ "${1:-}" = "--build" ] && BUILD=1

cd "$REPO_ROOT"

if [ "$BUILD" = "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to build the extension" >&2
    exit 1
  fi
  node packages/vscode-extension/build.mjs
  (cd packages/vscode-extension && ../../node_modules/.bin/vsce package --no-dependencies --allow-missing-repository)
fi

VSIX="$(newest_vsix)"
if [ -z "$VSIX" ] || [ ! -f "$VSIX" ]; then
  echo "No .vsix found. Run with --build first (requires pnpm install once)." >&2
  exit 1
fi

CODE="$(find_code_cli)" || {
  echo "VS Code CLI not found. Install VS Code, or set PATH to include its bin/ directory." >&2
  exit 1
}

say "Installing extension from $(basename "$VSIX")"
"$CODE" --install-extension "$VSIX" --force >/dev/null
if extension_installed; then
  ok "extension $EXTENSION_ID installed"
else
  fail "extension does not appear in --list-extensions"
  exit 1
fi

say ""
say "Next: reload your VS Code window so the extension activates."
say "Then run scripts/install-plugin.sh to install the DSH Host plugin (it arms the kill switch first)."
