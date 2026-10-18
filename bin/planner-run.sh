#!/bin/zsh
# launchd entrypoint. Runs the planner with the project venv; if the venv is broken (e.g. Homebrew
# removed the Python it was built on), falls back to any Python 3.11+ so the morning brief still
# appears with a rebuild warning. If no Python works at all, posts one macOS notification per day.
ROOT="${0:A:h:h}"
cd "$ROOT" || exit 1

if "$ROOT/.venv/bin/python" -c 'import tomllib' 2>/dev/null; then
  exec "$ROOT/.venv/bin/python" -m planner "$@"
fi

REASON="The project .venv is broken or missing (Homebrew Python probably changed)."
for PY in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [[ -x "$PY" ]] && "$PY" -c 'import sys, tomllib; assert sys.version_info >= (3, 11)' 2>/dev/null; then
    PLANNER_DEGRADED="$REASON" exec "$PY" -m planner "$@"
  fi
done

echo "$(date '+%F %T') no usable Python 3.11+; $REASON" >&2
mkdir -p "$ROOT/logs"
STAMP="$ROOT/logs/.notified-$(date +%F)"
if [[ ! -e "$STAMP" ]]; then
  touch "$STAMP"
  osascript -e 'display notification "No usable Python for the planner, so no brief today. Rebuild the .venv (see logs/morning.log)." with title "Planner"'
fi
exit 1
