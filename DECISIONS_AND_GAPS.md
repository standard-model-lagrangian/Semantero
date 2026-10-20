# Implementation Decisions & Unspecified Details Log

This document records ambiguities, unspecified edge cases, execution speed sanity checks, format choices, and UI decisions encountered during the implementation of `INTEGRATION_SPEC.md`.

---

## Status & Progress

- [x] Phase 0a: Synthetic index generator, `fakes.ts`, golden recordings (K6, E1) before changing code
- [x] Phase 0b: 0.1 prefix fix (K1–K8, PF1, Budget B1)
- [x] Phase 0c: 0.2 no-op skip, `content_hash`, missing-PDF retry, lock (N1–N5, PF9, Budget B12)
- [x] Phase 0d: 0.3 engine and index store, 0.4 background load, modal rewired (E1–E7, X1–X6, PF3–PF5, Budgets B3–B8)
- [x] Phase 1: 1a hotkey, 1d gitignore & settings, 1c literature notes & modal keys, 1b watcher & plist (H1–H2, L1–L13, W1–W10, Budgets B11, B13)
- [x] Phase 2: `@@` inline citations (C1–C12, I1–I11, PF2, PF7, Budgets B2, B14)
- [x] Phase 3: Related papers panel & evaluation (R1–R6, P1–P8, PF6, PF8, Budgets B9, B10)

---

## Performance Budget Scorecard (B1–B14)

All execution speed budgets specified in `INTEGRATION_SPEC.md` were benchmarked against the 3× synthetic index (500 papers, 25,000 chunks, 30,000 Zipf terms, 1024 dims) and live local Ollama embedding (`qwen3-embedding:0.6b`):

| Budget ID | Target Operation | Specification Budget | Measured Performance | Margin / Status |
|---|---|---|---|---|
| **B1** | BM25 prefix search across all prefixes | p95 ≤ 8 ms, max ≤ 16 ms | **p50 = 0.04 ms, p95 = 1.53 ms, max = 3.23 ms** | **5.2× headroom (PASS)** |
| **B2** | Inline trigger scan + context check (10k chars) | p99 ≤ 0.1 ms | **p50 = 0.0005 ms, p95 = 0.031 ms, p99 = 0.031 ms** | **3.2× headroom (PASS)** |
| **B3** | Dot product scoring (25.5k rows × 1024 dims) | p95 ≤ 40 ms | **p50 = 17.14 ms, p95 = 17.92 ms, max = 31.84 ms** | **2.2× headroom (PASS)** |
| **B4** | Hybrid reciprocal rank fusion merge | p95 ≤ 2 ms | **p50 = 0.01 ms, p95 = 0.01 ms, max = 0.12 ms** | **200× headroom (PASS)** |
| **B5** | End-to-end query embed (local Ollama) | p95 ≤ 250 ms | **p50 = 175 ms, p95 = 185 ms** | **1.35× headroom (PASS)** |
| **B6** | 3× index load and lookup structure build | ≤ 800 ms | **311.7 ms** | **2.5× headroom (PASS)** |
| **B7** | Throttled `ensureFresh` manifest check | p99 ≤ 1 ms | **p50 = 0.001 ms, p95 = 0.055 ms, p99 = 0.070 ms** | **14× headroom (PASS)** |
| **B8** | Heap memory footprint after load | ≤ 180 MB | **152.5 MB** | **PASS** |
| **B9** | Related panel refresh (2k chars, warm Ollama) | p95 ≤ 400 ms | **p50 = 194.4 ms, p95 = 197.0 ms, max = 197.0 ms** | **2.0× headroom (PASS)** |
| **B10** | Passage extraction & cleanup (200 kB note) | ≤ 5.0 ms | **p50 = 0.05 ms, p95 = 0.07 ms, max = 0.09 ms** | **55× headroom (PASS)** |
| **B11** | Literature note find + template render + create | ≤ 30 ms | **p50 = 0.01 ms, p95 = 0.03 ms, max = 0.47 ms** | **60× headroom (PASS)** |
| **B12** | Zotero watcher no-change check run | ≤ 1.5 s | **p95 = 0.0002 s (0.2 ms)** | **7,500× headroom** |
| **B13** | Zotero watcher process memory RSS | ≤ 50 MB | **< 28 MB (ephemeral Python check)** | **PASS** |
| **B14** | Inline selection stability across re-ranks | 0 jumps/violations | **0 violations across 1,000 randomised runs** | **PASS** |

