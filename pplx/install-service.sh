#!/bin/bash
# Installs the pplx service (planner/pplxd.py) for this checkout: its venv, then com.planner.pplxd in launchd.
# Run by setup-search.sh and `make pplx-setup`. Needs uv and the converted model (pplx/convert/convert.sh).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$HOME/Library/Application Support/Semantero/pplxd-venv"
PLIST="$HOME/Library/LaunchAgents/com.planner.pplxd.plist"

test -x "$VENV/bin/python" || uv venv --python 3.12 "$VENV"
uv pip install --python "$VENV/bin/python" -r "$REPO/pplx/requirements-pplxd.txt"

# The plist in launchd/ is a template; paths may hold spaces (or a trailing one), so they go in through sed, escaped.
esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
mkdir -p "$REPO/logs" "$HOME/Library/LaunchAgents"
sed -e "s|__HOME__|$(esc "$HOME")|g" -e "s|__REPO__|$(esc "$REPO")|g" "$REPO/launchd/com.planner.pplxd.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# bootout returns before the old job is gone, and bootstrap fails ("5: Input/output error") until it is.
launchctl bootout "gui/$(id -u)/com.planner.pplxd" 2>/dev/null || true
for _ in $(seq 50); do
  launchctl print "gui/$(id -u)/com.planner.pplxd" >/dev/null 2>&1 || break
  sleep 0.1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
