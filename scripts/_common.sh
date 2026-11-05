#!/usr/bin/env bash
# Shared helpers for the DeepSeek Pre-edit Review install scripts.
# Sourced, never executed directly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE:-desktop}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$DSH_HOME_DIR/profiles/$PROFILE}"
STATE_DIR="${DPR_STATE_DIR:-$DSH_HOME_DIR/pre-edit-review}"
KILL_SWITCH="$STATE_DIR/DISABLED"
PLUGIN_NAME="dsh-pre-edit-review"
EXTENSION_ID="The4leepy.deepseek-pre-edit-review"

say() { printf '%s\n' "$*"; }
ok() { printf '  ✔ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
fail() { printf '  ✘ %s\n' "$*"; }

find_code_cli() {
  if command -v code >/dev/null 2>&1; then
    command -v code
    return 0
  fi
  local candidate="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

find_dsh_cli() {
  command -v dsh 2>/dev/null || true
}

newest_vsix() {
  ls -1 "$REPO_ROOT"/packages/vscode-extension/*.vsix 2>/dev/null | sort -V | tail -1 || true
}

arm_kill_switch() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  : >"$KILL_SWITCH"
  chmod 600 "$KILL_SWITCH" 2>/dev/null || true
}

disarm_kill_switch() {
  rm -f "$KILL_SWITCH"
}

plugin_installed() {
  [ -f "$PROFILE_DIR/package.json" ] && grep -q "\"$PLUGIN_NAME\"" "$PROFILE_DIR/package.json"
}

extension_installed() {
  local code
  code="$(find_code_cli)" || return 1
  "$code" --list-extensions 2>/dev/null | grep -qi "^$EXTENSION_ID\$"
}
