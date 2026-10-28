# AGENTS.md

Semantero: local literature search over Zotero and Obsidian notes. Papers (PDFs, web snapshots) and vault notes become one hybrid keyword + semantic index, searched from an Obsidian plugin and a native macOS launcher. Everything runs locally.

Design records (implemented; read for rationale, not as a to-do list): [docs/SEARCH_SPEC.md](docs/SEARCH_SPEC.md), [docs/INTEGRATION_SPEC.md](docs/INTEGRATION_SPEC.md).
Launcher (implemented; manual checks outstanding, see the log in DECISIONS_AND_GAPS.md): [docs/LAUNCHER_SPEC.md](docs/LAUNCHER_SPEC.md), a native macOS app (a glass panel on ⌥Space) over papers and vault notes; manual checklist [macos/CHECK.md](macos/CHECK.md).
Embedding installs (implemented; owner is judging them): [docs/EMBED_INSTALLS.md](docs/EMBED_INSTALLS.md), one index per embedding model in `profiles.toml`, switched with `planner profile use`; the pplx-embed-v2-late profile runs frozen on a pinned llama.cpp through `planner/pplxd.py` ([pplx/README.md](pplx/README.md)).
Decisions log: [docs/DECISIONS_AND_GAPS.md](docs/DECISIONS_AND_GAPS.md). Manual checklist: [docs/MANUAL_CHECKS.md](docs/MANUAL_CHECKS.md).
**Two setups share this repo: Obsidian only (plugin + watcher; `config.toml` ships with `[notes] enabled = false`) and Global (+ notes index + Semantero.app; `enabled = true` in `config.local.toml`, `make install-global`). Anything you add must keep the Obsidian-only setup working without Xcode, Node or a notes index. Install tiers and tools: [docs/INSTALL.md](docs/INSTALL.md). Architecture, commands, workflows and gotchas: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).** Index of all docs: [docs/README.md](docs/README.md).

**Before committing: `make check`** (ruff, tsc ×2, the Python, plugin, launcher-core and Swift suites, and a check that the committed `main.js` and `launcher-core/dist/ranker.js` match their sources). GitHub Actions runs the same minus Swift (`make ci`) on every PR and push to `main`. Fresh clone: `make dev-setup` first.

---

## What it does

