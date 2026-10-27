# Paper search in Obsidian: integration spec (test-driven)

How paper search fits into everyday writing in Obsidian. Three proposals:

1. **Rough edges**: a hotkey that doesn't clash, new Zotero papers searchable within about a minute, literature notes created when you cite, settings kept out of git.
2. **Cite while writing**: type `@@` in any note to search papers inline and insert a citation.
3. **Related papers panel**: a right-sidebar list of papers close to what you're writing, refreshed when you ask.

Status: implemented; kept as the design record (decisions made while building it are in [DECISIONS_AND_GAPS.md](DECISIONS_AND_GAPS.md)). Builds on [SEARCH_SPEC.md](SEARCH_SPEC.md) (index, ranking, evaluation) and follows [AGENTS.md](../AGENTS.md).

## Principles

- **Typing never waits.** No keystroke in the editor or the search pop-up may block for longer than one frame (16 ms). Anything slower runs asynchronously and merges in when ready.
- **Nothing pushes reading at you.** The panel refreshes when you ask. Search only runs when you invoke it.
- **Vault writes happen only from your actions.** A literature note is created only when you cite or open that paper, and never overwrites an existing file. The background watcher writes only inside `.planner/search/`.
- **Only the paper's own words appear.** No generated text, as in SEARCH_SPEC.
- **One search engine, three entry points.** The pop-up, the `@@` suggestions and the panel share a single index in memory and the same ranking code.
- **Tests first, budgets measured.** Every behaviour has a named test. Every performance budget has a benchmark that fails when it's exceeded.

## Baseline (measured 20 Oct, M4, 16 GB, real index: 163 papers, 7,568 chunks, 1,024 dimensions)

| Measurement | Value | Verdict |
|---|---|---|
| Keyword search, completed words (`"stiff "`, `"viscoelastic"`) | 0.5–3 ms | fine |
| Keyword search, 1-letter unfinished word (`"s"`, `"c"`) | **650–705 ms** | **blocker:** the first letter of every word freezes the list |
| Keyword search, `"stiff g"` | **255 ms** | blocker, same cause |
| Keyword search, `"a b c d e"` | 354 ms | blocker |
| Semantic scoring: dot product with all rows + sort | 7 ms (p50), 13 ms (p95) | fine; the sort is unnecessary |
| Index load in Node: JSON parse / vectors / BM25 build | 22 / 12 / **299 ms** | the BM25 build must not run during Obsidian startup |
| Heap after load | 119 MB (235 MB RSS) | acceptable; budget below |
| Query embedding, 0.6b, short query | 44 ms (p50) | fine |
| Passage embedding, about 1,600 characters | ~200 ms (p50) | fine for a button press |
| `planner search index` with 7 new papers (162 texts) | 35 s | about 5 s per paper |
| `planner search index` with nothing changed | 0.4 s, **but rewrites the whole index** | **blocker for the watcher:** each run changes `built_at`, so the plugin reloads 45 MB and iCloud re-uploads it |

Cause of the keyword spikes, in `src/bm25.ts` around line 171: an unfinished last word is expanded to *every* vocabulary term that starts with it. One letter matches thousands of terms, and each one gets a full posting-list merge.

## Phase 0: prerequisites (fix before building anything else)

### 0.1 Bound prefix expansion (`src/bm25.ts`)

- The vocabulary is kept as a **sorted array** built once at load. A prefix lookup is a binary search for the range: O(log V + matches).
- **An unfinished word shorter than 3 characters is ignored,** unless it contains a digit and is a vocabulary term (`"3d"`, `"6"`), in which case it matches exactly. So `"s"`, `"st"` and `"il"` contribute nothing until the third letter. (Changed 24 Oct: a space no longer finishes a word, so `"il "` is ignored too; not in last place, as in `"il 6"`, it matches exactly.) (Changed 20 Oct: the real vocabulary contains single letters such as `s` and `c`, from "cell's" and similar, so the earlier "any complete term" exception made `"s"` match 150 papers.)
- **At most 64 expansions per prefix.** If more terms match, keep the 64 with the highest document frequency. Frequent terms are what a person is most likely typing, and this bounds the work.
- Postings are merged into a reused `Float64Array` of per-paper scores, not a `Map`, to avoid garbage-collection pauses.
- Results are ranked with a partial top-k (`limit` × 4 candidates), not a full sort.

### 0.2 A no-op index run writes nothing (`planner/searchindex.py`)

- The output content (papers, chunks, row order, and a hash of the vector bytes) is hashed into `manifest.content_hash`.
- If nothing was embedded and the new `content_hash` equals the old one, **write nothing**: no temporary folder, no rename, and `built_at` stays the same. Print `search index: no changes (0.4s)`.
- The plugin reloads only when `content_hash` changes (it falls back to `built_at` for indexes from before this change).

### 0.3 One shared engine (`src/engine.ts`, `src/indexstore.ts`)

Search logic currently lives inside `PaperSearchModal` (`main.ts`, lines 251–449). It does O(n) lookups for every result: `keywordRes.find` per row, `chunks.find(ch => ch.row === …)` per result, and `paperRowRefs` built in O(papers × chunks). Move it out:

- **`indexstore.ts`**: loads and checks the index once per plugin.
  - Precomputes `rowToChunk: Int32Array`, `paperChunkRows` in O(chunks), and the BM25 index.
  - `ensureFresh()` reads only `manifest.json` (about 300 bytes), at most once every 10 s. It reloads in the background when `content_hash` changes. Searches keep using the old index until the new one is ready, then swap with a single assignment.
