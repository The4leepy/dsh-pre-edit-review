#!/usr/bin/env bash
# Health check for a DeepSeek Pre-edit Review installation.
# Exit code 0: no failures; 1: at least one failure; warnings do not fail.
#
# Usage:
#   scripts/doctor.sh [--profile <name>]

set -uo pipefail
# shellcheck source=_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?missing profile name}"; PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

FAILURES=0
report() { # report <PASS|WARN|FAIL> <message>
  case "$1" in
    PASS) ok "$2" ;;
    WARN) warn "$2" ;;
    FAIL) fail "$2"; FAILURES=$((FAILURES + 1)) ;;
  esac
}

say "DeepSeek Pre-edit Review — doctor"
say "repo:       $REPO_ROOT"
say "profile:    $PROFILE ($PROFILE_DIR)"
say "state dir:  $STATE_DIR"
say ""

# Toolchain -----------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  report PASS "node $(node --version)"
else
  report FAIL "node not found on PATH"
fi

# Build artifacts -----------------------------------------------------------
if [ -f "$REPO_ROOT/packages/dsh-plugin/dist/index.mjs" ]; then
  report PASS "plugin bundle built ($(wc -c <"$REPO_ROOT/packages/dsh-plugin/dist/index.mjs" | tr -d ' ') bytes)"
else
  report WARN "plugin bundle missing (run: node packages/dsh-plugin/build.mjs)"
fi
VSIX="$(newest_vsix)"
if [ -n "$VSIX" ]; then
  report PASS "extension package: $(basename "$VSIX")"
else
  report WARN "no .vsix found (run: scripts/install-extension.sh --build)"
fi

# VS Code extension ---------------------------------------------------------
if CODE="$(find_code_cli)"; then
  report PASS "VS Code CLI: $CODE"
  if extension_installed; then
    report PASS "extension $EXTENSION_ID installed"
  else
    report WARN "extension not installed (run scripts/install-extension.sh)"
  fi
  if pgrep -f "/Applications/Visual Studio Code.app/Contents/MacOS/Code" >/dev/null 2>&1; then
    report PASS "VS Code is running"
  else
    report WARN "VS Code is not running (no review client can connect)"
  fi
else
  report WARN "VS Code CLI not found"
fi

# DSH plugin registration ---------------------------------------------------
if [ -f "$PROFILE_DIR/package.json" ]; then
  report PASS "profile manifest found"
  if plugin_installed; then
    if plugin_bundled; then
      report PASS "plugin $PLUGIN_NAME enabled in dsh.profile.bundles"
    else
      report WARN "plugin dependency present but NOT enabled in dsh.profile.bundles (plugin is inert until re-enabled)"
    fi
    if [ -e "$PROFILE_DIR/node_modules/$PLUGIN_NAME" ]; then
      report PASS "plugin package resolves in profile node_modules"
    else
      report FAIL "plugin registered but its package is missing in profile node_modules"
    fi
    if [ -f "$REPO_ROOT/packages/dsh-plugin/dist/index.mjs" ]; then
      report PASS "plugin entry bundle present"
    fi
  else
    report WARN "plugin not registered (expected until you install it)"
  fi
else
  report FAIL "profile manifest missing: $PROFILE_DIR/package.json"
fi

# Runtime state dir ---------------------------------------------------------
if [ -d "$STATE_DIR" ]; then
  MODE="$(stat -f '%OLp' "$STATE_DIR" 2>/dev/null || stat -c '%a' "$STATE_DIR" 2>/dev/null || echo '?')"
  if [ "$MODE" = "700" ]; then
    report PASS "state dir permissions 700"
  else
    report WARN "state dir permissions $MODE (expected 700)"
  fi
  HOST_COUNT=0
  if [ -d "$STATE_DIR/hosts" ]; then
    for HOST_DIR in "$STATE_DIR"/hosts/*/; do
      [ -d "$HOST_DIR" ] || continue
      HOST_COUNT=$((HOST_COUNT + 1))
      HOST_KEY="$(basename "$HOST_DIR")"
      if [ -f "${HOST_DIR}meta.json" ]; then
        report PASS "host '$HOST_KEY': descriptor present"
      else
        report WARN "host '$HOST_KEY': meta.json missing (the VS Code client will skip it)"
      fi
      if [ -f "${HOST_DIR}token" ]; then
        TOKEN_MODE="$(stat -f '%OLp' "${HOST_DIR}token" 2>/dev/null || stat -c '%a' "${HOST_DIR}token" 2>/dev/null || echo '?')"
        [ "$TOKEN_MODE" = "600" ] && report PASS "host '$HOST_KEY': token permissions 600" || report WARN "host '$HOST_KEY': token permissions $TOKEN_MODE (expected 600)"
      else
        report WARN "host '$HOST_KEY': token missing (Host not started yet)"
      fi
      [ -S "${HOST_DIR}ipc.sock" ] && report PASS "host '$HOST_KEY': IPC socket present" || report WARN "host '$HOST_KEY': IPC socket missing (Host not running)"
    done
  fi
  if [ "$HOST_COUNT" -eq 0 ]; then
    report WARN "no per-Host directories yet (0.3.0 Hosts live under $STATE_DIR/hosts/<key>/)"
  fi
  if [ -e "$STATE_DIR/ipc.sock" ] || [ -f "$STATE_DIR/token" ]; then
    report WARN "legacy root ipc.sock/token present (0.2.x layout); 0.3.0 Hosts are namespaced under hosts/"
  fi
else
  report WARN "state dir does not exist yet (created on first plugin start)"
fi

if [ -f "$KILL_SWITCH" ]; then
  report WARN "KILL SWITCH IS ARMED: reviews are bypassed for every tool call; remove $KILL_SWITCH when done"
else
  report PASS "kill switch is off (install default: review INACTIVE until a session runs /review on)"
fi

say ""
if [ "$FAILURES" -eq 0 ]; then
  say "doctor: OK (no failures)"
  exit 0
fi
say "doctor: $FAILURES failure(s)"
exit 1
