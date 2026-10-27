#!/bin/bash
# Installs the pplx service (planner/pplxd.py) for this checkout: its venv, then com.planner.pplxd in launchd.
# Run by setup-search.sh and `make pplx-setup`. Needs uv and the converted model (pplx/convert/convert.sh).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$HOME/Library/Application Support/Semantero/pplxd-venv"

test -x "$VENV/bin/python" || uv venv --python 3.12 "$VENV"
uv pip install --python "$VENV/bin/python" -r "$REPO/pplx/requirements-pplxd.txt"

bash "$REPO/bin/install-launchd.sh" com.planner.pplxd
