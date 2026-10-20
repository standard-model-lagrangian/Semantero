# AGENTS.md

A personal planning and research productivity layer over Obsidian notes and Zotero. The owner writes messy notes in plain text; this project handles structuring, project tracking, and literature discovery out of sight.

Full design rationale: [SPEC.md](SPEC.md), [SEARCH_SPEC.md](SEARCH_SPEC.md), [INTEGRATION_SPEC.md](INTEGRATION_SPEC.md).
Audit trail & decisions log: [DECISIONS_AND_GAPS.md](DECISIONS_AND_GAPS.md).

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
- **Local Hybrid Search Engine**: Precomputed inverted-index BM25 with prefix expansion (top-64 candidate selection via dual binary search) and dense vector search (`qwen3-embedding:0.6b` via local Ollama). Scoring combines signals via Reciprocal Rank Fusion ($k=60$).
- **Obsidian Paper Search Plugin** (`obsidian/paper-search`):
  - **Search Modal (`PaperSearchModal`)**: Instant paper search. `Enter` opens the PDF in Zotero at the matching page (a web-snapshot match opens the snapshot via `zotero://open/library/items/<attKey>`, no page); `Cmd+Enter` inserts the citation (default `[[{{citekey}}]]`) and ensures the literature note exists; `Alt+Enter` opens the literature note, creating it if needed; `Shift+Enter` selects the item in Zotero.
  - **Inline Citations (`@@`)**: `EditorSuggest` autocompletion triggered anywhere in prose. Strictly excluded within code spans, math blocks, unclosed wikilinks, or frontmatter. Inserts citation in a single editor undo transaction and asynchronously creates the literature note.
  - **Literature Notes (`src/litnote.ts`)**: Idempotent generation of `<folder>/<citekey>.md` using custom or built-in templates. Handles YAML frontmatter escaping, path traversal protection, and safe character normalisation.
  - **Related Papers Panel (`RelatedPapersView`)**: Sidebar pane extracting the active note's passage/cursor section, cleans markdown formatting, shortens to $\le 2000$ characters at sentence boundaries, and retrieves relevant papers using calibrated instruction embedding. Hides already-cited papers by default with toggle to inspect them.