- **`engine.ts`**: pure functions, no Obsidian imports.

```ts
interface LoadedIndex { papers; chunks; vectors: Float32Array | null; dims; rowToChunk: Int32Array;
                        paperAbstractRow: Int32Array; paperChunkRows: Int32Array[]; bm25: BM25Index; manifest }
interface Hit { paper: number; score: number; source: "keyword" | "semantic" | "both";
                snippet: string; page?: number; attachmentKey?: string; fromAbstract: boolean }

keyword(ix, query, limit): Hit[]                                        // sync, ≤ 16 ms (budget B1)
semantic(ix, qVec, query, opts: {limit, exclude?: Set<number>, minScore?: number}): Hit[]
hybrid(keywordHits, semanticHits, limit, k = 60): Hit[]                 // RRF, unchanged behaviour
```

- **Semantic scoring:** one pass over all rows. Each row's score updates its paper's maximum through `rowToPaper`. Then a partial top-k over papers. No full sort of the rows.
- **Snippets** are built only for the returned hits, using `rowToChunk` (O(1)).
- **The modal becomes a thin view over the engine.** Golden tests (E1) prove its results don't change.

### 0.4 Load the index off the startup path

`onload()` only registers commands, views and settings, and returns. The index loads in `app.workspace.onLayoutReady` without being awaited. If you invoke search before it's ready, you get a "Loading paper index…" row that turns into results when the index finishes loading.

## 1. Rough edges

### 1a. Hotkey

- **Remove the hard-coded default hotkey from the plugin.** `Mod+Shift+F` clashes with Obsidian's "Search in all files", and Obsidian's plugin guidelines advise against default hotkeys anyway.
- During install (a manual step you approve), add an entry to `.obsidian/hotkeys.json`: `"semantero:open-paper-search": [{"modifiers": ["Mod", "Shift"], "key": "0"}]`. That sits next to Omnisearch on `Mod+0`.
- The plugin checks for conflicts at load: if another command has the same binding, it shows one notice naming that command.

### 1b. Index new Zotero papers within about a minute

**A new launchd job, `launchd/com.planner.zotero-watch.plist`:**
- `WatchPaths`: `~/Zotero/zotero.sqlite` and `~/Zotero/storage` (a new attachment folder fires the second).
- `ThrottleInterval`: 10 s (30 s until 27 Oct 2026). `RunAtLoad`: false.
- Runs `bin/planner-run.sh search watch-run`, logging to `logs/zotero-watch.log`.

**`planner search watch-run`** does this, in order:
1. **Lock.** Take a non-blocking `fcntl.flock` on `.planner/search.lock`. A manual `planner search index` uses the same lock. If the lock is held, log `busy` and exit 0. Whoever holds the lock re-checks the fingerprint before releasing it (step 6), so a change made in between isn't lost.
2. **Wait for Zotero to go quiet.** Wait until `zotero.sqlite` hasn't been modified for `quiet_s` (default 8 s; 20 s until 27 Oct 2026), checking every 5 s, for at most `max_wait_s` (600 s). If it never goes quiet, log `gave up waiting` and exit 0; the next trigger or the morning run catches up.
3. **Fingerprint** (read-only via the `?immutable=1` URI, about 25 MB):
   - number of regular items not in the trash;
   - `max(clientDateModified)` over items;
   - number of attachments;
   - a sorted list of (PDF path, mtime, size) for each PDF attachment.

   If it equals `state.fingerprint`, exit with `no changes`. That takes under 1.5 s and writes nothing.
4. **Build:** run `build_index(incremental)`. With 0.2 in place, it writes only if something changed.
5. **Record the fingerprint only after a successful build.** If Ollama is down or the build fails, log it and keep the old fingerprint, so the next trigger retries. Exit 0.
6. **Before releasing the lock,** recompute the fingerprint. If it changed while building, go back to step 2, at most 3 rounds.

**Missing PDFs:** a PDF whose file doesn't exist yet (Zotero adds the item before the download finishes) is indexed without chunks. It is **not** remembered as "no text", so a later run picks it up. The cache key includes the file's mtime and size, and a missing file has neither.

**Doctor:**
- checks that `com.planner.zotero-watch` is loaded;
- warns if `logs/zotero-watch.log` shows 3 failed builds in a row.

### 1c. Literature notes when you cite

When a citation is inserted (from the pop-up's `Cmd+Enter`, from `@@`, or from the panel's cite button), and when you open a paper's note (`Alt+Enter`, the panel's note button):