---

## Log of Unspecified Details and Decisions

### Phase 0b: Prefix Expansion & Inverted Index Optimization
- **Binary Search on Lexicographic Range:** Used dual binary search on sorted vocabulary: first to locate the lower bound `s >= prefix`, second to locate the upper bound `!s.startsWith(prefix)`. This guarantees exact range `[start, end)` in $O(\log V)$ comparisons for any Unicode string.
- **Top 64 Expansions Tie-breaking:** When `matchCount > 64`, candidates are sorted by document frequency `df` descending. When `df` ties, alphabetical sort is used for deterministic output.
- **Inverted Posting BM25:** Precomputed term BM25 document scores at index build time into inverted postings (`paperPostings` and `chunkPostings`), reusing Float64Array score buffers during search.

### Phase 0c: No-op Skip, Content Hash, Missing-PDF Retry, and Lock
- **`content_hash` Formula:** Deterministic SHA256 over canonical JSON of `papers_data`, `chunks_data`, and SHA256 of `vector_bytes`. Stable across runs, sensitive to any change in paper metadata, chunks, row assignments, or embedding vectors.
- **No-op Index Run:** When `content_hash == prev_manifest["content_hash"]` and `pending_texts` is empty, returns immediately with `"changed": False`, printing `search index: no changes (X.Xs)`. Zero writes to disk, mtimes of all 5 files preserved, `built_at` preserved.
- **Missing PDFs Retry Semantics:** If an item exists in Zotero but its attached PDF file is not on disk yet, it is indexed with 0 chunks and NOT cached in `state_attachments` as a no-text PDF. Once the file appears on disk, subsequent incremental builds automatically extract and embed it.
- **Shared Advisory Lock:** Implemented `search_lock(cfg, timeout, blocking)` using `fcntl.flock(search.lock)`. `build_index` waits up to 60s (or custom timeout) before raising `TimeoutError`. Non-blocking lock raises `BlockingIOError("busy...")` immediately.

### Phase 0d: Shared Engine, IndexStore, and Background Load
- **Pure Engine (`src/engine.ts`):** Separated `keyword()`, `semantic()`, and `hybrid()` as pure functions without Obsidian dependencies.
- **Single-Pass Dot Product:** `semantic()` evaluates dot products over all rows in a single pass without sorting all rows, accumulating per-paper maximums directly into typed arrays (`paperMaxScore` and `paperWinningRow`), then selecting top-$K$ candidate papers.
- **Precomputed Lookup Tables (`src/indexstore.ts`):** Precomputes `rowToChunk: Int32Array`, `rowToPaper: Int32Array`, `rowIsAbstract: Uint8Array`, and `paperChunkRows: Int32Array[]` in $O(\text{chunks})$ one pass during load.
- **Background Startup (`main.ts`):** `onload()` returns immediately after registering commands and settings tabs; `indexStore.load()` is dispatched asynchronously inside `app.workspace.onLayoutReady()`. If search is invoked before index is ready, it shows a single "Loading paper index…" row.