- **Incremental Zotero Watcher** (`planner/zotwatch.py`, `planner search watch-run`):
  - Triggered via launchd (`com.planner.zotero-watch.plist`) on changes to `~/Zotero/zotero.sqlite`.
  - Waits for `zotero.sqlite` to be quiet for 20 s, then compares a fingerprint of the library with `state.json` → `fingerprint`; unchanged means no build and no writes. The fingerprint is recorded only after a successful build.
  - The index builder (`planner/searchindex.py`) computes `content_hash` over papers, chunks, and vector bytes, and writes nothing when it is unchanged.
  - Indexes child PDFs and web snapshots (`text/html`, text via stdlib `html.parser` in `planner/htmltext.py`, chunks with page 0); both are in the fingerprint.
  - Retries missing PDF/snapshot attachments on subsequent runs when files appear on disk.
  - Concurrency protected by the shared advisory lock `.planner/search.lock` (also taken by the morning job's `search index`).

---

## Assumptions

- macOS, Apple silicon, Homebrew. Python 3.11+ (venv currently on Homebrew 3.15). Only third-party dependency: `anthropic` (weekly review and health checks).
- Node 26.4+ (natively executes `.ts` tests without transpile step).
- Vault at `~/Documents/Obsidian Vault`. Daily notes are `YYYY-MM-DD.md` at the vault root. Future-dated files are flagged by `doctor`.
- Zotero database at `~/Zotero/zotero.sqlite`. Local Ollama running `qwen3-embedding:0.6b` at `http://127.0.0.1:11434`.
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
obsidian/paper-search/  Obsidian plugin: src/ (engine, indexstore, bm25, modal, inline, litnote, passage, related)
                        test/ (unit & perf benchmarks), scripts/ (make-synthetic-index, eval-related)
prompts/                extract.md (per-note extraction), weekly.md (review)
bin/                    planner-run.sh: launchd entrypoint; falls back to any Python 3.11+ if .venv is broken
launchd/                com.planner.morning.plist, com.planner.weekly.plist, com.planner.zotero-watch.plist
config.toml             vault paths, models, schedule, brief tuning, threads config, search config
eval/                   related.toml (ground-truth evaluation dataset for related papers)
DECISIONS_AND_GAPS.md   Complete audit log of edge-cases, formats, UI decisions, and B1–B14 budgets
CHECK.md                Manual smoke testing and verification checklist (M1–M12)
Vault side:             .planner/days/*.json (sidecars), threads.json, thread_fixes.json, state.json, health.json
                        .planner/search/ (manifest.json, papers.json, chunks.json, vectors.f32, state.json), .planner/search.lock
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
| `compare DIR…`, `models groq`, `prompt D` | evaluation and debugging |
| `--model SPEC`, `--data DIR` (global) | override extraction model or data folder (for comparisons) |

### Obsidian Plugin Tests & Benchmarks
Run from `obsidian/paper-search`:

| Command | Effect |
|---|---|
| `npm test` | Run all 98 unit tests in `test/*.test.ts` via Node native test runner |
| `npm run build` | Build production `main.js` via esbuild |
| `DAITO_LIVE=1 DAITO_PERF=1 node --test test/perf.test.ts` | Benchmark budgets B1–B14 with live Ollama & synthetic index |
| `node scripts/eval-related.ts --index <dir> --vault <copy> --toml eval/related.toml` | Evaluate Hit@5 and calibrate `relatedMinScore` |

---

## Rules for changes and testing

- **Never test against the real vault or real Zotero.** Performance tests use the synthetic index generator (`make-synthetic-index.ts`) or in-memory fakes (`test/fakes.ts`). Evaluation of related papers uses a temporary scratch copy in `/tmp/`.
- **The brief is delimited by `%% planner:start %%` / `%% planner:end %%`.** Only text between the markers is ever replaced. The block is stripped before extraction and hashing. A brief deleted by the owner stays deleted (`state.json` → `brief_inserted`).
- **Never overwrite an existing review** without `--force`: it holds the owner's answers.
- **Editing `prompts/extract.md` changes `PROMPT_VERSION`,** which invalidates every sidecar, so the next run re-extracts all notes. Groq's free tier rate-limits this to around 10 minutes, with automatic waits. Changing the `extract` model does the same.
- **Sidecars are raw model output.** Corrections belong in `thread_fixes.json`, not in edited sidecars.
- **No default hotkeys in plugin code.** Command registrations do not bind default keys; hotkeys belong in `.obsidian/hotkeys.json`. On load, `checkHotkeyConflict` flags clashes with existing commands.
- **Internal Obsidian APIs** (`chooser`, `suggestions.setSuggestions`) are accessed only through adapter wrappers with tested fallbacks (test I6).
- **Python model calls:** Anthropic goes through the official SDK (`planner/llm.py`). Groq and other OpenAI-compatible hosts use stdlib HTTP.
- **After changing a plist:** `launchctl bootout gui/$(id -u)/<label>`, copy it to `~/Library/LaunchAgents/`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`.

---

## Operations

- **Broken venv** (Homebrew Python changed): `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install anthropic`. Until rebuilt, the wrapper runs on another Python and the brief warns.
- **Model retired:** `doctor` names it. Pick a replacement with `models groq`, or a current Claude ID, and update `config.toml`.
- **Rotate keys:** edit `secrets.toml`, then run `doctor`.
- **Install Zotero Watcher:**
  ```bash
  cp launchd/com.planner.zotero-watch.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.planner.zotero-watch.plist
  ```
- **Stop everything:**
  ```bash
  launchctl bootout gui/$(id -u)/com.planner.morning
  launchctl bootout gui/$(id -u)/com.planner.weekly
  launchctl bootout gui/$(id -u)/com.planner.zotero-watch
  ```
- **Costs:** Groq free tier, one note a day at `reasoning_effort = "high"` (~10s). The weekly review is about 12k characters of input to Haiku, a fraction of a cent. Paper search and embeddings run 100% locally with zero external API costs.