1. **Find an existing note** (`findLiteratureNote`) whose:
   - (a) file name equals the citekey, **ignoring case** (the Mac's disk ignores case), anywhere in the vault; or
   - (b) frontmatter has `citekey: <citekey>`.

   Use the first match.
2. **If there isn't one** and the `createLiteratureNotes` setting is on (default on):
   - create `<folder>/<citekey>.md`. The folder defaults to the vault root, matching Zotero Integration's `outputPathTemplate: "{{citekey}}.md"`, so the two never duplicate;
   - use `Zotero Template.md`, or the built-in template if that file is missing or uses features this renderer doesn't support.
3. **Insert the citation even if creating the note fails.** Creation is attempted after the text is inserted and never undoes it. A failure shows one notice.

**Template renderer** (`renderTemplate`, pure):
- Supported placeholders: `{{citekey}} {{title}} {{authors}} {{abstractNote}} {{notes}} {{year}} {{journal}} {{doi}} {{zoteroSelect}}`. Spaces inside the braces are allowed (`{{ title }}`).
- `{{authors}}`: last names joined with `, `. (The index stores last names only; Zotero Integration would write full names. Documented, accepted.)
- `{{notes}}`: an empty string, since Zotero child notes aren't in the index.
- An unknown simple placeholder renders as an empty string and is logged once.
- **A template using Nunjucks syntax** (`{%`, `{#`, or a filter with `|`) is unsupported. Use the built-in template and show one notice per session.
- **Substitution is a single pass:** a value containing `{{…}}` is never expanded again.
- **Frontmatter values are escaped.** Inside the frontmatter (between the first two `---` lines), a placeholder inside a double-quoted value gets `\` and `"` escaped and line breaks turned into spaces. A placeholder that isn't quoted gets the whole value double-quoted and escaped. Outside the frontmatter, values go in unchanged.
- The built-in template matches yours: frontmatter `citekey`, `title`, `authors`; `# {{title}}`; a Zotero link; `## Abstract`; `## Notes`.

**Citation format** (setting `citationFormat`, default `[[{{citekey}}]]`, same as your Zotero Integration `citeSuggestTemplate`). The alternative is `[@{{citekey}}]`, Pandoc style, for the reference-list plugin.

**Filename safety:** a citekey containing `/ \ : * ? " < > |`, a leading `.`, or more than 200 characters doesn't get a note. The citation is still inserted, and one notice explains why.

**Modal keys (updated):**
- `Enter`: PDF in Zotero at the page.
- `Cmd+Enter`: insert the citation and make sure the note exists.
- `Alt+Enter`: open the note, creating it if missing.
- `Shift+Enter`: select the item in Zotero.

### 1d. Settings stay out of git

- Add `obsidian/paper-search/data.json` to `.gitignore`. Obsidian writes the settings there, and through the symlink that's the repo.
- New settings:

| Setting | Default |
|---|---|
| `citationFormat` | `[[{{citekey}}]]` |
| `createLiteratureNotes` | `true` |
| `literatureNoteFolder` | `""` (vault root) |
| `literatureNoteTemplate` | `Zotero Template.md` |
| `inlineTrigger` | `@@` |
| `inlineLimit` | `8` |
| `inlineShowSnippet` | `true` |
| `relatedLimit` | `5` |
| `relatedMinScore` | calibrated (3c) |
| `relatedAutoRefresh` | `false` |
| `relatedInstruction` | see 3b |

## 2. Cite while writing: `@@`

### Behaviour

```
...as shown for organoid stiffness @@stiff gels chemores|
                                    ┌──────────────────────────────────────────────────────────┐
                                    │ Engineered matrices reveal stiffness-mediated chemore…   │
                                    │ LeSavage · 2024 · "…stiffer matrices increased resistan…" │
                                    │ Next-generation cancer organoids                         │
                                    │ LeSavage · 2022 · abstract                               │
                                    └──────────────────────────────────────────────────────────┘
```

- **Typing `@@` opens the suggestion list.** With nothing typed after it, the list shows one hint row: `Type to search your papers`.
- **Keyword results** update on every keystroke.
- **Semantic results** merge in after a 250 ms pause, under the same rules as the pop-up: 2 words, the last one 3+ characters or a digit, or 12 characters.
- **`Enter` or `Tab`** replaces everything from `@@` to the cursor with the citation, then runs 1c.
- **`Escape`** closes the list and leaves the text as typed.

### Trigger rules (`findTrigger(lineText, ch, trigger = "@@")`, pure)

Only the current line is examined, and only the last 160 characters before the cursor, so the cost doesn't grow with the size of the note. A trigger is accepted only if:
- The `@@` is the **last** occurrence before the cursor on this line, within those 160 characters.
- The character before `@@` is the start of the line, whitespace, or one of `( [ { " '`. That rejects `x@@`, `@@@`, `\@@` (escaped), and email-like text.
- The query (text between `@@` and the cursor):
  - is at most 120 characters;
  - contains no `]]`, `@@` or tab;
  - doesn't start with two spaces (`@@  ` is treated as abandoned).
- **Context:** the cursor isn't inside
  - frontmatter;
  - a fenced code block;
  - a math block (`$$`);
  - inline code (an odd number of backticks before the cursor on the line);
  - inline math (an odd number of single `$` before the cursor, ignoring `\$`);
  - an unclosed `[[` or `![[`.

  Block-level context comes from `metadataCache.getFileCache(file).sections` (already computed by Obsidian, no parsing) and is passed into a pure `isExcludedContext(sections, line, lineText, ch)`.

### Updating the list when semantic results arrive

Obsidian's `EditorSuggest` has no public way to replace suggestions while it's open. A single adapter, `refreshSuggestions(suggest, hits)`:
- uses the internal `suggest.suggestions.setSuggestions` if it exists (the pop-up already relies on the matching internal call);
- otherwise saves the semantic hits in a cache (16 entries, keyed by query), so the next keystroke, or reopening the list for the same query, shows the merged list.

Either way the selection follows the same paper (`maintainSelection`), and responses for an outdated query are discarded through a sequence number, as in the pop-up.

### Possible conflict

The Pandoc Reference List plugin can suggest citekeys after `@`. Our trigger needs `@@`, but if both lists open, the one registered first wins. Manual check M9 covers this. If they clash, the fix is a different trigger setting, not code.

## 3. Related papers panel

### 3a. Behaviour

- A right-sidebar view, `semantero-related-papers`.
- Commands:
  - **"Show related papers"** opens or reveals the panel;
  - **"Find papers related to this note"** refreshes it from the current editor.
- The panel header has a **Refresh** button. With the default `relatedAutoRefresh = false`, **that's the only way it updates**, to protect against the foraging problem in your notes.
- Each result shows the title, first author and year, the snippet with a page or `abstract` badge, and three actions:
  - clicking the row opens the PDF at the page;
  - **cite** inserts the citation at the cursor of the last active editor, plus 1c;
  - **note** opens or creates the literature note.
- **Papers already cited in the note are hidden** (`[[citekey]]`, `[@citekey]`, a frontmatter `citekey`), with a footer `2 already cited · show`.
- **When nothing is close enough,** below `relatedMinScore`, the panel says `Nothing close in your library` instead of showing weak matches.
- **If the passage is too short** (under 30 characters after clean-up), it says `Write a bit more first`.
- **If Ollama is unreachable:** `Related papers needs Ollama running`.
- **Switching notes during a refresh** discards the result (sequence number plus the file path recorded when it started).

### 3b. What text is used (`extractPassage(noteText, cursorOffset, selection, maxChars = 2000)`, pure)

1. Use the selection if it has at least 20 characters after clean-up.
2. Otherwise use the section around the cursor (from the previous heading to the next one) if it has at least 200 characters.
3. Otherwise use the whole note.

**Clean-up, always applied:**
- remove frontmatter, the planner brief block, `%% … %%` comments, fenced code, math blocks, `![[embeds]]`, image links and bare URLs;
- `[[target|alias]]` becomes `alias`, and `[[target]]` becomes `target`;
- remove Markdown markers (`#`, `>`, `-`, `*`, `_`, backticks);
- collapse whitespace.

**Shortening:** if it's still longer than `maxChars`, take a window of `maxChars` centred on the cursor and cut at sentence boundaries.

**How it's embedded:** with `relatedInstruction` (default `Given a passage from my research notes, retrieve papers that report the findings or methods it discusses`) in the query format. The evaluation (3c) decides between that and no instruction.

**Ranking:** semantic only. Keyword matching of a 2,000-character passage mostly measures shared common words. Each paper scores the higher of its abstract row and its best chunk row, papers already cited are excluded, and the top `relatedLimit` are shown.

### 3c. Evaluation and calibration (`eval/related.toml`, you write it)

```toml
[[n]]
note = "Ben Glocker inaugural medical imaging 14.10.26.md"   # vault path; read-only
section = ""                                                 # optional heading; "" = whole note
expect = ["glockerXXXX", "…"]                                # papers you'd want suggested
```

- Write 10 or more entries from real seminar and meeting notes.
- `node scripts/eval-related.ts --index <dir> --vault <copy>` runs on a **copy** of the vault (AGENTS rule) and prints:
  - hit@5;
  - MRR;
  - the score of every expected paper;
  - the best score of a non-expected paper per note.
- **Choose the instruction:** the default instruction, or none (passage embedded as a plain document). Keep the higher hit@5; on a tie, keep no instruction.
- **Calibrate `relatedMinScore`:** the largest threshold that keeps at least 90% of expected papers' scores, rounded down to 0.01. It's written into the default settings, and the calibration notes go in this spec.
- **Done when** hit@5 ≥ 0.6 on your set. These are harder than finding a named paper; 0.6 means the panel is useful more often than not.

## Files

| File | Change | Obsidian imports |
|---|---|---|
| `src/bm25.ts` | 0.1: sorted vocabulary, bounded prefix, typed score arrays, partial top-k | no |
| `src/indexstore.ts` | **new**, 0.3/0.4: load, check, precompute, `ensureFresh`, swap | adapter passed in |
| `src/engine.ts` | **new**, 0.3: `keyword`, `semantic`, `hybrid`, snippets | no |
| `src/cite.ts` | **new**: `findTrigger`, `isExcludedContext`, `formatCitation`, `citedKeys` | no |
| `src/litnote.ts` | **new**: `findLiteratureNote`, `renderTemplate`, `planNote`, `ensureLiteratureNote(vaultLike, …)` | no (`VaultLike` interface) |
| `src/passage.ts` | **new**: `extractPassage`, `cleanMarkdown` | no |
| `src/modal.ts` | moved out of `main.ts`; thin view over `ModalSearchController` (`src/modalsearch.ts`); new keys | yes |
| `src/inline.ts` | **new**: `EditorSuggest` glue, `refreshSuggestions` adapter | yes |
| `src/related.ts` | **new**: `ItemView` glue | yes |
| `src/main.ts` | registration only; settings tab | yes |
| `scripts/make-synthetic-index.ts` | **new**: deterministic index for performance tests | no |
| `scripts/eval-related.ts` | **new** (3c) | no |
| `test/fakes.ts` | **new**: in-memory `VaultLike`, `EditorLike`, `requestUrl`, clock | no |
| `planner/searchindex.py` | 0.2 `content_hash`, no-op skip, missing-PDF retry, shared lock | — |
| `planner/zotwatch.py` | **new**: 1b fingerprint, quiet wait, loop | — |
| `planner/__main__.py` | `search watch-run`; doctor checks | — |
| `launchd/com.planner.zotero-watch.plist` | **new** | — |
| `.gitignore` | `obsidian/paper-search/data.json` | — |

## Performance budgets

Measured on this Mac. Benchmarks run on a **synthetic index 3× today's size** (500 papers, about 25k chunks, 1,024 dimensions, Zipf-distributed vocabulary of 30k terms, fixed seed), so there's headroom as the library grows. They run under `SEMANTERO_PERF=1`, report p50/p95/p99/max, and fail on any budget breach.

| # | What | Budget | Today |
|---|---|---|---|
| B1 | Keyword search, **every prefix** of 40 realistic queries (including 1–2 letter unfinished words) | p95 ≤ 8 ms, **max ≤ 16 ms** | max 705 ms ✗ |
| B2 | `findTrigger` + context check, lines up to 10,000 characters | p99 ≤ 0.1 ms | n/a |
| B3 | `semantic()` scoring + top-k (excluding the Ollama call) | p95 ≤ 25 ms | 13 ms at 1× |
| B4 | Hybrid merge + snippets for 12 hits | p95 ≤ 3 ms | O(n) lookups today |
| B5 | `onload()` | ≤ 20 ms | awaits the full load today ✗ |
| B6 | Background index load (parse + vectors + BM25 + precompute) | ≤ 800 ms at 3×, ≤ 400 ms at 1× | ~335 ms at 1× |
| B7 | `ensureFresh()` when nothing changed | ≤ 2 ms (one small file read, throttled) | full reload check today |
| B8 | Heap after load | ≤ 160 MB at 1×; reported at 3× | 119 MB |
| B9 | Panel refresh, 2,000-character passage, warm Ollama, end to end | p95 ≤ 400 ms | ~200 ms embed |
| B10 | `extractPassage` on a 200 kB note | ≤ 5 ms | n/a |
| B11 | `ensureLiteratureNote` (find + render + create) | ≤ 30 ms | n/a |
| B12 | `planner search watch-run` with no change | ≤ 1.5 s wall, **0 bytes written** under `.planner/search/` | rewrites the index ✗ |
| B13 | New paper saved in Zotero → findable by keyword in the pop-up | ≤ 90 s (20 s quiet + 30 s throttle + ~10 s embed + reload) | next morning ✗ |
| B14 | Semantic merge never changes the selected paper while it's still in the list | 0 violations in 1,000 randomised sequences | — |

## Tests

Python tests use `unittest` and temporary directories, as now. TypeScript tests use `node --test`, as now. Glue code that imports `obsidian` isn't unit-tested; everything it calls is pure and tested through `test/fakes.ts`, and the glue itself is covered by the manual checklist. **No test touches the real vault or the real Zotero folder.** Performance tests use the synthetic index. `SEMANTERO_LIVE=1` enables the tests that call Ollama.

### Phase 0

**Keyword prefix: `test/bm25.test.ts` (additions)**
- **K1 short unfinished word ignored:**
  - `"s"` gives the same ranking as `""` (empty);
  - `"stiff g"` gives the same ranking as `"stiff in"` (`"stiff"` finished by a stopword).
- **K2 a short word that's a real term still matches exactly:** `"3d"` as the last word, `"il"` before another word, with a vocabulary containing them.
- **K3 three-letter prefix expands:** `"vis"` finds `viscoelastic` and `viscosity`.
- **K4 at most 64 expansions, highest document frequency kept:** a vocabulary with 500 `stiff*` terms gives exactly 64, and the 64 kept are the most frequent.
- **K5 a typed word that is a term ranks its exact matches above longer words:** `"cell"` and `"cell "` match `cellular` too, but rank `cell` first. (Changed 24 Oct: a completed word used to never prefix-match, which made a trailing space change the results.) **K5b** a rare longer word (`cells121`) scores no higher than the word typed.
- **K6 ranking unchanged for completed-word queries:** golden results on `index_small` for 20 queries, recorded before the change, must be identical after it. (Re-recorded 24 Oct: the half weight on longer words changed the scores, not the order, of `roth`, `lesavage`, `wang` and `drug response organoid`.)
- **K7 sorted vocabulary binary search agrees with a linear scan** for 1,000 random prefixes.
- **K8 unicode and odd input don't crash:**
  - `"Φ29"`, `"β-catenin"`, `"naïve"`, emoji, 10 kB of `"a "`, only stopwords, only punctuation;
  - the result is a list, possibly empty.

**No-op index: `tests/test_search_index.py` (additions)**
- **N1 a no-op run writes nothing:** the mtimes and bytes of all 5 files, and `built_at`, are unchanged; the log says `no changes`; 0 embed calls.
- **N2 only a title changed:** `papers.json` is rewritten, one abstract row is re-embedded (its text changed), chunk vectors are byte-identical, and `content_hash` changes.
- **N3 `content_hash` is stable across two no-op runs** and changes when any output changes (a parameterised test over papers, chunks, rows and vector bytes).
- **N4 missing PDF is retried:** item present but PDF file absent → paper indexed with 0 chunks and not cached as no-text. Create the file → the next run extracts and embeds it.
- **N5 shared lock:** while `search.lock` is held by another process (a fixture subprocess), `search index` waits up to 60 s, then gives up with a clear message. `watch-run` exits immediately with `busy`.

**Engine: `test/engine.test.ts`**
- **E1 golden equivalence:** for 30 queries on `index_small`, `engine.keyword`/`semantic`/`hybrid` return the same papers, order and snippets as the current modal code, recorded before the refactor.
- **E2 semantic per-paper maximum without sorting rows** equals a reference implementation (sort everything, then group) on 200 random matrices.
- **E3 `exclude`** removes those papers, and `minScore` drops hits below the threshold.
- **E4 a paper with no rows** (no abstract, no chunks) never appears in semantic results and still appears in keyword results.
- **E5 snippet lookup uses `rowToChunk`:** with a chunk array shuffled relative to rows, snippets are still right.
- **E6 hybrid with an empty semantic list equals keyword-only;** with an empty keyword list it equals semantic-only.
- **E7 deterministic ties:** equal scores are ordered by paper index, so results never flicker between identical renders.

**Index store: `test/indexstore.test.ts`** (fake adapter)
- **X1 load precomputes `rowToChunk` and `paperChunkRows` in one pass:** asserted to be O(chunks) by counting fake-adapter reads and array passes.
- **X2 `ensureFresh` reads only the manifest when `content_hash` is unchanged,** and at most once per 10 s (fake clock).
- **X3 swap is atomic:** a search started before the swap finishes against the old index; one started after uses the new one; never a mix (asserted through the index identity carried on every hit).
- **X4 corrupt index:**
  - truncated `vectors.f32` → keyword-only, with one notice;
  - malformed `chunks.json` → keep the previous index, with one notice;
  - missing folder → `ready = false` and the "Loading/missing" row;
  - `dims` mismatch → keyword-only.
- **X5 index written for an old format** (no `content_hash`) reloads on `built_at` change.
- **X6 `onload` returns before the load finishes:** the fake adapter's read never resolves, yet `onload` resolves. Searching before the load finishes returns the loading row.

### Part 1

**Watcher: `tests/test_zotwatch.py`**
- **W1 no change → no build, no writes,** finished in under 1.5 s on the fixture library.
- **W2 a changed item, attachment count, or PDF mtime/size** → exactly one build. Each fingerprint component is tested on its own.
- **W3 lock held → `busy`, exit 0, no build.**
- **W4 quiet wait** (patched clock and sleep):
  - mtime 5 s ago → waits until 20 s;
  - a new change during the wait restarts the countdown;
  - gives up after `max_wait_s` with `gave up waiting`, exit 0.
- **W5 failed build** (Ollama down, or the build raises) → fingerprint not recorded, error logged, exit 0. The next run retries and records it on success.
- **W6 change during the build** → a second round runs. A library that keeps changing stops after 3 rounds.
- **W7 `zotero.sqlite` missing or unreadable** → logged, exit 0, no traceback.
- **W8 plist:**
  - `plutil -lint` passes;
  - `WatchPaths` has both paths;
  - `ThrottleInterval` ≥ 10;
  - `ProgramArguments` uses `bin/planner-run.sh search watch-run`;
  - the log path is under `logs/`;
  - no `KeepAlive`.
- **W9 doctor:**
  - watch job not loaded → fail, with the `launchctl bootstrap` command;
  - 3 consecutive `build failed` lines in the log → warning.
- **W10 a manual build and the watcher at once:** both call into the lock (two subprocesses on the fixture). Exactly one build happens, the other logs `busy`, and the index stays consistent (checked with SEARCH_SPEC test 20).

**Literature notes: `test/litnote.test.ts`** (fake vault)
- **L1 existing note by file name:**
  - `roth2023.md` exists → found;
  - **`Roth2023.md` is found for `roth2023`** (case-insensitive);
  - a file in a subfolder is found.
- **L2 existing note by frontmatter `citekey`** with a different file name → found; nothing is created.
- **L3 creates `<folder>/<citekey>.md`** from your actual `Zotero Template.md` text (fixture copy). The output is compared with an expected file for 3 papers: with an abstract, without one, and without a journal or year.
- **L4 YAML escaping:**
  - title `Mitochondrial "transfer": a review` → `title: "Mitochondrial \"transfer\": a review"`;
  - a title containing a line break → a single line;
  - an author list containing `:`;
  - the frontmatter parses (checked with a minimal YAML-subset parser in the test).
- **L5 outside the frontmatter, values go in unchanged** (Markdown in an abstract stays as written).
- **L6 single pass:** an abstract containing `{{title}}` stays literally `{{title}}`.
- **L7 a Nunjucks template** (`{% for %}`, `{{ title | upper }}`) → built-in template used, one notice per session (a second call gives no second notice).
- **L8 template file missing** → built-in template, no notice spam.
- **L9 never overwrites:**
  - the file appears between the check and the create (the fake vault throws "exists") → treated as existing, no error notice;
  - existing content is unchanged.
- **L10 unsafe citekeys** (`a/b`, `a:b`, `.hidden`, a 300-character key, an empty citekey) → no file; the citation is still inserted; one explanatory notice.
- **L11 citation formats:** `[[{{citekey}}]]` and `[@{{citekey}}]`; a format without `{{citekey}}` is rejected in settings validation.
- **L12 creation failure doesn't undo the insert:** fake vault `create` throws an I/O error → the editor still contains the citation, plus one notice.
- **L13 folder setting:**
  - `Literature` → the folder is created if missing;
  - a trailing slash, `./` and leading slashes are normalised;
  - a folder path that escapes the vault (`../x`) is rejected.

**Hotkey: `test/hotkey.test.ts`**
- **H1 the plugin declares no default hotkey** (the command's registration has no `hotkeys` field).
- **H2 conflict check:** given a fake hotkey map with `Mod+Shift+0` already bound to another command → one notice naming it. No conflict → no notice.

### Part 2: `test/cite.test.ts`, `test/inline.test.ts`

**Trigger: `findTrigger` / `isExcludedContext`**
- **C1 basic:** `"text @@stiff"` with the cursor at the end → start = 5, query `"stiff"`.
- **C2 at the start of the line,** after `(`, `[`, `{`, `"`, `'` → triggers.
- **C3 after a letter, digit, `@` or `\`** (`x@@`, `2@@`, `@@@`, `\@@`) → no trigger.
- **C4 empty query** (`"@@"`) → triggers with `""`, and the list shows the hint row.
- **C5 the last `@@` wins:** `"@@a done @@stiff"` → query `"stiff"`.
- **C6 more than 160 characters back** → no trigger; a query of 121 characters → no trigger.
- **C7 the query contains `]]`, `@@` or a tab, or starts with two spaces** → no trigger.
- **C8 cursor in the middle of a query** (`"@@sti|ff"`) → query `"sti"`; replacing removes only `@@sti` and keeps `ff`.
- **C9 excluded contexts:** frontmatter, fenced code (including ```` ``` ```` inside a list), `$$` blocks, inline code `` `@@x` ``, inline `$a@@b$`, unclosed `[[foo @@x`, `![[foo @@x`. All → no trigger.
- **C10 not excluded:** after a closed `` `code` `` on the same line; after `\$`; after a closed `[[link]]`.
- **C11 multi-byte text before the trigger** (`"naïve Φ29 @@x"`) → correct character offsets (string offsets, which is what the editor uses).
- **C12 custom trigger setting** `";;"` behaves the same as `@@` in C1–C8.

