#!/bin/zsh
# launchd entrypoint for the indexers (watcher, notes job). Runs them with the project venv; if the venv is broken
# (e.g. Homebrew removed the Python it was built on), falls back to any Python 3.11+ so the indexes stay fresh and
# `doctor` says to rebuild. If no Python works at all, posts one macOS notification per day.
ROOT="${0:A:h:h}"
cd "$ROOT" || exit 1

# launchd starts jobs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), which hides Homebrew tools
# such as pdftotext (poppler) and ollama. Add the Homebrew prefixes.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

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
  osascript -e 'display notification "No usable Python for the Semantero indexers. Rebuild the .venv (see logs/notes.log)." with title "Semantero"'
fi
exit 1
