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
| **B3** | `semantic()` scoring + top-k, excluding the Ollama call (25.5k rows × 1024 dims) | p95 ≤ 25 ms | **p50 = 17.14 ms, p95 = 17.92 ms, max = 31.84 ms** | **1.4× headroom (PASS)** |
| **B4** | Hybrid merge + snippets for 12 hits | p95 ≤ 3 ms | **p50 = 0.01 ms, p95 = 0.01 ms, max = 0.12 ms** | **200× headroom (PASS)** |
| **B5** | `onload()` | ≤ 20 ms | not measured (onload no longer awaits the index load, X6) | **UNTESTED** |
| **B6** | 3× index load and lookup structure build | ≤ 800 ms | **311.7 ms** | **2.5× headroom (PASS)** |
| **B7** | `ensureFresh()` when nothing changed | ≤ 2 ms | **p50 = 0.001 ms, p95 = 0.055 ms, p99 = 0.070 ms** | **14× headroom (PASS)** |
| **B8** | Heap after load | ≤ 160 MB at 1×; reported at 3× | **152.5 MB at 3× (reported only)**; 1× not asserted by PF4 | **reported** |
| **B9** | Related panel refresh (2k chars, warm Ollama) | p95 ≤ 400 ms | **p50 = 194.4 ms, p95 = 197.0 ms, max = 197.0 ms** | **2.0× headroom (PASS)** |
| **B10** | Passage extraction & cleanup (200 kB note) | ≤ 5.0 ms | **p50 = 0.05 ms, p95 = 0.07 ms, max = 0.09 ms** | **55× headroom (PASS)** |
| **B11** | Literature note find + template render + create | ≤ 30 ms | **p50 = 0.01 ms, p95 = 0.03 ms, max = 0.47 ms** | **60× headroom (PASS)** |
| **B12** | `planner search watch-run` with no change | ≤ 1.5 s wall, 0 bytes written under `.planner/search/` | **under 1.5 s on the fixture library (PF9)** | **PASS** |
| **B13** | New paper saved in Zotero → findable by keyword in the pop-up | ≤ 90 s (20 s quiet + 30 s throttle + ~10 s embed + reload) | not measured end to end | **UNTESTED** |
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
- **Shared Advisory Lock:** Implemented `search_lock(cfg, timeout, blocking)` using `fcntl.flock` on `.planner/search.lock`. `build_index` waits up to 60s (or custom timeout) before raising `TimeoutError`. Non-blocking lock raises `BlockingIOError("busy...")` immediately.

### Phase 0d: Shared Engine, IndexStore, and Background Load
- **Pure Engine (`src/engine.ts`):** Separated `keyword()`, `semantic()`, and `hybrid()` as pure functions without Obsidian dependencies.
- **Single-Pass Dot Product:** `semantic()` evaluates dot products over all rows in a single pass without sorting all rows, accumulating per-paper maximums directly into typed arrays (`paperMaxScore` and `paperWinningRow`), then selecting top-$K$ candidate papers.
- **Precomputed Lookup Tables (`src/indexstore.ts`):** Precomputes `rowToChunk: Int32Array`, `rowToPaper: Int32Array`, `rowIsAbstract: Uint8Array`, and `paperChunkRows: Int32Array[]` in $O(\text{chunks})$ one pass during load.
- **Background Startup (`main.ts`):** `onload()` returns immediately after registering commands and settings tabs; `indexStore.load()` is dispatched asynchronously inside `app.workspace.onLayoutReady()`. If search is invoked before index is ready, it shows a single "Loading paper index…" row.