**Inline glue (fake editor, fake suggest, fake clock)**
- **I1 Enter replaces exactly `[start, cursor)`** with the formatted citation; the text after the cursor is unchanged; the cursor ends just after the inserted citation.
- **I2 the replacement is one editor transaction:** the fake editor records a single `replaceRange` call, so one undo removes it.
- **I3 lit note created after the insert** (1c), using the fake vault. With `createLiteratureNotes = false`, no vault call.
- **I4 semantic results merge in** after 250 ms of quiet:
  - the adapter's `setSuggestions` is called once;
  - the selection stays on the same paper (B14);
  - typing at 100 ms intervals produces **zero** embed calls until the pause.
- **I5 outdated responses are dropped:** response for `"stiff g"` arrives after the one for `"stiff gels"` → ignored.
- **I6 adapter fallback:** a fake suggest without `suggestions.setSuggestions` → the semantic hits are cached; the next `getSuggestions` for the same query returns the merged list. The cache holds at most 16 entries (least recently used dropped).
- **I7 Ollama down:** keyword results only; no notice per keystroke (at most one per session); the list footer says semantic is off.
- **I8 index not loaded yet:** a single "Loading paper index…" row; choosing it does nothing.
- **I9 Escape:** the text is unchanged and no citation is inserted. Reopening by typing again works.
- **I10 cursor moves to another line** or past the query → the list closes (`findTrigger` returns null).
- **I11 rows render** the title cut at 80 characters, first author · year, and the snippet only when `inlineShowSnippet` is on.