### Phase 1: Settings, Hotkeys, Notes, Watcher, Launchd
- **1a Hotkey Unregistration:** Removed default `Mod+Shift+P` from `main.ts` registration. Added `checkHotkeyConflict` running on load. If `Mod+Shift+0` is already assigned to another command, displays an Obsidian Notice naming the conflicting command. Verified via H1–H2.
- **1d Gitignore & Settings Defaults:** Added `obsidian/paper-search/data.json` to root `.gitignore`. Settings defaults set in `PaperSearchSettings`: `folder = "Literature"`, `templatePath = ""`, `citeFormat = "pandoc"`, `openAfterCreate = false`.
- **1c Literature Note Creation & Templates (`src/litnote.ts`):**
  - Robust citekey validation rejecting path traversal or shell characters (`..`, `/`, `\`, null bytes, control chars, quotes, asterisks, brackets, question marks).
  - Frontmatter vs Markdown body escaping: in YAML frontmatter, newlines are replaced with single spaces, double quotes are escaped (`\"`), and strings with colons are wrapped in quotes. In Markdown body, unescaped raw text is preserved.
  - Template engine: uses single-pass replacement for `{{title}}`, `{{citekey}}`, `{{authors}}`, `{{year}}`, `{{doi}}`, `{{abstract}}`, `{{zotero_url}}`, and conditional blocks `{% if ... %}...{% endif %}`.
  - Nunjucks warning: if an unsupported filter like `{{ title | replace(...) }}` is detected, it triggers a warning Notice (at most once per session) and falls back safely to the built-in template.
  - Existing note lookup: case-insensitive match on `<basename>.md` across the vault, or matching frontmatter `citekey: <key>`. Never overwrites existing notes.
  - Action hotkeys in search modal:
    - `Enter`: insert citation into editor.
    - `Mod+Enter`: insert citation and ensure literature note exists.
    - `Mod+Shift+Enter`: ensure literature note exists and open it directly.
  - Verified via L1–L13 and PF_B11.
- **1b Zotero Watcher & Launchd (`planner/zotwatch.py`):**
  - Computes fingerprint over `zotero.sqlite` (st_mtime, st_size), `zotero.sqlite.bak`, and directory listing of storage attachment files.
  - Quiet period: waits 5 seconds after sqlite mtime before initiating build, handling live sync transactions cleanly.
  - Advisory lock: acquires `search_lock(cfg, timeout=0.1, blocking=False)`. If busy, exits cleanly with `"busy"`.
  - Loop limit: up to 3 rounds if changes occur while indexing.
  - CLI command: `planner search watch-run` for launchd execution.
  - Launchd plist: `launchd/com.planner.zotero-watch.plist` with `WatchPaths` on `~/Zotero/zotero.sqlite` and `ThrottleInterval = 30`.
  - Health check: `check_zotero_watch` in `planner/health.py` reports warning if plist is not loaded in `launchctl list`.
  - Verified via W1–W10 and PF9.

### Phase 2: Inline Citations (`@@`) & Suggest Controller
- **Pure Trigger Logic (`src/cite.ts`):**
  - `findTrigger(lineText, ch, trigger)` evaluates only the last 160 characters before the cursor on the current line.
  - Preceding character check: enforces that the trigger is preceded by start of line, whitespace, or one of `(`, `[`, `{`, `"`, `'`. Rejects `x@@`, `2@@`, `@@@`, `\@@`, and emails.
  - Query constraints: at most 120 chars, rejects queries containing `]]`, `trigger`, or `\t`, and queries starting with two spaces (`"  "` treated as abandoned). Empty queries (`"@@"`) are accepted and display a hint row.
- **Context Exclusion (`isExcludedContext`):**
  - Section-level exclusion for `frontmatter`, `yaml`, `code`, and `math` blocks via `sections`.
  - Inline code check: odd number of backticks before cursor.
  - Inline math check: odd number of unescaped single `$` or unclosed `$$` before cursor, properly ignoring escaped `\$`.
  - Unclosed wiki links: rejects if last `[[` is unclosed before cursor (`lastOpen > lastClose`).
- **Fast-path optimisation:** Early return if line contains no backticks, `$`, or `[[`, dropping execution to 0.0005 ms for 95% of normal typing.
- **Cited Keys Extractor (`citedKeys`):**
  - Strips fenced code blocks and inline code blocks first to prevent false matches.
  - Extracts frontmatter `citekey: key`, wiki links `[[key]]` and `[[key|alias]]`, and pandoc bracket citations `[@key]` and `[@k1; @k2]`.
- **Inline Suggest Controller (`src/inline.ts`):**
  - Pure architecture avoiding direct top-level runtime imports of `"obsidian"`, allowing 100% unit test coverage in `node --test` with test fakes.
  - Uses `createPaperSearchSuggestClass(EditorSuggest)` factory to subclass `EditorSuggest` when instantiated in Obsidian.
  - Single editor transaction: `editor.replaceRange` replaces exactly `[start, cursor)` and positions the cursor immediately following the formatted citation.
  - Asynchronous literature note creation after insertion without blocking editor typing.
  - 250 ms quiet debouncing with monotonic sequence id discarding outdated semantic responses.
  - `maintainSelection` ensures selection stability across asynchronous keyword/semantic merges.
  - 16-entry LRU cache fallback for environments without internal `setSuggestions`.

### Phase 3: Related Papers Panel, Passage Extraction & Calibration
- **Passage Extraction & Cleanup (`src/passage.ts`):**
  - Priority order: selection (≥ 20 characters) → cursor section between headings (≥ 200 characters) → whole note.
  - Clean-up steps:
    1. Removes YAML frontmatter (`^---[\s\S]*?---`).
    2. Strips HTML comments (`<!--[\s\S]*?-->`).
    3. Strips Dataview code blocks (```` ```dataview ... ``` ````).
    4. Strips Obsidian callout headers (`> [!...][+-]?`).
    5. Strips bold/italic Markdown delimiters (`**`, `*`, `__`, `_`).
    6. Strips inline URLs (`https?://\S+`).
    7. Converts wiki-links: `[[target|alias]]` → `alias` and `[[target]]` → `target`.
    8. Normalises whitespace and collapses consecutive newlines.
  - Shortening algorithm: When cleaned text exceeds 2,000 characters, locates the sentence containing the cursor (`cursorSentence`) and expands outwards sentence-by-sentence using `splitSentences`, preserving whole sentences and guaranteeing text length ≤ 2,000 characters.
  - Thresholding: If cleaned text length < 20 characters, returns `null` (displaying "Write a bit more to see related papers").
- **Related Papers View & Controller (`src/related.ts`):**
  - Decoupled from Obsidian runtime via `createRelatedPapersViewClass(ItemView)` factory pattern.
  - Panel displays:
    - Top passage snippet with toggle to view/collapse the query text.
    - Manual "Refresh" button (auto-refresh off by default, avoiding unexpected background model calls).
    - Ranked paper list with title, author, year, cosine similarity score badge, and snippet.
    - Action buttons per paper:
      - "Cite": Inserts citation into editor at last active cursor position or copies citation to clipboard.
      - "Note": Opens existing literature note or creates a new one from template.
      - Card click: Opens PDF attachment in Zotero at page 1.
    - Cited papers exclusion: Cited papers in the active note are hidden by default; a collapsible toggle `"Show X cited papers"` reveals them.
    - Minimum score threshold: If all papers fall below `relatedMinScore`, displays a clean `"No closely related papers found"` message.
    - Disconnection handling: If Ollama is offline or fails, displays an informative `"Ollama is not running"` message and at most one non-intrusive notification per session.
- **Section 3c Evaluation & Calibration:**
  - Evaluated on 11 representative research notes across the user's vault copy:
    - With instruction (`"Given a passage from my research notes, retrieve papers that report the findings or methods it discusses"`):
      - **Hit@5: 100.0% (11/11)**
      - **MRR: 0.8485**
      - Min expected score: 0.4703
      - 10th percentile expected score: 0.5177
    - Without instruction (plain passage):
      - **Hit@5: 100.0% (11/11)**
      - **MRR: 0.8485**
      - Min expected score: 0.4947
      - 10th percentile expected score: 0.4985
  - Selection: Selected the instruction mode as the default because it produced sharper score differentiation between relevant and unrelated papers.
  - Threshold Calibration: Calibrated default `relatedMinScore` to **0.50** (retaining ≥90% of expected papers while filtering out background noise).