### 1. Paper Search & Literature Discovery
- **Local Hybrid Search Engine**: Precomputed inverted-index BM25 with prefix expansion (top-64 candidate selection via dual binary search) and dense vector search (new installs: pplx-embed-v2-late via `planner/pplxd.py`; `config.toml`'s `[search]` and `--model qwen`: `qwen3-embedding:0.6b` via local Ollama). Scoring combines signals via Reciprocal Rank Fusion ($k=60$).
- **Obsidian Paper Search Plugin** (`obsidian/paper-search`):
  - **Search Modal (`PaperSearchModal`)**: Instant paper search. `Enter` opens the PDF in Zotero at the matching page (a web-snapshot match opens the snapshot via `zotero://open/library/items/<attKey>`, no page); `Cmd+Enter` inserts the citation (default `[[{{citekey}}]]`) and ensures the literature note exists; `Alt+Enter` opens the literature note, creating it if needed; `Shift+Enter` selects the item in Zotero.
  - **Inline Citations (`@@`)**: `EditorSuggest` autocompletion triggered anywhere in prose. Strictly excluded within code spans, math blocks, unclosed wikilinks, or frontmatter. Inserts citation in a single editor undo transaction and asynchronously creates the literature note.
  - **Literature Notes (`src/litnote.ts`)**: Idempotent generation of `<folder>/<citekey>.md` using custom or built-in templates. Handles YAML frontmatter escaping, path traversal protection, and safe character normalisation.
  - **Related Papers Panel (`RelatedPapersView`)**: Sidebar pane extracting the active note's passage/cursor section, cleans markdown formatting, shortens to $\le 2000$ characters at sentence boundaries, and retrieves relevant papers using calibrated instruction embedding. Hides already-cited papers by default with toggle to inspect them.
- **Incremental Zotero Watcher** (`planner/zotwatch.py`, `planner search watch-run`):
  - Triggered via launchd (`com.planner.zotero-watch.plist`) on changes to `~/Zotero/zotero.sqlite` and `zotero.sqlite-wal`. Zotero runs in WAL mode with an exclusive lock, so new items can sit in the log for hours: every reader goes through `zotlib.open_snapshot` (a private copy of both files), never `?immutable=1`.
  - Waits for `zotero.sqlite` to be quiet for 8 s, then compares a fingerprint of the library with `state.json` → `fingerprint`; unchanged means no build and no writes. The fingerprint is recorded only after a successful build.
  - A change is published twice: keyword-only first (`build_index(keyword_only=True)`, citable a second or two after the quiet window), then with vectors (~0.4 s a chunk on pplx). Log lines are timestamped.
  - The plugin's `@@` and search modal also ask Zotero's local API (`src/zoterolive.ts`, setting "Ask Zotero for new papers") for papers the index doesn't list yet; needs Zotero's "Allow other applications on this computer to communicate with Zotero", otherwise one refused request a minute.
  - The index builder (`planner/searchindex.py`) computes `content_hash` over papers, chunks, and vector bytes, and writes nothing when it is unchanged.
  - Indexes child PDFs and web snapshots (`text/html`, text via stdlib `html.parser` in `planner/htmltext.py`, chunks with page 0); both are in the fingerprint.
  - Retries missing PDF/snapshot attachments on subsequent runs when files appear on disk.
  - Concurrency protected by the shared advisory lock `.planner/search.lock` (also taken by a manual `search index`).


### 2. Launcher (one hotkey, papers + notes, any app)
- **Notes index** (`planner/mdtext.py`, `planner/notesindex.py`): every Markdown note in the vault (minus `[notes].exclude` globs, dot-folders, `Templates/**` by default) becomes a `papers.json` entry in `.planner/notes/`, with heading sections as chunks, in the same format as the paper index so the same engine ranks both. Kept fresh by the 5-minute launchd job `com.planner.notes` (`planner notes tick`, non-blocking lock). Personal exclusions go in git-ignored `config.local.toml`.
- **`launcher-core/`** (TypeScript, no Node/DOM in `src/`): merges the two corpora (keyword lists interleave by rank, semantic lists by raw cosine, RRF), collapses a paper with its literature note into one row, and returns `ResultVM`s (paths, URLs, citations, action ids). Bundled to `dist/ranker.js` (committed) and run by the app in JavaScriptCore. `conformance/cases.json` is the contract every ranker must meet.
- **`macos/`** (SwiftPM, no dependencies): `SemanteroKit` (testable: `JSCRanker`, `AcceleratedRanker`, query controller, action executor, index reloader, `IndexCoordinator` (reloads, file watcher, 60 s poll, settle GC, memory watchdog, embedding backend choice)) and `Semantero` (menu bar app: view state and wiring in `AppModel`, non-activating glass panel, settings; environment variables read once in `LaunchOptions`). `make install-app` builds and installs it. Debug aids: `SEMANTERO_SELFTEST=<json>` (see `make app-selftest`), `SEMANTERO_DEBUG=1` (reloads, compactions, watchdog), `SEMANTERO_SHOW_PANEL="<query>"`, `SEMANTERO_SNAPSHOT=<png>` (saves the panel view; needs no screen permission). The ranker choice (JavaScriptCore + Accelerate vector pass) is recorded in `docs/DECISIONS_AND_GAPS.md`.

---

## Assumptions

- macOS, Apple silicon, Homebrew. Python 3.11+ (venv currently on Homebrew 3.15), standard library only. The pplx profile's service (`planner/pplxd.py`) runs from its own venv with numpy (`pplx/install-service.sh`, also `make pplx-setup`); nothing else imports numpy.
- Node 26.4+ (natively executes `.ts` tests without transpile step).
- Vault at `~/Documents/Obsidian Vault`. Daily notes (`YYYY-MM-DD.md` in `daily_folder`, the vault root by default) are indexed as kind `daily`.
- Zotero database at `~/Zotero/zotero.sqlite`. Embeddings from the live profile: pplx-embed-v2-late via `com.planner.pplxd` at `http://127.0.0.1:11435` (what `setup-search.sh` installs by default; writes `<vault>/.planner/profile.json` for a fresh vault) or `qwen3-embedding:0.6b` via Ollama at `http://127.0.0.1:11434`.
- The owner's checkout path has a space and a **trailing space**. Always quote paths.

---

## Layout

```
planner/                __main__ (CLI), config, health (doctor), embed (embedding client)
                        store.py (atomic JSON/text writes, index folder swaps, locks)
                        indexfiles.py (what both index builders share: build folder, embed with fallback, manifest, publish)
                        searchindex.py (Zotero index builder), htmltext.py (snapshot text), zotwatch.py (incremental watcher)
                        mdtext.py (Markdown cleaning/sections/chunks), notesindex.py (vault notes index)
                        profiles.py (embedding profiles), pplx.py (pplx client, stdlib), pplxd.py (pplx service, numpy)
pplx/                   frozen pplx-embed-v2-late: convert/ (stage, GGUF, parity), requirements-pplxd.txt
obsidian/paper-search/  Obsidian plugin: src/ (engine, indexstore, bm25, modal (view), modalsearch (its controller), queryjobs, inline, litnote, passage, related)
                        test/ (unit & perf benchmarks), scripts/ (make-synthetic-index, eval-related)
launcher-core/          launcher ranking core: src/ (corpora, merge, query, vm, paths, urls, cite, actions, api), shortcuts.json,
                        conformance/, dist/ranker.js (committed), scripts/ (eval, record-conformance, make-bench-vault)
macos/                  Swift package: Sources/SemanteroKit, Sources/Semantero (app), Sources/SemanteroBench (spike S1), Tests/, scripts/, CHECK.md
bin/                    planner-run.sh: launchd entrypoint; falls back to any Python 3.11+ if .venv is broken
                        install-launchd.sh: renders a launchd/ template and (re)loads the job
launchd/                templates for com.planner.{zotero-watch,notes,pplxd}; installed by bin/install-launchd.sh
config.toml             vault paths, [search] (Zotero, embedding model), [notes] (notes index, off by default)
eval/                   queries.toml, related.toml (ground-truth evaluation datasets for search and related papers)
tests/                  Python unit tests (unittest); fixtures/search/ holds a tiny fake Zotero library and index
docs/                   design specs, decisions log (B1–B14 budgets), manual checklist (M1–M12)
Makefile                `make check` / `make test` / `make typecheck` / `make lint`
Vault side:             .planner/search/ (manifest.json, papers.json, chunks.json, vectors.f32, state.json), .planner/search.lock
                        .planner/notes/ (same files, one entry per note), .planner/notes.lock
logs/                   zotero-watch.log, notes.log, pplxd.log (git-ignored)
```

---

## Commands

### Python indexer CLI
Run from the project folder with `.venv/bin/python -m planner …`:

| Command | Effect |
|---|---|
| `doctor` | all health checks with fixes; exit 1 on any failure |
| `search index [--full]` | build or update the local Zotero paper search index |
| `search watch-run` | watcher execution step invoked by launchd on sqlite changes |
| `notes index [--full]` | build or update the vault notes search index |
| `notes tick` | what the 5-minute job runs: `notes index` when it is on, non-blocking, never fails |
| `notes stats` | notes per kind, chunks, literature notes matched, excluded, model, age |
| `profile list` / `profile build NAME [--full]` / `profile use NAME` | embedding profiles (`profiles.toml`): list, build one without touching the live index, switch the live index (docs/EMBED_INSTALLS.md) |
| `--data DIR` (global) | use another data folder inside the vault |

### Launcher
| Command | Effect |
|---|---|
| `make test-launcher` / `make test-swift` | `launcher-core` tests (TZ=UTC) / Swift Testing suite (`make test-swift-tsan` for Thread Sanitizer) |
| `cd launcher-core && npm run build` | rebuild the committed `dist/ranker.js` (`make check` fails if stale) |
| `make record-conformance` | re-record `conformance/cases.json` (a deliberate commit) |
| `make fixtures` | rebuild `launcher-core/test/fixtures/notes_small` from `tests/fixtures/notes/vault_small` |
| `node launcher-core/scripts/eval.ts --vault <dir> [--scope all\|papers\|notes\|compare] [--keyword-only]` | evaluate against `eval/queries.toml` (`expect_note` for notes) |
| `make app` / `make install-app` | build / install `Semantero.app` (Command Line Tools suffice) |
| `make bench-app` | spike S1: JavaScriptCore vs Accelerate on your vault |
| `make app-selftest` | builds the app and drives its real panel with synthetic keys (typing, arrows, ↵/⌘↵/⌘⇧↵, ⌘K, Esc, ⌘L, scopes); prints pass/fail |

### Obsidian Plugin Tests & Benchmarks
Run from `obsidian/paper-search`:

| Command | Effect |
|---|---|
| `npm test` | Run all unit tests in `test/*.test.ts` via Node native test runner |
| `npm run typecheck` | `tsc --noEmit` over `src/`, then over `src/`, `test/` and `scripts/` with Node types (`tsconfig.test.json`); esbuild does not typecheck |
| `npm run build` | Build production `main.js` via esbuild |
| `SEMANTERO_LIVE=1 SEMANTERO_PERF=1 node --test test/perf.test.ts` | Benchmark budgets B1–B14 with live Ollama & synthetic index |
| `node scripts/eval-related.ts --index <dir> --vault <copy> --toml eval/related.toml` | Evaluate Hit@5 and calibrate `relatedMinScore` |

---

## Rules for changes and testing

- **Test first.** New behaviour or a bug fix starts with a failing test (`tests/` for Python, `obsidian/paper-search/test/` for the plugin), then the code. Tests use temp dirs, fixtures and fakes only — no network, no live Ollama unless gated by `SEMANTERO_LIVE=1`.
- **Rebuild `main.js` after changing `src/`** and commit it with the change; `make check` fails if it is stale.
- **Never test against the real vault or real Zotero.** Performance tests use the synthetic index generator (`make-synthetic-index.ts`) or in-memory fakes (`test/fakes.ts`). Evaluation of related papers uses a temporary scratch copy in `/tmp/`.
- **No default hotkeys in plugin code.** Command registrations do not bind default keys; hotkeys belong in `.obsidian/hotkeys.json`. On load, `checkHotkeyConflict` flags clashes with existing commands.
- **Internal Obsidian APIs** (`chooser`, `suggestions.setSuggestions`) are accessed only through adapter wrappers with tested fallbacks (tests I6, MS11).
- **One ranking implementation.** Ranking lives in `obsidian/paper-search/src/` (no Obsidian imports there; test T1 enforces it). `launcher-core` and the app reuse it; never port ranking logic into Swift without the conformance suite passing (see LAUNCHER_SPEC.md, "Ranker decision").
- **Rebuild `launcher-core/dist/ranker.js` after changing `launcher-core/src/` or the shared core,** commit it, and re-record `conformance/cases.json` only when results change on purpose (`make record-conformance`, review the diff).
- **Index writers never leave a half-written index and never shrink it by accident.** Writes go to `<name>.tmp/` then swap. A vault scan that can't read a folder raises (`VaultUnreadable`) instead of writing a smaller index. Anything the 5-minute tick runs must not raise and must take a non-blocking lock.
- **Personal data never enters the repo** (it is public). No real note titles, vault contents or paths in docs, tests or fixtures. Private exclusions live in `config.local.toml` (git-ignored). Set `[notes].exclude` **before** the notes index first runs on a vault.
- **The launcher app:** JavaScriptCore calls stay in `autoreleasepool`s and engines are built off the query actor; the JIT entitlement and `JSCRanker.configureProcess()` are required for its speed and memory budgets. Anything drawn over the panel's glass must be opaque and outside the `GlassEffectContainer`. Run `make app-selftest` after any change to the panel or key handling. Details: DEVELOPMENT.md → Gotchas.
- **launchd plists are templates** (`__REPO__`, `__HOME__`, `__ZOTERO__`; no personal paths, a test enforces it). After changing one: `bin/install-launchd.sh <label>` (re-renders, waits for the old job to unload, loads the new one).

---

## Operations

- **Broken venv** (Homebrew Python changed): `rm -rf .venv && python3 -m venv .venv`. Until rebuilt, the wrapper runs on another Python and `doctor` says so.
- **Install Zotero Watcher:** `./setup-search.sh start` (or `bin/install-launchd.sh com.planner.zotero-watch <zotero dir>`).
- **Stop everything:**
  ```bash
  launchctl bootout gui/$(id -u)/com.planner.zotero-watch
  launchctl bootout gui/$(id -u)/com.planner.notes
  launchctl bootout gui/$(id -u)/com.planner.pplxd
  ```
- **Costs:** none. Paper search and embeddings run entirely locally, with no external API calls.
