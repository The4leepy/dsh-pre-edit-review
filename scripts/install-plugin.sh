#!/usr/bin/env bash
# Install/re-enable the DSH Host plugin into a profile.
#
# SAFETY ORDER: the emergency kill switch is armed BEFORE the plugin is added,
# so a fresh install can never intercept your very next tool call. Verify with
# scripts/doctor.sh first, then disable the switch:
#
#   rm ~/.dsh/pre-edit-review/DISABLED
#
# When the `dsh` CLI is not on PATH (packaged Desktop builds), this script arms
# the kill switch and prints the exact manual/agent instructions instead.
#
# Usage:
#   scripts/install-plugin.sh [--profile <name>]

set -euo pipefail
# shellcheck source=_common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?missing profile name}"; PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PLUGIN_DIR="$REPO_ROOT/packages/dsh-plugin"

if [ ! -f "$PLUGIN_DIR/dist/index.mjs" ]; then
  echo "Plugin bundle is not built. Run: node packages/dsh-plugin/build.mjs" >&2
  exit 1
fi

say "Arming the kill switch first: $KILL_SWITCH"
arm_kill_switch
ok "kill switch armed (the plugin will be inert until you remove this file)"

DSH_BIN="$(find_dsh_cli)"
if [ -n "$DSH_BIN" ]; then
  say "Installing bundle into profile '$PROFILE' via dsh CLI"
  "$DSH_BIN" plugin --profile "$PROFILE" add "$PLUGIN_DIR"
  if plugin_installed; then
    ok "plugin registered in $PROFILE_DIR/package.json"
  else
    fail "plugin is not listed in the profile manifest"
    exit 1
  fi
  say ""
  say "Restart DSH (or let HMR apply it), run scripts/doctor.sh, then remove the kill switch:"
  say "  rm \"$KILL_SWITCH\""
  exit 0
fi

warn "the 'dsh' CLI is not on PATH (packaged Desktop build)."
say ""
say "Finish the install from inside DSH, one of:"
say "  1) Web GUI → Plugins → install a local bundle with this path:"
say "       $PLUGIN_DIR"
say "  2) In a DSH session:"
say "       plugin_manager install_bundle target=$PLUGIN_DIR"
say ""
say "The kill switch is already armed at $KILL_SWITCH, so the freshly mounted"
say "plugin will not intercept anything. Run scripts/doctor.sh to verify, then:"
say "  rm \"$KILL_SWITCH\""
exit 2
