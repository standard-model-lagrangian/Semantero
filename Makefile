# One entry point for checks. Run `make check` before committing.
PY     ?= .venv/bin/python
RUFF   ?= $(shell command -v ruff 2>/dev/null || echo uvx ruff)
PLUGIN := obsidian/paper-search
LAUNCHER := launcher-core

.PHONY: check ci test test-py test-ts test-launcher test-swift lint typecheck build bundle-fresh fixtures record-conformance app install-app bench-app app-selftest dev-setup install-global pplx-convert pplx-setup test-pplx

check: lint typecheck test bundle-fresh

# What GitHub Actions runs (.github/workflows/ci.yml): `check` without the Swift suite, which stays local.
ci: lint typecheck test-py test-ts test-launcher bundle-fresh

# Everything a fresh clone needs for `make check` (test-swift additionally needs full Xcode).
dev-setup:
	test -x $(PY) || python3 -m venv .venv
	$(PY) -m pip install -q -r requirements.txt
	cd $(PLUGIN) && npm install
	cd $(LAUNCHER) && npm install

test: test-py test-ts test-launcher test-swift test-pplx

test-py:
	$(PY) -m unittest discover -s tests

test-ts:
	cd $(PLUGIN) && npm test

test-swift:
	cd macos && swift test

# Thread Sanitizer run (ranker actor, query controller).
test-swift-tsan:
	cd macos && swift test --sanitize=thread

# Builds macos/build/Semantero.app (see macos/scripts/bundle.sh for signing).
app:
	bash macos/scripts/bundle.sh

install-app: app
	rm -rf "/Applications/Semantero.app"
	cp -R "macos/build/Semantero.app" /Applications/
	@echo "installed to /Applications; open it once so macOS registers the Spotlight action"

# The global setup in one go: notes index (must be enabled in config.local.toml first) + the Semantero app.
install-global:
	@$(PY) -c "import sys; sys.path.insert(0, '.'); from planner import config, notesindex; sys.exit(0 if notesindex.notes_enabled(config.load()) else 'The notes index is off. Add to config.local.toml:\n  [notes]\n  enabled = true\n  exclude = [\"Templates/**\", \"Threads.md\", \"Zotero Template.md\", \"Zotero Citation Template.md\"]  # + your private notes\nSee docs/INSTALL.md (Global setup).')"
	$(PY) -m planner notes index
	$(MAKE) install-app
	@echo "Global setup done. Open Semantero once (allow Documents access), then press ⌥Space."

# Drives the built app's real panel with synthetic key events (no permissions needed) and prints a pass/fail report.
app-selftest: app
	rm -f macos/build/selftest.json
	SEMANTERO_SELFTEST="$(CURDIR)/macos/build/selftest.json" "macos/build/Semantero.app/Contents/MacOS/Semantero"
	@python3 -c "import json; d=json.load(open('macos/build/selftest.json')); [print(('ok  ' if s['ok'] else 'FAIL'), s['name'], '|', s['detail'][:70]) for s in d['steps']]; raise SystemExit(0 if d['summary']['passed']=='yes' else 1)"

# Spike S1: JavaScriptCore vs Accelerate on your vault (VAULT=... to override).
VAULT ?= $(HOME)/Documents/Obsidian Vault
bench-app:
	bash macos/scripts/bench.sh "$(VAULT)"

# TZ=UTC: note dates in the launcher's view models are shown in the machine's time zone.
test-launcher:
	cd $(LAUNCHER) && TZ=UTC npm test

lint:
	$(RUFF) check planner tests

typecheck:
	cd $(PLUGIN) && npm run typecheck
	cd $(LAUNCHER) && npm run typecheck

build:
	cd $(PLUGIN) && npm run build

# main.js is committed so the plugin installs without Node; fail if it is stale.
bundle-fresh: build
	git diff --exit-code -- $(PLUGIN)/main.js
	cd $(LAUNCHER) && npm run build
	git diff --exit-code -- $(LAUNCHER)/dist/ranker.js

# Rebuild the committed launcher fixtures (notes_small) and the conformance cases.
fixtures:
	$(PY) -m tests.fixtures.notes.make_notes_index

record-conformance:
	cd $(LAUNCHER) && npm run record

# Embedding profiles (profiles.toml, docs/EMBED_INSTALLS.md). The pplx-embed-v2-late profile needs a frozen model and
# its service: `make pplx-convert` once (downloads, converts, checks parity), then `make pplx-setup`. setup-search.sh
# runs both for new installs.
PPLX_VENV := $(HOME)/Library/Application Support/Semantero/pplxd-venv

pplx-convert:
	bash pplx/convert/convert.sh

pplx-setup:
	bash pplx/install-service.sh

# The service tests need numpy, which only the pplxd venv has; skipped (with a note) when it doesn't exist.
test-pplx:
	@if [ -x "$(PPLX_VENV)/bin/python" ]; then "$(PPLX_VENV)/bin/python" -m unittest tests.test_pplx; \
	else echo "test-pplx: skipped (no pplxd venv; make pplx-setup)"; fi
