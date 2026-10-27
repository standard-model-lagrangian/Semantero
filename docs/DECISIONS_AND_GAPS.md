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
| **B13** | New paper saved in Zotero → findable by keyword in the pop-up | ≤ 90 s (20 s quiet + 30 s throttle + ~10 s embed + reload); since 27 Oct: ~10–20 s (8 s quiet + keyword-only publish + reload), at once via Zotero's local API | not measured end to end (watcher log is now timestamped) | **UNTESTED** |
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
  - Quiet period: waits until `zotero.sqlite` has not been modified for 8 s (`quiet_s`, 20 s until 27 Oct), checking every 5 s, for at most 600 s (`max_wait_s`); otherwise logs `gave up waiting`.
  - Advisory lock: non-blocking `search_lock(cfg, blocking=False)` on `.planner/search.lock`, shared with the morning job's `search index`. If busy, exits 0 with `"busy"`.
  - Loop limit: up to 3 rounds if changes occur while indexing.
  - CLI command: `planner search watch-run` for launchd execution.
  - Launchd plist: `launchd/com.planner.zotero-watch.plist` with `WatchPaths` on `~/Zotero/zotero.sqlite` and `ThrottleInterval = 10` (30 until 27 Oct).
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

---

## Launcher (docs/LAUNCHER_SPEC.md): implementation log

Implemented 22 Oct 2026. **Not committed.** Automated: Python 130 tests, plugin 161, `launcher-core` 41 (+3 gated perf), Swift 60 (also clean under Thread Sanitizer), 84 conformance cases passing in Node, in the JavaScriptCore bundle and in Swift. **Not verified (needs a person at the screen):** the manual checks in `macos/CHECK.md`, notably S2 (paste into other apps), S3 (Spotlight calling the intent live) and S4 (Core Spotlight items showing in ⌘Space). The built panel was captured with `cacheDisplay` (`SEMANTERO_SHOW_PANEL=… SEMANTERO_SNAPSHOT=…`): layout, text, bold matches, detail pane and footer render; glass, SF Symbols and the status dot do not show up in that capture, so the look is unchecked.

### Spike S1: the ranker decision (measured here, M-series Mac, macOS 26.6, Xcode 27.1)

Real library (170 papers, 145 notes, 9,100 chunks, 1× = today) and the spec's 3× synthetic (500 papers × 50 chunks + 2,000 notes × 3 chunks, 1,024 dims). `make bench-app`; `semantero-bench --memprobe`.

| | Budget (1× / 3×) | Real 1×, **no** JIT entitlement | Real 1×, allow-jit | 3×, **no** JIT | 3×, allow-jit |
|---|---|---|---|---|---|
| M1 load (files → engine ready) | ≤ 1.5 s / ≤ 4 s | 1.43 s | **0.52 s** | 1.15 s | **0.39 s** |
| M2 keyword per keystroke, p95 incl. JSON bridge | ≤ 16 / ≤ 25 ms | 5.1 ms | **1.6 ms** | 14.6 ms | **4.9 ms** |
| M3 option A (all JavaScriptCore) hybrid, p95 | ≤ 40 / ≤ 80 ms | **255 ms** | **8.2 ms** | **938 ms** | **29.7 ms** |
| M3 option B (JSC + Accelerate vector pass), p95 | same | 6.4 ms | 2.3 ms | 25 ms | 8.7 ms |
| M5 JSON bridge alone, p95 | ≤ 2 ms | 0.2 ms | 0.2 ms | 0.2 ms | 0.2 ms |
| M7 Accelerate vector pass alone, p95 | | 0.8 ms | 0.6 ms | 2.7 ms | 2.0 ms |

**Decision (rule 1, then rule 2): option A, all JavaScriptCore**, with two conditions the app now enforces:
1. **The JIT entitlement is mandatory.** Without `com.apple.security.cs.allow-jit` JavaScriptCore runs interpreted (even ad hoc signed, even without the hardened runtime): the vector loop is 30× slower and load 3× slower. `macos/Resources/Semantero.entitlements` carries it and `bundle.sh` always signs with it. An unsigned or plain `swift run` build is slow; that is expected.
2. **`JSC_useFTLJIT=0` and `JSC_useDFGJIT=0`** (`JSCRanker.configureProcess()`, called before the first JavaScriptCore use). With the default tiers the process held 500–800 MB; without the top two tiers the steady state is 112–200 MB with load, keyword and hybrid times unchanged (hybrid A 7.6 ms at 1×, 28 ms at 3×).

