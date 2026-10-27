#!/bin/bash
# Installs one launchd job from its template in launchd/ and (re)loads it:
#   bin/install-launchd.sh com.planner.morning
#   bin/install-launchd.sh com.planner.zotero-watch ~/Zotero
#   bin/install-launchd.sh --print <label> [zotero dir]     (prints the filled-in plist, installs nothing)
# Templates hold __REPO__ (this checkout), __HOME__ and __ZOTERO__ (the Zotero data folder: the second argument,
# default ~/Zotero). Run by setup-search.sh and pplx/install-service.sh; run it yourself after changing a template.
set -euo pipefail

PRINT=false
if [[ "${1:-}" == "--print" ]]; then PRINT=true; shift; fi
LABEL="${1:?usage: install-launchd.sh [--print] <label> [zotero dir]}"
ZOTERO="${2:-$HOME/Zotero}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO/launchd/$LABEL.plist"
[[ -f "$TEMPLATE" ]] || { echo "install-launchd.sh: no template for $LABEL (launchd/$LABEL.plist)" >&2; exit 1; }

# Paths may hold spaces (or a trailing one, like the owner's checkout), so they go in through sed, escaped for XML
# first and then for sed's replacement text.
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' -e 's/[\\&|]/\\&/g'; }
render() {
  sed -e "s|__HOME__|$(esc "$HOME")|g" -e "s|__REPO__|$(esc "$REPO")|g" -e "s|__ZOTERO__|$(esc "${ZOTERO%/}")|g" \
    "$TEMPLATE"
}
if $PRINT; then render; exit 0; fi

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
mkdir -p "$REPO/logs" "$HOME/Library/LaunchAgents"
render > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# bootout returns before the old job is gone, and bootstrap fails ("5: Input/output error") until it is.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in $(seq 50); do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.1
done
launchctl bootstrap "$DOMAIN" "$PLIST"
