#!/usr/bin/env bash
# Remove the VS Code extension and the DSH Host plugin.
#
# Usage:
#   scripts/uninstall.sh                 # remove extension + plugin registration
#   scripts/uninstall.sh --purge         # also delete the review state directory
#   scripts/uninstall.sh --purge --yes   # no confirmation
#
# Notes:
# - The plugin is removed through the `dsh` CLI when available; packaged Desktop
#   builds without the CLI must remove it via the Web GUI Plugins page or the
#   `plugin_manager` tool. This script prints the exact instructions.
# - --purge deletes staging records, the audit log, the token and the IPC socket.

set -euo pipefail
# shellcheck source=_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

PURGE=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --profile) PROFILE="${2:?missing profile name}"; PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say "Removing DeepSeek Pre-edit Review from profile '$PROFILE'"

# 1) VS Code extension -------------------------------------------------------
if CODE="$(find_code_cli)"; then
  if extension_installed; then
    "$CODE" --uninstall-extension "$EXTENSION_ID" >/dev/null 2>&1 || true
    if extension_installed; then
      fail "extension still installed (uninstall manually: code --uninstall-extension $EXTENSION_ID)"
    else
      ok "extension $EXTENSION_ID uninstalled (reload VS Code to finish)"
    fi
  else
    ok "extension not installed"
  fi
else
  warn "VS Code CLI not found; skipping extension removal"
fi

# 2) DSH Host plugin ---------------------------------------------------------
DSH_BIN="$(find_dsh_cli)"
if [ -n "$DSH_BIN" ] && plugin_installed; then
  "$DSH_BIN" plugin --profile "$PROFILE" remove "$PLUGIN_NAME" >/dev/null 2>&1 || true
  if plugin_installed; then
    fail "plugin still registered; remove it with: dsh plugin --profile $PROFILE remove $PLUGIN_NAME"
  else
    ok "plugin removed from profile"
  fi
elif plugin_installed; then
  warn "the 'dsh' CLI is not on PATH; remove the plugin from DSH, one of:"
  say "    Web GUI → Plugins → toggle/remove '$PLUGIN_NAME'"
  say "    DSH session: plugin_manager remove_bundle target=$PLUGIN_NAME"
else
  ok "plugin not registered in this profile"
fi

# 3) Leftover dependency symlink --------------------------------------------
LINK="$PROFILE_DIR/node_modules/$PLUGIN_NAME"
if [ -L "$LINK" ]; then
  if plugin_installed; then
    warn "package symlink left in place: the plugin is still registered. Remove it in DSH first, then re-run this script."
  else
    rm -f "$LINK"
    ok "removed leftover symlink $LINK"
  fi
fi

# 4) State directory ---------------------------------------------------------
if [ "$PURGE" = "1" ]; then
  if [ "$ASSUME_YES" != "1" ]; then
    printf 'Delete %s (staging records, audit log, token, socket)? [y/N] ' "$STATE_DIR"
    read -r answer
    [ "$answer" = "y" ] || [ "$answer" = "Y" ] || { say "kept state directory"; exit 0; }
  fi
  rm -rf "$STATE_DIR"
  ok "state directory removed: $STATE_DIR"
else
  warn "state directory kept: $STATE_DIR (use --purge to delete staging/audit/token)"
fi

say ""
say "Done. Reload VS Code if it is open."