Option B (`AcceleratedRanker`) is built and passes the same 84 conformance cases; it is the ready fallback if M3 ever regresses (`rankerOption` in `AppModel.swift`). Option C (a Swift port) is not needed.

M4 (memory, budget ≤ 250 MB at 1×): **met in the running app, by a workaround I do not fully understand.** Parsing 15 MB of chunk text and building the index churns ~1 GB; JavaScriptCore keeps that as dirty pages until a virtual machine is torn down. In a probe, the *third* load in a process drops the footprint from ~900 MB to ~150 MB; the second does not. `JSGarbageCollect` (an asynchronous hint), `malloc_zone_pressure_relief`, and a throwaway VM do nothing. So `AppModel.start` performs the first load and then **two compaction reloads** (`IndexReloader.forceReload()`, 4 s apart, old engine serving queries throughout); the running app then shows `footprint` = 112 MB. This is empirical and may change with a macOS update; `make bench-app` plus `semantero-bench --memprobe` re-checks it. `ps` RSS reads high (1.1 GB) because it counts reclaimable pages; `footprint` / Activity Monitor "Memory" is the real figure.

Things tried and ruled out for memory: typed-array postings in `bm25.ts` (kept: it is correct and faster to build, JSC footprint unchanged), removing the redundant hash operations in `BM25Index.build` (kept: −22 % build time in V8), `JSC_forceRAMSize` / `JSC_smallHeapRAMFraction` / `JSC_useGenerationalGC` (small or no effect), `$vm.gc()` (not available in the system JavaScriptCore).

Other S1 fixes: JSON is decoded natively in Swift and passed as strings (the JS UTF-8 loop cost 0.6 s per load); every JavaScriptCore call runs in an `autoreleasepool` (without it each replaced engine stayed alive: +740 MB per reload).

### Spikes S2–S4 (cannot be settled without a screen)

- **S2 (non-activating panel + ⌘V):** built as specified (`NSPanel` `.nonactivatingPanel`, `CGEvent` ⌘V after a 60 ms settle, copy-only fallbacks). Untested in Mail/Teams/Chrome/Claude/Terminal. `osascript` could not drive keystrokes (no Accessibility permission for this shell).
- **S3 (Spotlight action):** `OpenResultIntent`, `SearchResultEntity`, `SearchResultQuery: EntityStringQuery`, `AppShortcutsProvider` ("Search Everything in Semantero"). `bundle.sh` now produces `Metadata.appintents` (xcodebuild for the `.swiftconstvalues`, then `appintentsmetadataprocessor`; the metadata lists the three intents, the entity, the query and the phrases). Whether Spotlight calls the query live per keystroke is unknown until you try (N-M13).
- **S4 (Core Spotlight entries):** `SpotlightDonor` + `CoreSpotlightIndex` + `NSUserActivity` handling are in; the app ran here and donated its items to your Spotlight index (domains `papers`, `notes`; turn them off in Settings, which deletes them). Not checked in ⌘Space.

### Budgets (acceptance table)

| ID | Target | Measured |
|---|---|---|
| L2 | keyword per keystroke ≤ 33 ms p95 | 1.6 ms (app engine, real library); view update not measured |
| L3 | semantic after the pause ≤ 300 ms p95 | scoring + merge 8 ms; embedding ≈ 190 ms (B9, Ollama warm) |
| L4 | background load ≤ 1.5 s at 1× | 0.56 s (+ two compaction reloads, background) |
| L5 | `notes index`, nothing changed ≤ 1.0 s, 0 bytes written | covered by test 22 (no writes); real vault 0.1 s |
| L7 | memory ≤ 250 MB at 1× | 112 MB `footprint` after start-up compaction |
| L1, L6, L8 | hotkey → panel, note saved → findable, ⌘↵ → pasted | **not measured** (manual: N-M1, N-M11/16, N-M4) |
| Eval | paper `finding` recall@5 in All within 0.03 of Papers | 1.00 vs 1.00 (drop 0.00): PASS. **Note:** recall@1 for `finding` drops 0.96 → 0.88 in scope All (notes sometimes take the top slot). No `expect_note` queries exist yet, so note recall is unmeasured (phase 0, yours). |

### Assumptions and things the spec left open

