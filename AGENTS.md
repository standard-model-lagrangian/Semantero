# AGENTS.md

A personal planning and research productivity layer over Obsidian notes and Zotero. The owner writes messy notes in plain text; this project handles structuring, project tracking, and literature discovery out of sight.

Design records (implemented; read for rationale, not as a to-do list): [docs/SPEC.md](docs/SPEC.md), [docs/SEARCH_SPEC.md](docs/SEARCH_SPEC.md), [docs/INTEGRATION_SPEC.md](docs/INTEGRATION_SPEC.md).
Launcher (implemented; manual checks and the Spotlight spikes outstanding, see the log in DECISIONS_AND_GAPS.md): [docs/LAUNCHER_SPEC.md](docs/LAUNCHER_SPEC.md), a native macOS app (glass panel + Spotlight) over papers and vault notes; manual checklist [macos/CHECK.md](macos/CHECK.md).
Embedding installs (implemented; owner is judging them): [docs/EMBED_INSTALLS.md](docs/EMBED_INSTALLS.md), one index per embedding model in `profiles.toml`, switched with `planner profile use`; the pplx-embed-v2-late profile runs frozen on a pinned llama.cpp through `planner/pplxd.py` ([pplx/README.md](pplx/README.md)).
Decisions log: [docs/DECISIONS_AND_GAPS.md](docs/DECISIONS_AND_GAPS.md). Manual checklist: [docs/MANUAL_CHECKS.md](docs/MANUAL_CHECKS.md).
**Two setups share this repo: Obsidian only (plugin + watcher; `config.toml` ships with `[notes] enabled = false`) and Global (+ notes index + Semantero.app; `enabled = true` in `config.local.toml`, `make install-global`). Anything you add must keep the Obsidian-only setup working without Xcode, Node or a notes index. Install tiers and tools: [docs/INSTALL.md](docs/INSTALL.md). Architecture, commands, workflows and gotchas: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).** Index of all docs: [docs/README.md](docs/README.md).

**Before committing: `make check`** (ruff, tsc ×2, the Python, plugin, launcher-core and Swift suites, and a check that the committed `main.js` and `launcher-core/dist/ranker.js` match their sources). GitHub Actions runs the same minus Swift (`make ci`) on every PR and push to `main`. Fresh clone: `make dev-setup` first.

---

## What it does

### 1. Planning Layer
- **Morning run** (`planner morning`, launchd every 5 min, does the work once per day on the first check after 04:00 while online):
  1. Writes last Sunday's weekly review first if it's missing (only for weeks since reviews began).
  2. Extracts new or edited daily notes into structured sidecars (gpt-oss-120b on Groq; local qwen3:8b via Ollama as fallback).
  3. Runs health checks, then writes a collapsible brief into today's note, creating the note from the template if needed.
  4. Regenerates `Threads.md` in the vault root with active and quiet multi-day project timelines.
  5. On subsequent 5-min checks: refreshes the brief if `y:` lines were added to today's note, and after 21:00 nudges with an evening reminder if today has no done record.
- **Brief**: carried-over or planned items from the last real note (grouped by thread with `(+N)` for sub-bullets), work that keeps recurring without progress, the week's Focus from the latest review, last-7-days done/planned per type, and `⚠ Setup:` warnings. The callout opens when there are warnings.
- **Done capture & `y:` lines**: either write under `status/done` (or `done`) in the evening, or add `y: <item>` lines in the next morning's note. The planner strips `y:` lines from today's note and appends them to yesterday's note for extraction and stats.
- **Project view (`Threads.md`)**: auto-generated timeline of active (last 14d) and quiet (15–60d) A/B/C projects with `[[YYYY-MM-DD]]` date links and status marks, delimited by `%% planner:threads:start %%` / `%% planner:threads:end %%`.
- **Evening reminder**: launchd prompts at 21:00 with a dialog to open the note if no done record exists.
- **Weekly review** (`planner weekly`, Sundays 21:00, Claude Haiku 5.5): writes `Reviews/YYYY-Www.md` with what happened, patterns, calibration, ≤3 questions (the owner answers inline; next review reads the answers), Focus bullets and thread cleanup.
- **Thread cleanup**: the review's merges and reassignments go into `.planner/thread_fixes.json`, applied over the raw sidecars whenever they're read.
- **Health checks** (`planner doctor`, also every morning, no model calls): vault access, future-dated notes, `secrets.toml` mode, launchd jobs, venv/SDK, Groq model still listed, Anthropic model lifecycle, Ollama model present, search index, Zotero watch job status, notes that fell back to local.