### Part 3: `test/passage.test.ts`, `test/related.test.ts`

**Passage**
- **R1 a selection of at least 20 characters wins;** a shorter selection falls through to the section.
- **R2 the section around the cursor** (between headings) when it has at least 200 characters; otherwise the whole note.
- **R3 clean-up:** each element in 3b is removed, one test each. Alias handling: `[[a|b]]` → `b`, `[[a]]` → `a`. The planner brief block is removed.
- **R4 shortening:** a 50 kB note gives at most 2,000 characters, roughly centred on the cursor, cut at sentence boundaries; the cursor's own sentence is always included.
- **R5 too short after clean-up** (a note with only frontmatter and links) → `null` → the "Write a bit more" state.
- **R6 cited keys:** `[[roth2023]]`, `[[roth2023|Roth]]`, `[@roth2023]`, `[@roth2023; @lee2024]`, frontmatter `citekey` → all detected. A citekey that only appears inside a code block is not detected.

**Panel logic** (fake engine, fake clock, fake `requestUrl`)
- **P1 refresh embeds the passage once** using `relatedInstruction`, renders at most `relatedLimit` results, and excludes cited papers. The footer shows the hidden count, and "show" reveals them.
- **P2 below `relatedMinScore`** → the "Nothing close" state, not weak results.
- **P3 switching notes mid-refresh** → result discarded; the panel shows the new note's empty state.
- **P4 two quick refreshes** → only the last renders, and the first request's response is ignored.
- **P5 auto-refresh off (default)** → opening files triggers **zero** embed calls (fake `requestUrl` call count = 0 over 20 file switches).
- **P6 auto-refresh on** → one refresh 1 s after the last file switch; reopening the same file with the same passage gives no new call.
- **P7 actions:**
  - cite inserts into the *last active Markdown editor* even though the panel has focus;
  - with no editor open → copied to the clipboard plus a notice;
  - note opens or creates (1c);
  - clicking the row opens `zotero://open-pdf/...?page=N`.