**Python (notes index)**
- State is a content signature plus a vector cache keyed by the hash of the embedded text, instead of the spec's per-note `{mtime, size, sha, rows}`. Same observable behaviour (renames, touches and unrelated edits re-embed nothing); simpler.
- `mtime` is stored in each note's `papers.json` entry, so merely touching a note rewrites the index (without re-embedding). A touch inside the same second does not.
- Chunk text does not include its heading, and the embedded text is exactly the stored text (as for papers). Headings are therefore not searchable by BM25 and not in the embedding. First tuning candidate if `note-finding` recall is low.
- Short-section merging, where the spec was ambiguous: a short section merges into the next section only if that one is the same or **deeper** level; a short lead with no heading takes the next section's heading; a shallower next section is not merged into; a short trailing section merges back. A heading with no text is dropped before merging.
- Daily-note title wins over the first H1 (frontmatter `title` wins over both). A note counts as `daily` only if its folder is `daily_folder` (the vault root today).
- Frontmatter parser is minimal (scalars, `[a, b]`, `- item` lists). "Malformed" = a line that is not `key: value`, a list item or an indented continuation, or an unclosed `[` / quote; the whole block is then body text.
- Tags must start with a letter (`#3d-culture` is not a tag; Obsidian agrees); aliases are folded into `tags` so they are searchable.
- The tick runs the notes index after the morning work on **every** 5-minute launchd run (also when the day's run was skipped, offline, etc.) via `finally`, non-blocking lock. A failed run is logged; the "⚠ Setup" warning comes from `planner doctor`'s notes check (missing, >1 day old, model/dims mismatch, degraded >1 day, bad glob), which the morning run already includes. `notes_tick_warning` only decides whether the log line says "warning".
- A Ollama outage retries on every tick (one attempt, no backoff).
- `doctor`: "launcher app not installed" is an informational note on an OK check (`Result(ok=True, message=…)`); the login-item registration is **not** checked (no cheap API).
- Literature notes match by frontmatter `citekey` or by file name. Your notes named like `LeSavage 2022 Next generation cancer organoids.md` do **not** match a citekey, so today only 1 of your notes is collapsed into its paper.
- A git-ignored `config.local.toml` holds the owner's personal `[notes].exclude` additions (private notes that must never be indexed or donated to Spotlight). The first launchd tick after this code landed indexed the vault before that exclusion existed; the exclude was added and the index rebuilt, and the final index contains none of the excluded notes. Lesson: set up `config.local.toml` **before** enabling `[notes]`.
- `index_small` (the plugin fixture) got `file` fields and `zotero_storage`; two snapshot tests that pinned the old exact entry shape were updated.

**TypeScript (`launcher-core`)**
- Empty query: recent notes (limit ≤ 10) from the *index* (by `mtime`), not a live vault scan (the spec's `recent.ts`). Scope Papers + empty query returns nothing.
- A paper row whose literature note won shows the note's heading/snippet and `↵` opens the note, but `⌘↵` / file actions still use the **paper's PDF**; the citation actions use the winner's text.
- `ResultVM` gained `openLabel` (footer text). Note citations drop a leading `Title › ` when the note's first H1 equals its title.
- A corpus with a different `query_instruction` is treated like a model/dims mismatch (keyword-only).
- `Engine.lookup(ids)` and `semantero.shouldRunSemantic()` were added to the API (Spotlight id resolution; the gating rule stays single-sourced in `rank.ts`). `interleaveSemantic` engine option implements the spec's per-corpus-instruction fallback for `eval.ts --per-corpus-instruction`.
- Dates in view models use the machine's time zone; tests and conformance run with `TZ=UTC` (`make test-launcher` sets it).
- The engine refactor (`rowScores` + `semanticFromRowScores`) and the BM25 changes live in the plugin's shared files, so the plugin's `main.js` must be rebuilt (done by `make check`'s `build`).

**Swift**
- `swift-tools-version 6.2`, macOS 26 minimum, no packages. Swift Testing is used because Xcode is installed.
- Settings: `UserDefaults` suite is the app's own; vault path defaults to `~/Documents/Obsidian Vault`.
- Hotkey registration uses Carbon `RegisterEventHotKey` (needs no permission); `⌥Space` may collide with other apps (a failure shows a toast).
- Login item registers only when the app runs from `/Applications` or `~/Applications`.
- Panel closes on losing key status, on Esc, and on clicks outside. `panelWillShow` clears the query after 60 s.
- Signing: **0 Apple Development identities are in your keychain**, so `make app` ad-hoc signs. That works, but the Accessibility permission will have to be re-granted after every rebuild until you create a free "Personal Team" certificate (Xcode → Settings → Accounts). `bundle.sh` picks one up automatically (or `SEMANTERO_SIGN_IDENTITY`).
- Debug aids (documented in AGENTS.md): `SEMANTERO_DEBUG=1`, `SEMANTERO_SHOW_PANEL="<query>"`, `SEMANTERO_SNAPSHOT=<png>`.

### Spec deviations (all small)
- Per-note `state.json` replaced as above. `docs/LAUNCHER_SPEC.md` still describes the original.
- The bundle exposes `lookup` and `shouldRunSemantic`; `RankerStatus` has an optional `timings` field (diagnostics).
- `make test` now includes Swift; `make test-swift-tsan` is separate.
- Status in LAUNCHER_SPEC.md: implemented, with the checks above outstanding.

### Review fixes (22 Oct 2026, after the first review pass)

| Finding | Fix | Verified by |
|---|---|---|
| An unreadable folder or a missing vault silently emptied the notes index (the next good run re-embedded everything) | `notesindex.scan` raises `VaultUnreadable` on any folder it can't list (excluded folders are never listed, so they can't fail); a vault that suddenly has no notes is refused unless `--full`; the tick logs it and keeps the old index | `TestUnreadableVault` (5 tests) |
| A touch with no edit rewrote the whole index → the app reloaded both corpora every tick while you wrote | modified times are left out of `content_hash`; they are refreshed whenever content changes | test 24 (no rewrite, no reload), `test_edit_after_a_touch_records_fresh_mtimes`; live: touching a note → "no changes", app did not reload |
| A search typed during a reload waited ~0.76 s | engines are built on their own JavaScriptCore VM in a detached task; the query actor keeps serving the old engine; the load started last wins; `IndexReloader` runs one check at a time (a livelock in the first version of this was caught by its test and fixed) | `ReloadTests` (search during a build < 100 ms; last load wins; 6 concurrent checks → 1 load) |
| Settings (vault, Ollama URL, result limit, Spotlight toggles) needed a restart | `SettingsEffect.between(old, new)` decides what to redo; `AppModel.applySettings` reopens the vault (new reloader and watcher), rebuilds the embedder, re-runs the query with the new limit, re-syncs Spotlight | `SettingsEffectTests` |
| ⌘↵ / ↑↓ risked being eaten by the search field | key handling moved onto the field itself; the ⌘K menu's field handles its own keys; focus returns to the search field when the menu closes | `make app-selftest`: 16/16 steps pass in the real app |
| After semantic results re-ranked the list, the highlight stayed on the old top result (↵ opened the second-best match) | the selection follows the top result until you move it (arrows or a click); a new query resets that | `untouchedSelectionFollowsTheNewTopResult`, self-test step "top result selected after semantic re-rank" |
| Permission errors showed a raw error | reading the index without permission says to allow Files and Folders (Documents) in Privacy & Security | `unreadableIndexGivesAnActionableMessage` |
| Settings window opened behind other apps; Quick Look closed the panel; rows without a file could be dragged as "/" | Settings… activates the app first; the panel stays open while Quick Look is up; rows without a file are not draggable | manual (CHECK.md) |
| JavaScriptCore re-grows memory minutes after compaction with nothing running (110 MB → 300–800 MB, once, timing varies; reproduced in the bare benchmark, so it is the framework, not the UI) | `MemoryWatchdog`: every minute, if the panel is hidden and the footprint is over 350 MB, swap in a fresh engine (at most every 10 min; costs no search latency now) | `MemoryWatchdogTests`; live 5-minute run below |

Not fixed (by choice, see CHECK.md): JavaScriptCore can't be told to stop the idle re-growth (its GC options are not exposed in the system framework); Spotlight items are not re-donated if macOS rebuilds its index until something changes; tags starting with accented letters and notes in symlinked folders are not indexed; a hung (not refused) Ollama can hold a tick for up to 120 s per batch; `make check` needs Xcode and `npm install` in `launcher-core` (setup.sh doesn't do the latter).

### First hands-on feedback (22 Oct 2026)

- **⌘↵ into Outlook on the web (Firefox) showed "Something went wrong while the document preview was being created".**
  Measured in a throwaway Firefox 158 profile driven over Marionette with a real native ⌘V: the page receives exactly
  one `File`: the right name, `application/pdf`, all 5,196,783 bytes, starting `%PDF-1.7`. The clipboard holds what
  Finder puts there for a copied file (`public.file-url` + `NSFilenamesPboardType`). So the attachment is the real PDF;
  the message is Outlook's online preview service failing on it. Teams (same mechanism) works. Nothing to change in
  the app; CHECK.md 3.3 now asks to compare with Outlook's own Attach button.
- **⌘K menu overlapped the results and was unreadable.** It was a glass card nested inside the panel's glass, which
  renders nearly transparent. Now: an opaque card (window background colour, border, shadow) drawn outside the glass
  container, over a dimmed panel, anchored bottom-right above the footer, with the result it acts on as a header, an icon
  per action, aligned shortcut glyphs, a scrolling list (max 300 pt) that follows the selection, and the panel grows
  when it is too short for the menu. Checked by capture (`SEMANTERO_SNAPSHOT_ACTIONS=1`).
- Test modes (`SEMANTERO_SELFTEST`, `SEMANTERO_SNAPSHOT`) no longer register the hotkey or the login item, so they can run next
  to the installed app. The self-test waits for the semantic merge instead of a fixed 1.5 s (one flaky run in ten).

### Memory pass (22 Oct 2026)

Reported: the installed app at 700–820 MB. `vmmap` showed 660 MB of *live* allocations in JavaScriptCore's allocator
(1.39 M allocations). New tooling: `JSCPrivate` (exported but unheadered JavaScriptCore functions: live heap
statistics, object counts by type, a synchronous full GC) and `semantero-bench --heapprobe / --parseprobe / --dropprobe /
--notesprobe`.

**Findings and fixes, in order of effect**

| Finding | Fix | Effect (real library: 171 papers / 8,839 chunks, 145 notes) |
|---|---|---|
| `JSGarbageCollect` only *schedules* a collection: after a build the churn (~1 GB) stayed resident; the old "two engine swaps" worked only because tearing down a VM forces a collection | each build ends with `JSSynchronousGarbageCollectForDebugging` on the build thread (`JSCPrivate.collectNow`); start-up compaction swaps removed; watchdog kept as a single-reload safety net | start-up footprint 783 MB → **143 MB within 5 s** |
| BM25 kept 4 Maps × 65k terms and 2–4 small typed arrays per term (529k live objects) | postings in compressed-sparse-row form (`offsets`/`ids`/`scores` per list), term ids = positions in the sorted vocabulary, document frequency in an `Int32Array`; build uses term ids and per-chunk typed arrays. Same scores and order (plugin goldens, 84 conformance cases) | objects 529k → 111k; heap (incl. external) 122 → 98 MB |
| Vocabulary words were slices of lowercased chunk copies, pinning them | one JSON round trip makes flat copies | 98 → 89 MB |
| Chunk texts as JS strings: 30 MB (81 % of chunks contain a non-Latin-1 character, so whole strings are 2 bytes a character) | `TextStore`: all chunk texts as WTF-8 in one byte array, decoded on demand by a getter on each chunk (shared core, so the plugin gets it too); repeated attachment keys and headings interned | 89 → 74 MB; settled footprint **102 MB** |
| A notes-only change rebuilt both corpora (0.5 s, a ~450 MB transient) | `semantero.loadNotes` / `NotesReloading.reloadNotes`: swap only the notes corpus in the current engine (21 ms incl. a 1.2 ms synchronous GC), for notes indexes up to 4 MB of chunks; bigger ones take the full off-actor rebuild | repeated note edits: flat at **110 MB** (without the GC: +15 MB per edit) |
| The all-JavaScriptCore vector pass measured 20–54 ms per query with the reduced JIT tiers (budget 40) | the app runs option B (Accelerate vector pass): 2.3–3.0 ms p95. Option A remains, conformance-tested | hybrid p95 ~3 ms |

What the remaining ~100 MB is (drop probe): paper vectors 37 MB (memory-mapped `vectors.f32`: clean file pages,
counted by JavaScriptCore as external memory but mostly not in the process footprint), keyword index 17 MB, chunk
records + packed text 16 MB, notes 3 MB, other JS ~2 MB; the rest is the Swift/SwiftUI app.

**Obsidian plugin** (same core, V8, real paper index): JS heap 80 → 12 MB, array buffers 49 → 67 MB, total live
129 → 79 MB; build time unchanged (~760 ms).

**Python**

| Job | Before | After | Fix |
|---|---|---|---|
| `search index` with nothing changed (daily, and on Zotero changes) | 0.62 s, 768 MB peak | **0.05 s, 34 MB** (a full reconcile, at least weekly: 0.21 s, 400 MB) | (1) the watcher's library fingerprint (items, edits, every attachment's path/size/mtime; 0.05 s) now short-circuits `build_index` itself when it matches the last successful build, the index isn't degraded and model/dims/chunker match; a full reconcile still runs if the last one is over 7 days old, in case an edit didn't bump `clientDateModified`. (2) the reconcile itself: cached vectors were Python float lists (~32 bytes a number) and the vector file was held 4×; now zero-copy `memoryview` slices, `array.fromfile`, `frombytes(view.cast("B"))`, hashing in place |
| 5-minute morning tick | 0.38 s | 0.07 s, 31 MB | the paper index's fingerprint shortcut |
| `search stats` | 0.12 s, 213 MB | 0.05 s, 33 MB | chunk count from the manifest instead of loading every chunk |
| 5-minute tick, notes index no-op, watcher no-op | < 0.4 s, ~28 MB | unchanged | already cheap |