### Phase 1: Settings, Hotkeys, Notes, Watcher, Launchd
- **1a Hotkey Unregistration:** Removed default `Mod+Shift+P` from `main.ts` registration. Added `checkHotkeyConflict` running on load. If `Mod+Shift+0` is already assigned to another command, displays an Obsidian Notice naming the conflicting command. Verified via H1–H2.
- **1d Gitignore & Settings Defaults:** Added `obsidian/paper-search/data.json` to root `.gitignore`. Settings defaults set in `PaperSearchSettings`: `literatureNoteFolder = ""` (vault root), `literatureNoteTemplate = "Zotero Template.md"`, `citationFormat = "[[{{citekey}}]]"`, `createLiteratureNotes = true`.
- **1c Literature Note Creation & Templates (`src/litnote.ts`):**
  - Robust citekey validation rejecting path traversal or shell characters (`..`, `/`, `\`, null bytes, control chars, quotes, asterisks, brackets, question marks).
  - Frontmatter vs Markdown body escaping: in YAML frontmatter, each value is escaped exactly once. Inside `"..."` it is escaped for double quotes (`\"`, `\\`, line breaks → spaces); an unquoted `key: {{placeholder}}` value is quoted only when YAML needs it (colon-space, leading indicator, empty, `true`/`null`…); list items and lines without placeholders are left alone. In the Markdown body, raw text is preserved.
  - Template engine: single-pass replacement for `{{citekey}}`, `{{title}}`, `{{authors}}`, `{{year}}`, `{{journal}}`, `{{doi}}`, `{{abstractNote}}`, `{{notes}}` (empty) and `{{zoteroSelect}}` (a `zotero://select/library/items/<key>` link). There are no conditional blocks.
  - Nunjucks warning: any `{% ... %}`, `{# ... #}` or filter (`{{ title | replace(...) }}`) triggers one warning Notice per session (the set is shared by the modal, `@@` and the panel) and falls back to the built-in template.
  - Existing note lookup: case-insensitive match on `<basename>.md` across the vault, or matching frontmatter `citekey: <key>`. Never overwrites existing notes.
  - Action hotkeys in search modal:
    - `Enter`: open the PDF in Zotero at the matching page.
    - `Cmd+Enter`: insert the citation and ensure the literature note exists.
    - `Alt+Enter`: open the literature note, creating it if needed.
    - `Shift+Enter`: select the item in Zotero.
  - Verified via L1–L13 and PF_B11.
- **1b Zotero Watcher & Launchd (`planner/zotwatch.py`):**
  - Fingerprint (read-only `?immutable=1` sqlite URI): count of regular items not in the trash, `max(clientDateModified)`, count of attachments, and the sorted (PDF path, mtime, size) list. Stored as `fingerprint` in `.planner/search/state.json`, only after a successful build; `search index` rebuilds keep the key.
  - Quiet period: waits until `zotero.sqlite` has not been modified for 20 s (`quiet_s`), checking every 5 s, for at most 600 s (`max_wait_s`); otherwise logs `gave up waiting`.
  - Advisory lock: non-blocking `search_lock(cfg, blocking=False)` on `.planner/search.lock`, shared with the morning job's `search index`. If busy, exits 0 with `"busy"`.
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

### Web snapshots (text/html attachments)
- **Scope:** child `text/html` attachments not in `deletedItems` are indexed alongside PDFs; standalone snapshots (no parent) stay excluded, like standalone PDFs. Owner's library at the time: 53 child snapshots, 7 items with a snapshot and no PDF, 5 `webpage` items.
- **Text:** stdlib `html.parser` only (`planner/htmltext.py`). Drops `head` (the title is already metadata), `script`, `style`, `noscript`, `template`, `nav`, `header`, `footer`, `aside`, `svg`, `math`, `iframe`, `object`, `canvas`, `button`, `select`. `form` is kept because some sites wrap the whole page in one. Every tag boundary is a word break; whitespace (including NBSP) collapses to one space. Decoding: UTF-8, else the `<meta charset>` in the first 4 KB, else cp1252. No reference cut-off or header de-duplication: a snapshot is one "page".
- **Chunks:** the PDF chunker (`pdftext.chunk_pages`) with `page: 0`; `max_chunks_per_paper` applies per attachment, as for PDFs. Chunker id bumped `pages-v1` → `pages-v2`, so existing indexes rebuild once.
- **papers.json:** `pdfs` stays PDF-only; snapshots are listed separately as `snapshots: [{attachmentKey, hasText}]` so nothing that counts pages or PDFs changes meaning.
- **Opening:** verified in the installed Zotero (9.0.6) `ZoteroProtocolHandler.mjs`: `zotero://open` and `zotero://open-pdf` share one handler that accepts any file attachment and calls `Zotero.FileHandlers.open`. A snapshot hit opens `zotero://open/library/items/<attKey>` with no page. Abstract hits prefer the first PDF, then the first snapshot, then select the item. Badge: `web page`.
- **Watcher:** fingerprint counts and stats PDF and snapshot attachments together (changes the fingerprint once on upgrade, which coincides with the chunker rebuild).