### 2. Paper Search & Literature Discovery Layer
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
  - Concurrency protected by the shared advisory lock `.planner/search.lock` (also taken by the morning job's `search index`).


### 3. Launcher (one hotkey, papers + notes, any app)
- **Notes index** (`planner/mdtext.py`, `planner/notesindex.py`): every Markdown note in the vault (minus `[notes].exclude` globs, dot-folders, `Templates/**` by default) becomes a `papers.json` entry in `.planner/notes/`, with heading sections as chunks, in the same format as the paper index so the same engine ranks both. Kept fresh on every 5-minute launchd tick (`_notes_tick` in `__main__.py`, non-blocking lock). Personal exclusions go in git-ignored `config.local.toml`.
- **`launcher-core/`** (TypeScript, no Node/DOM in `src/`): merges the two corpora (keyword lists interleave by rank, semantic lists by raw cosine, RRF), collapses a paper with its literature note into one row, and returns `ResultVM`s (paths, URLs, citations, action ids). Bundled to `dist/ranker.js` (committed) and run by the app in JavaScriptCore. `conformance/cases.json` is the contract every ranker must meet.
- **`macos/`** (SwiftPM, no dependencies): `SemanteroKit` (testable: `JSCRanker`, `AcceleratedRanker`, query controller, action executor, index reloader, Spotlight donor) and `Semantero` (menu bar app: non-activating glass panel, settings, App Intents). `make install-app` builds and installs it. Debug aids: `SEMANTERO_SELFTEST=<json>` (see `make app-selftest`), `SEMANTERO_DEBUG=1` (reloads, compactions, watchdog), `SEMANTERO_SHOW_PANEL="<query>"`, `SEMANTERO_SNAPSHOT=<png>` (saves the panel view; needs no screen permission). The ranker choice (JavaScriptCore + Accelerate vector pass) is recorded in `docs/DECISIONS_AND_GAPS.md`.

---

## Assumptions

- macOS, Apple silicon, Homebrew. Python 3.11+ (venv currently on Homebrew 3.15). Only third-party dependency: `anthropic` (weekly review and health checks). The pplx profile's service (`planner/pplxd.py`) runs from its own venv with numpy (`pplx/install-service.sh`, also `make pplx-setup`); nothing else imports numpy.
- Node 26.4+ (natively executes `.ts` tests without transpile step).
- Vault at `~/Documents/Obsidian Vault`. Daily notes are `YYYY-MM-DD.md` at the vault root. Future-dated files are flagged by `doctor`.
- Zotero database at `~/Zotero/zotero.sqlite`. Embeddings from the live profile: pplx-embed-v2-late via `com.planner.pplxd` at `http://127.0.0.1:11435` (what `setup-search.sh` installs by default; writes `<vault>/.planner/profile.json` for a fresh vault) or `qwen3-embedding:0.6b` via Ollama at `http://127.0.0.1:11434`.
- Note format: plain-text headings `Flow`, `type A`, `type B`, `type C`, `status/done` (or `done`), `thoughts`, from `Templates/Daily.md`, which is shared with Obsidian's Daily Notes plugin via `.obsidian/daily-notes.json`. A: head-down high-friction work. B: open-ended but defined. C: exploratory. Older notes have no headings; the extractor infers types.
- A day without a filled `done` section is "no record", not "nothing done". A note holding only the brief and the empty template is a skipped day.
- A day starts at 04:00 (`[schedule] day_starts_hour`).
- Keys live in `secrets.toml` (chmod 600, git-ignored): `GROQ_API_KEY`, `ANTHROPIC_API_KEY`. See `secrets.example.toml`.
- The project path has a **trailing space**: `"/Users/frederick/Visual Studio /productivity work "`. Always quote it.

---

## Layout

```
planner/                __main__ (CLI), extract, threads, fixes, stats, brief, weekly, health, llm, vault, config
                        searchindex.py (Zotero index builder), htmltext.py (snapshot text), zotwatch.py (incremental watcher)
                        mdtext.py (Markdown cleaning/sections/chunks), notesindex.py (vault notes index)
                        profiles.py (embedding profiles), pplx.py (pplx client, stdlib), pplxd.py (pplx service, numpy)
pplx/                   frozen pplx-embed-v2-late: convert/ (stage, GGUF, parity), requirements-pplxd.txt
obsidian/paper-search/  Obsidian plugin: src/ (engine, indexstore, bm25, modal, inline, litnote, passage, related)
                        test/ (unit & perf benchmarks), scripts/ (make-synthetic-index, eval-related)
launcher-core/          launcher ranking core: src/ (corpora, merge, query, vm, paths, urls, cite, actions, api), shortcuts.json,
                        conformance/, dist/ranker.js (committed), scripts/ (eval, record-conformance, make-bench-vault)
macos/                  Swift package: Sources/SemanteroKit, Sources/Semantero (app), Sources/SemanteroBench (spike S1), Tests/, scripts/, CHECK.md
prompts/                extract.md (per-note extraction), weekly.md (review)
bin/                    planner-run.sh: launchd entrypoint; falls back to any Python 3.11+ if .venv is broken
                        install-launchd.sh: renders a launchd/ template and (re)loads the job
launchd/                templates for com.planner.{morning,weekly,zotero-watch,pplxd}; installed by bin/install-launchd.sh
config.toml             vault paths, models, schedule, brief tuning, threads config, search config
eval/                   queries.toml, related.toml (ground-truth evaluation datasets for search and related papers)
tests/                  Python unit tests (unittest); fixtures/search/ holds a tiny fake Zotero library and index
docs/                   design specs, decisions log (B1–B14 budgets), manual checklist (M1–M12)
Makefile                `make check` / `make test` / `make typecheck` / `make lint`
Vault side:             .planner/days/*.json (sidecars), threads.json, thread_fixes.json, state.json, health.json
                        .planner/search/ (manifest.json, papers.json, chunks.json, vectors.f32, state.json), .planner/search.lock
                        .planner/notes/ (same files, one entry per note), .planner/notes.lock
                        Reviews/YYYY-Www.md, Templates/Daily.md, Threads.md
logs/                   morning.log, weekly.log, zotero-watch.log (git-ignored)
```

---

## Commands

### Python Planner & Search CLI
Run from the project folder with `.venv/bin/python -m planner …`:

| Command | Effect |
|---|---|
| `doctor` | all health checks with fixes; exit 1 on any failure |
| `brief [--date D]` | dry run: print the brief and where it would go. `--write` inserts it |
| `threads [--date D]` | dry run: print Threads.md content. `--write` updates the file |
| `remind [--force]` | show evening reminder dialog now (for testing) |
| `backfill [--force] [--only D…]` | extract stale notes, rebuild `threads.json` |
| `show [--threads] [--date D]` | inspect extracted data |
| `weekly --dry-run --force` | generate a review and print it, write nothing |
| `morning [--force]` | the daily run; `--force` reruns today |
| `search index [--full]` | build or update the local Zotero paper search index |
| `search watch-run` | watcher execution step invoked by launchd on sqlite changes |
| `notes index [--full]` | build or update the vault notes search index (also runs on every launchd tick) |
| `notes stats` | notes per kind, chunks, literature notes matched, excluded, model, age |
| `profile list` / `profile build NAME [--full]` / `profile use NAME` | embedding profiles (`profiles.toml`): list, build one without touching the live index, switch the live index (docs/EMBED_INSTALLS.md) |
| `compare DIR…`, `models groq`, `prompt D` | evaluation and debugging |
| `--model SPEC`, `--data DIR` (global) | override extraction model or data folder (for comparisons) |

### Launcher
| Command | Effect |
|---|---|
| `make test-launcher` / `make test-swift` | `launcher-core` tests (TZ=UTC) / Swift Testing suite (`make test-swift-tsan` for Thread Sanitizer) |
| `cd launcher-core && npm run build` | rebuild the committed `dist/ranker.js` (`make check` fails if stale) |
| `make record-conformance` | re-record `conformance/cases.json` (a deliberate commit) |
| `make fixtures` | rebuild `launcher-core/test/fixtures/notes_small` from `tests/fixtures/notes/vault_small` |
| `node launcher-core/scripts/eval.ts --vault <dir> [--scope all\|papers\|notes\|compare] [--keyword-only]` | evaluate against `eval/queries.toml` (`expect_note` for notes) |
| `make app` / `make install-app` | build / install `Semantero.app` (Command Line Tools suffice; full Xcode adds the Spotlight action's App Intents metadata) |
| `make bench-app` | spike S1: JavaScriptCore vs Accelerate on your vault |
| `make app-selftest` | builds the app and drives its real panel with synthetic keys (typing, arrows, ↵/⌘↵/⌘⇧↵, ⌘K, Esc, ⌘L, scopes); prints pass/fail |

### Obsidian Plugin Tests & Benchmarks
Run from `obsidian/paper-search`:

| Command | Effect |
|---|---|
| `npm test` | Run all unit tests in `test/*.test.ts` via Node native test runner |
| `npm run typecheck` | `tsc --noEmit` over `src/` (esbuild does not typecheck) |
| `npm run build` | Build production `main.js` via esbuild |
| `SEMANTERO_LIVE=1 SEMANTERO_PERF=1 node --test test/perf.test.ts` | Benchmark budgets B1–B14 with live Ollama & synthetic index |
| `node scripts/eval-related.ts --index <dir> --vault <copy> --toml eval/related.toml` | Evaluate Hit@5 and calibrate `relatedMinScore` |

---

## Rules for changes and testing

- **Test first.** New behaviour or a bug fix starts with a failing test (`tests/` for Python, `obsidian/paper-search/test/` for the plugin), then the code. Tests use temp dirs, fixtures and fakes only — no network, no live Ollama unless gated by `SEMANTERO_LIVE=1`.
- **Rebuild `main.js` after changing `src/`** and commit it with the change; `make check` fails if it is stale.
- **Never test against the real vault or real Zotero.** Performance tests use the synthetic index generator (`make-synthetic-index.ts`) or in-memory fakes (`test/fakes.ts`). Evaluation of related papers uses a temporary scratch copy in `/tmp/`.
- **The brief is delimited by `%% planner:start %%` / `%% planner:end %%`.** Only text between the markers is ever replaced. The block is stripped before extraction and hashing. A brief deleted by the owner stays deleted (`state.json` → `brief_inserted`).
- **Never overwrite an existing review** without `--force`: it holds the owner's answers.
- **Editing `prompts/extract.md` changes `PROMPT_VERSION`,** which invalidates every sidecar, so the next run re-extracts all notes. Groq's free tier rate-limits this to around 10 minutes, with automatic waits. Changing the `extract` model does the same.
- **Sidecars are raw model output.** Corrections belong in `thread_fixes.json`, not in edited sidecars.
- **No default hotkeys in plugin code.** Command registrations do not bind default keys; hotkeys belong in `.obsidian/hotkeys.json`. On load, `checkHotkeyConflict` flags clashes with existing commands.
- **Internal Obsidian APIs** (`chooser`, `suggestions.setSuggestions`) are accessed only through adapter wrappers with tested fallbacks (test I6).
- **Python model calls:** Anthropic goes through the official SDK (`planner/llm.py`). Groq and other OpenAI-compatible hosts use stdlib HTTP.
- **One ranking implementation.** Ranking lives in `obsidian/paper-search/src/` (no Obsidian imports there; test T1 enforces it). `launcher-core` and the app reuse it; never port ranking logic into Swift without the conformance suite passing (see LAUNCHER_SPEC.md, "Ranker decision").
- **Rebuild `launcher-core/dist/ranker.js` after changing `launcher-core/src/` or the shared core,** commit it, and re-record `conformance/cases.json` only when results change on purpose (`make record-conformance`, review the diff).
- **Index writers never leave a half-written index and never shrink it by accident.** Writes go to `<name>.tmp/` then swap. A vault scan that can't read a folder raises (`VaultUnreadable`) instead of writing a smaller index. Anything the 5-minute tick runs must not raise and must take a non-blocking lock.
- **Personal data never enters the repo** (it is public). No real note titles, vault contents or paths in docs, tests or fixtures. Private exclusions live in `config.local.toml`, keys in `secrets.toml` (both git-ignored). Set `[notes].exclude` **before** the notes index first runs on a vault.
- **The launcher app:** JavaScriptCore calls stay in `autoreleasepool`s and engines are built off the query actor; the JIT entitlement and `JSCRanker.configureProcess()` are required for its speed and memory budgets. Anything drawn over the panel's glass must be opaque and outside the `GlassEffectContainer`. Run `make app-selftest` after any change to the panel or key handling. Details: DEVELOPMENT.md → Gotchas.
- **launchd plists are templates** (`__REPO__`, `__HOME__`, `__ZOTERO__`; no personal paths, a test enforces it). After changing one: `bin/install-launchd.sh <label>` (re-renders, waits for the old job to unload, loads the new one).

---

## Operations

- **Broken venv** (Homebrew Python changed): `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install anthropic`. Until rebuilt, the wrapper runs on another Python and the brief warns.
- **Model retired:** `doctor` names it. Pick a replacement with `models groq`, or a current Claude ID, and update `config.toml`.
- **Rotate keys:** edit `secrets.toml`, then run `doctor`.
- **Install Zotero Watcher:** `./setup-search.sh start` (or `bin/install-launchd.sh com.planner.zotero-watch <zotero dir>`).
- **Stop everything:**
  ```bash
  launchctl bootout gui/$(id -u)/com.planner.morning
  launchctl bootout gui/$(id -u)/com.planner.weekly
  launchctl bootout gui/$(id -u)/com.planner.zotero-watch
  ```
- **Costs:** Groq free tier, one note a day at `reasoning_effort = "high"` (~10s). The weekly review is about 12k characters of input to Haiku, a fraction of a cent. Paper search and embeddings run 100% locally with zero external API costs.