- **P8 Ollama down** → the "needs Ollama" state; one notice per session at most.

### Performance: `test/perf.test.ts` (`SEMANTERO_PERF=1`, synthetic index)

- **PF1** B1 over every prefix of 40 queries (the query list is a fixture: your 22 evaluation queries, 10 author names, 8 one-word queries).
- **PF2** B2 with lines of 10, 1,000 and 10,000 characters, with and without `@@`.
- **PF3** B3 and B4, 200 random query vectors.
- **PF4** B6 and B8: load the 1× copy and the 3× synthetic index; report heap; fail over budget.
- **PF5** B7: 1,000 `ensureFresh` calls with a fake clock advancing 1 s each → at most 100 manifest reads, and p99 ≤ 2 ms.
- **PF6** B10 on a 200 kB generated note.
- **PF7** B14: 1,000 random type/pause/response-order sequences through the inline glue with fakes → zero selection jumps.
- **PF8** (`SEMANTERO_LIVE=1` as well) B9 end to end with real Ollama and the 0.6b model; warm-up excluded; 20 runs.
- **Python PF9** B12: `watch-run` on the fixture library with an unchanged fingerprint, run 10 times → p95 ≤ 1.5 s, and a recursive byte and mtime snapshot of `search/` is unchanged.

### Edge-case matrix (where each one is covered)