**Ollama** (not Semantero's process, but loaded on its behalf): the embedding model's process holds ~400 MB footprint
(~950 MB resident) while loaded. `keep_alive` was 30 min everywhere; now 5 min by default (app setting "Keep the model
loaded for", `config.toml` `[search] keep_alive`, the plugin's `DEFAULT_KEEP_ALIVE`). The app and the plugin warm the
model when their search opens, so the cold start (measured 0.85 s; keyword results are instant anyway) is mostly hidden.

**Net, the installed app on this library:** 700–820 MB → **~110 MB**, stable over idle time and repeated note edits;
start-up settles within 5 s instead of needing two engine swaps.

Not done (judged not worth it): Float32 posting scores (−4.6 MB, would risk tie order against the goldens); moving
chunk text out of JavaScript entirely (Python would have to write a second format); a resident query server.

### Two setups in one repo (22 Oct 2026)

`launcher-app` merged into `main`. The repository serves two setups: **Obsidian only** (plugin + Zotero watcher;
`./setup-search.sh`) and **Global** (+ notes index + Semantero.app; `make install-global`). `config.toml` now ships
with `[notes] enabled = false`, so the Obsidian-only setup never reads notes and `planner doctor` doesn't expect a
notes index; the global setup opts in in `config.local.toml` (test `TestShippedConfig` pins the shipped default).
`make install-global` refuses to run until the notes index is enabled, so private-note excludes are set first.

### Embedding installs (23 Oct 2026)

Plan: [EMBED_BENCH_PLAN.md](EMBED_BENCH_PLAN.md); guide: [EMBED_INSTALLS.md](EMBED_INSTALLS.md). The plan's separate
side-by-side bench app was replaced, at the owner's request, by **profiles**: one index per model, switched in the real
plugin and app (`planner profile list|build|use`, `profiles.toml`, `<data_dir>/profile.json` → `[search]` overrides in
`config.load`). A switch is two folder renames per corpus under both index locks; only the live profile is kept fresh.

- **Lineup:** Qwen3-Embedding 0.6B (Q8_0, 1024), 4B (Q8_0, 2560), 8B (Q4_K_M, 4096; Q8_0 is 8.1 GB), and
  pplx-embed-v2-late-0.6b. The 9B pplx models don't fit next to anything else on 16 GB and were not tried.
- **pplx runs frozen** on llama.cpp `b11829` (`pplx/`): the converter needed a text-only staging copy and two metadata
  keys (bidirectional attention, pooling none); the Dense projection, skiplist and normalisation run in `pplxd`. Parity
  against sentence-transformers 6.2.0: ids 70/70, per-token cosine ≥ 0.99993 at Q8_0, top-1 20/20.
- **Late interaction in a one-vector-per-row index:** `vectors.f32` holds each row's mean token vector, whose SHA-256 is
  the key into an append-only token cache outside the vault. No change to the index format, the incremental reuse or
  the swaps; manifests of pplx indexes add `backend` and `backend_url`. Readers get per-row MaxSim scores from `pplxd`
  (`/rowscores`, checked against the loaded `content_hash`) and rank them with the existing row-score paths:
  `hybridSearchFromScores` / `semanticFromRowScores` in the plugin, `hybridFromRowScores` in the app (now on `Ranker`).
- **Scores:** pplx returns MaxSim / query tokens. `relatedMinScore` stays at its 0.6B calibration for every profile.
- **numpy** is a dependency of `pplxd` only, in its own venv; the main venv still has only `anthropic`, and the
  service's tests run under `make test-pplx` (skipped when that venv is missing).
- **Build cost** dominates: on the M4, Ollama embeds the 4B at ~45–65 s per batch of 32 chunks (~4 h for the library),
  the 8B slower. Builds run one at a time.
- Open: which model wins (the owner judges by use); if a bigger Qwen wins, whether its 1024-dim Matryoshka cut (derivable
  from stored vectors) is as good; if pplx wins, a Swift MaxSim (Accelerate) instead of the service is possible but
  not needed for speed.
- **4B and 8B dropped (same day, before any was built):** on the M4 the 4B embeds ~200 tok/s (a 4–6 h library build,
  the 8B 8 h+) and holds 4.4–5 GB while loaded. Whatever they gain over the 0.6B is marginal next to that: new papers
  and notes would need scheduled embedding instead of being indexed as they arrive. The lineup is now the current 0.6B
  vs pplx-embed-v2-late-0.6b, two models of the same size with different designs (one vector per row vs per token).

### Trailing space changed the results (24 Oct 2026)

Reported: the same query gave different results with and without a space after the last word. Reproduced on the real
index (173 papers, 152 notes): `viscoelastic hydrogel` shared 7 of its 15 keyword results with `viscoelastic hydrogel `;
`neural stem` ran semantic search only with the space. RRF only passed differences through; three things caused them.

- **Keyword side (by design until now):** a trailing space marked the last word complete, so it matched exactly instead
  of by prefix (`hydrogel ` lost `hydrogels`). Now the last word always prefix-matches, whatever follows it (spaces,
  tabs, newlines, punctuation); only a trailing stopword finishes it. To keep prefix matching from rewarding rare
  variants, a longer word is scored as if it were no rarer than the typed word (or, while that isn't a term, the most
  frequent expansion), and counts half when the typed word is a term. Before, `transfer` let `transferrin` (df 3) beat
  `transfer` (df 231) and put an imaging paper first for `mitochondria transfer`; `cells` expanded to 58 terms such as
  `cells121` (citation numbers glued on by PDF extraction). Without the half weight `cell` tied with `cellular` and
  the tie went by index order.
- **Semantic gate:** "2 complete words" counted a trailing space. Now: 2 words, the last one 3+ characters or a digit
  (where it starts to count for keyword search), or 12+ characters after trimming.
- **Embedding (a bug):** the app (`QueryController`, `IntentSearchService`) and the plugin (modal, `@@`) embedded the
  raw text, so `Query: neural stem ` got its own vector (cosine 0.991–0.998 to the trimmed one, enough to reorder the
  top 5). Both now embed `semanticText(q)` (trimmed, inner whitespace runs made one space; `rank.ts` and Swift).

Checked after the fix: 1,744 whitespace variants of 872 queries (every 1–3-word title prefix of the papers and notes,
plus the eval set) and 119 hand-picked ones (double, leading, tab, newline, NBSP) give identical results and snippets,
keyword and hybrid with the real Ollama embeddings. New conformance cases (trailing and doubled spaces) pin it for the
app's ranker; the app self-test types a space after `stress relaxation` and gets the same merged list.

Quality: eval set unchanged (keyword MRR 0.91, hybrid 0.94). On 556 title-derived 2–3-word queries, keyword MRR
0.7759 (old: 0.7731 without the space, 0.7759 with), hybrid 0.8250 (old: 0.8221 / 0.8319). Most of the remaining gap
to "old with space" is the embedding: oddly, embedding *with* a trailing space scored 0.8301 here, but it was better
for papers (+0.012) and worse for notes (−0.007) and identical on the eval set, so it reads as noise; the trimmed text
stays. Uncapped expansion (0.8270 hybrid, 0.7731 keyword) was not kept: it keeps the `transferrin` failure.

Still differs, on purpose:
- **Case and punctuation change the hybrid results** (`Neural Stem`, `neural stem?`): keyword ranking and the gate
  ignore them, but the embedding model reads them as content. Not normalised.
- **A short last word can no longer be forced with a space:** `il ` no longer matches `il`, and `vitamin d` /
  `hepatitis b` (under 12 characters, last word one letter) don't run semantic search. Before, typing the space did
  both. Not in last place, short words match (`il 6`).
- **Only the last word is a prefix:** `hydrogel cells` matches `hydrogel` exactly, `cells hydrogel` also matches
  `hydrogels`. Typing a short next word turns the previous one exact (`stiff` → `stiff g`).

Open:
- **Junk terms stay in the vocabulary** (`cells121`, `hydrogelhydrogel`): the idf cap makes them harmless for ranking;
  splitting glued citation numbers at index time would also split real terms (`covid19`, `caco2`), so it is not done.
- **Self-test run without notes, not reproduced (1 of 8 runs):** the first self-test after a fresh build showed 0
  recent notes and, for `stress relaxation`, exactly the papers-only hybrid order, as if the notes corpus were missing
  for a few seconds; status still said 152 notes. Seven later runs (a fresh build, a cold Ollama, one during a notes
  rebuild) passed. Worth watching for if recent notes ever come up empty.

Follow-up, same day: typing or deleting the space still made the list change for a moment. Every keystroke re-ran
the query, which shows keyword-only results at once and the merge 200 ms later; the final list was the same, but the
keyword-only one flashed in between. Now an edit that changes only whitespace re-sends the list on screen (and lets a
pending merge land under the new text) in the app (`QueryController`), the plugin's modal and `@@`; the selection
stays put. A second source of the same flash: when the 5-minute job re-indexes an edited note, the app reloads and
re-ranks the open query. A forced re-rank of the same query now keeps a merged list on screen until the new merge
replaces it. The app self-test samples the list every 20 ms for 0.8 s after typing and after deleting the space.
Note that the self-test opens a real panel that takes keyboard focus: typing elsewhere while it runs lands in it
(one run got `ath do` before `stress relaxation`), which may also explain the run without notes above.

### Renamed to Semantero (24 Oct 2026)

The repository was already called Semantero; the app, plugin and code still said Daito. Now everything does:
`Semantero.app` (bundle id `dev.semantero.app`, executable `Semantero`), SwiftPM targets `Semantero`, `SemanteroKit`,
`SemanteroBench` (`semantero-bench`), the plugin `semantero` ("Semantero", CSS classes `semantero-*`, view type
`semantero-related-papers`), the bundle's global `semantero`, `SEMANTERO_*` environment variables, and one support
folder, `~/Library/Application Support/Semantero/`, for the app's `spotlight.json` and the pplx service's files. (Two
folders, `Semantero` for the app and `semantero` for pplx, would be the same folder: macOS names are case-insensitive.)

Migration, done once on the owner's Mac:
- **App settings** are imported on the first launch under the new id (`SettingsStore.importLegacySettings`, only the
  app's own keys, never over a value already set, once). Spotlight entries are not reused: the old app was run once
  with its Spotlight options and launch-at-login off, which deleted its 325 entries and its login item, then removed
  with its preferences, cache and state folder. A disabled "Daito Search" row can linger in Login Items until macOS
  tidies its background-items database.
- **pplx** files moved from `Application Support/daito/` into `Application Support/Semantero/`; `runtime.json` now
  points at the moved llama-server (it is not in `SHA256SUMS`; the binary is, by content), and the launchd job was
  reinstalled. The uv venvs hold no absolute paths, so they moved as they were.
- **Obsidian:** the plugin folder link is now `.obsidian/plugins/semantero`; `community-plugins.json`, the hotkey and the
  saved Related panel in `workspace.json` were switched to the new id. The plugin has no `data.json`, so no settings.
- The Swift tests made a new preferences domain per run and never removed it (107 `daito-test-*.plist` files). They
  now reuse one fixed, emptied domain per test.

### Time to cite a new paper (27 Oct 2026)

Measured before: a paper became citable 1–2 min after Zotero finished adding it; three papers added 23:37–23:41 on
26 Oct were in the index at 23:49. Embedding is most of it (pplx ~0.38 s a chunk, ~90 chunks a paper, timed on 32
real chunks), and citing needs none of it. Changes:
- **Keyword-only publish first.** `watch_run` calls `build_index(keyword_only=True)`, which writes the same degraded
  index a down embedder does, then a normal build embeds it. A metadata-only change has nothing to embed, so the first
  build is the whole build. Costs: PDF text extracted twice for new attachments (≤0.4 s each), one more ~25 MB index
  write, and readers reload twice (the plugin parses `chunks.json`, 19 MB, once more; peak memory unchanged, since the
  old index is dropped on swap as before). A retry of a degraded index embeds directly.
- **Quiet window 20 s → 8 s, launchd throttle 30 s → 10 s.** The post-build fingerprint recheck (up to 3 rounds)
  already covers a Zotero write that lands after the window. ~100 launches in 3 days, each a fingerprint check of well
  under a second, so a shorter throttle costs little.
- **Retry probe follows the backend.** The hourly retry of a degraded index probed Ollama even on the pplx profile;
  it now asks pplxd's `/health` (`zotwatch.embedder_up`).
- **pplxd asks llama-server for 4 texts at a time** (`HIDDEN_GROUP`), not 32. Per-token hidden states come back as JSON,
  ~250 MB for 32 texts, which took ~1 GB to parse and was cut off three times since 25 Oct (`IncompleteRead` in
  `logs/pplxd.log`). Speed is the same (12.0 s vs 12.4 s for 32 chunks).
- **Zotero local API fallback** (`src/zoterolive.ts`): `@@` and the search modal ask
  `localhost:23119/api/users/0/items/top?q=` 250 ms after typing (queries of 3+ characters) and append up to 3 papers
  the index doesn't list, marked "new in Zotero"; citing one inserts the citekey and creates the literature note as
  usual (no PDF link until the index has it, so Enter selects the item). Zotero ships with the local API off; while it
  is off or Zotero is closed, a failed request stops lookups for a minute. Setting: "Ask Zotero for new papers".
- Watcher log lines carry a timestamp and the build's duration, so the next measurement can be end to end.

