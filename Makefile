# One entry point for checks. Run `make check` before committing.
PY     ?= .venv/bin/python
RUFF   ?= $(shell command -v ruff 2>/dev/null || echo uvx ruff)
PLUGIN := obsidian/paper-search

.PHONY: check test test-py test-ts lint typecheck build bundle-fresh

check: lint typecheck test bundle-fresh

test: test-py test-ts

test-py:
	$(PY) -m unittest discover -s tests

test-ts:
	cd $(PLUGIN) && npm test

lint:
	$(RUFF) check planner tests

typecheck:
	cd $(PLUGIN) && npm run typecheck

build:
	cd $(PLUGIN) && npm run build

# main.js is committed so the plugin installs without Node; fail if it is stale.
bundle-fresh: build
	git diff --exit-code -- $(PLUGIN)/main.js