| Situation | Covered by |
|---|---|
| First letter of every word freezes the list | K1, PF1 |
| Index missing, corrupt, half-written, wrong dims | X4, I8 |
| Index rebuilt while Obsidian is open | X2, X3 |
| Zotero busy importing (many writes) | W4, W6 |
| PDF arrives after the item | N4, W2 |
| A manual build and the watcher at the same time | N5, W10 |
| Ollama stopped or model unloaded | W5, I7, P8 |
| Existing note with different case or different name | L1, L2 |
| Your template uses features we don't support | L7 |
| Quotes, colons, line breaks in titles | L4 |
| Citekey unusable as a file name | L10 |
| Note created by Zotero Integration at the same moment | L9 |
| `@@` in code, math, links, emails, escaped | C3, C9 |
| Very long lines or notes | C6, PF2, R4, PF6 |
| Out-of-order semantic responses | I5, P4, PF7 |
| Selection jumping while typing | I4, PF7 |
| Panel left open while browsing notes | P5 |
| Panel result arrives after switching notes | P3 |
| Another plugin claims the trigger | M9 |
| Hotkey clash | H1, H2, M1 |

### Manual checklist (added to `obsidian/paper-search/CHECK.md`)

- [ ] **M1** The hotkey from `.obsidian/hotkeys.json` opens the pop-up, and `Cmd+Shift+F` still opens Obsidian's own search.
- [ ] **M2** Obsidian starts with no visible delay from the plugin, and the first search right after start shows "Loading…" and then results.
- [ ] **M3** Type quickly in the pop-up, one letter at a time: no stutter on the first letter of any word.
- [ ] **M4** Save a new paper in Zotero. Within 90 s it's findable by title, and `logs/zotero-watch.log` shows one build.
- [ ] **M5** Leave Zotero open and idle for 10 minutes, then check the log: only `no changes` lines, and the index files' mtimes are unchanged.
- [ ] **M6** `Cmd+Enter` on a paper without a note → `[[citekey]]` inserted and the note created from your template. Run it again → no second note.
- [ ] **M7** `@@` + typing in a daily note, a seminar note, inside a list item and inside a callout → list appears. Inside a code block → no list.
- [ ] **M8** Undo right after an `@@` insertion restores `@@query` in one step.
- [ ] **M9** With the Pandoc Reference List plugin enabled, `@@` shows only our list, and `[@` still shows theirs.
- [ ] **M10** The panel stays unchanged while you switch notes, until you press Refresh.
- [ ] **M11** Panel cite button inserts at your last cursor position in the note.
- [ ] **M12** `brew services stop ollama` → the pop-up and `@@` still give keyword results; the panel shows the Ollama message. Restart → back to normal.

## Build order

Each phase ends with its tests green, the benchmarks within budget, and a commit.

| Phase | Work | Tests | Exit |
|---|---|---|---|
| 0a | Synthetic index generator, `fakes.ts`, golden recordings (K6, E1) **before** changing code | — | goldens committed |
| 0b | 0.1 prefix fix | K1–K8, PF1 | B1 met |
| 0c | 0.2 no-op skip, `content_hash`, missing-PDF retry, lock | N1–N5, PF9 | B12 met |
| 0d | 0.3 engine and index store; 0.4 background load; modal rewired | E1–E7, X1–X6, PF3–PF5 | B3–B8 met; modal unchanged in use |
| 1 | 1a hotkey, 1d gitignore and settings, 1c literature notes and modal keys, 1b watcher and plist | H1–H2, L1–L13, W1–W10 | M1–M6 checked; watcher installed (you approve) |
| 2 | `@@` inline citations | C1–C12, I1–I11, PF2, PF7 | M7–M9 checked |
| 3 | Panel; `eval/related.toml` (you); calibrate; choose the instruction | R1–R6, P1–P8, PF6, PF8 | hit@5 ≥ 0.6; M10–M12 checked |

## Rules

- **Never test against the real vault or real Zotero.** Performance uses the synthetic index or a copy. The related-papers evaluation reads a **copy** of the vault.
- **The watcher writes only under `.planner/search/` and `logs/`.** Literature notes are created only by the actions in 1c.
- **No default hotkeys in code.** Hotkeys go in `.obsidian/hotkeys.json` at install.
- **Internal Obsidian APIs** (`chooser`, `suggestions.setSuggestions`) are used only through one adapter each, with a fallback and a test of the fallback (I6). An Obsidian update that removes them degrades results; it doesn't break them.
- **Installing the watcher plist, editing `hotkeys.json`, and enabling new commands** are manual steps you approve, as with the existing launchd jobs.
- **No new runtime dependencies,** in Python or the plugin.
