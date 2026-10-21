# Paper search: spec (test-driven)

Find a paper in your Zotero library from inside Obsidian by typing what it found or showed, with results updating as you type. You don't need to remember the methods, the title or the authors.

Status: implemented; kept as the design record. Companion to [SPEC.md](SPEC.md) (the planner). Same repository, same rules: see [AGENTS.md](../AGENTS.md).

## Principles

- **Every word you see is the paper's own.** There's no generated text in the index or the results. The only model at search time is an embedding model, which turns text into vectors and can't generate anything. Snippets are sentences copied from the paper, with a page number.
- **Local and free.** Embeddings run through Ollama on this Mac. Nothing leaves the machine.
- **Instant first, smart second.** Keyword results update on every keystroke; semantic results merge in once you pause. The list never blanks while it waits.
- **One fixed embedding model**, recorded in the index. Changing it is a deliberate full rebuild, so vectors stay comparable (theme drift and clustering will reuse them later).
- **Read-only towards Zotero.** It never writes to `zotero.sqlite` or `storage/`.
- **Tests first.** Every behaviour below has a named test, written before the code. Model choice is settled by an evaluation on your own queries, not by benchmarks.

## What you get

`Cmd+Shift+F` (configurable) in Obsidian opens a search pop-up, styled like the Quick Switcher:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ stiffer gels slowed neural maturation                                    │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ Tunable hydrogel viscoelasticity modulates human neural maturation     │
│   Roth et al. · 2023 · Science Advances                         p. 6     │
│   "…faster stress relaxation accelerated neuronal maturation and…"      │
│                                                                          │
│   Next-generation cancer organoids                                       │
│   LeSavage et al. · 2022 · Nature Materials                   abstract   │
│   "…matrix stiffness and viscoelasticity regulate organoid…"            │
└──────────────────────────────────────────────────────────────────────────┘
 ↵ open PDF at page   ⌘↵ insert [[citekey]]   ⌥↵ literature note / Zotero item
```

- **Enter** opens the PDF in Zotero's reader at the matching page: `zotero://open-pdf/library/items/<attachmentKey>?page=N`. A chunk from a web snapshot has no page and opens the snapshot: `zotero://open/library/items/<attachmentKey>` (Zotero 7+ routes `open` and `open-pdf` to the same handler, which opens any file attachment).
- **Cmd+Enter** inserts `[[citekey]]` at the cursor, matching your Zotero Integration `citeSuggestTemplate`.
- **Alt+Enter** opens `<citekey>.md` if it exists, otherwise selects the item in Zotero: `zotero://select/library/items/<itemKey>`.

## Architecture

```
 Zotero (read-only)                daito (Python, offline)                     Obsidian (TypeScript, live)
 ──────────────────                ───────────────────────                     ───────────────────────────
 zotero.sqlite ──► zotlib.py ──┐
                               ├─► searchindex.py ──► .planner/search/ ──► loader.ts ─┐
 storage/*.pdf ──► pdftext.py ─┘         │            manifest.json                    ├─► rank.ts ──► SuggestModal
                                         ▼            papers.json                      │
                                  embed.py ──► Ollama  chunks.json        ollama.ts ───┘   (query vector)
                                  (documents)          vectors.f32
```

Why it's split this way:
- **Indexing is Python.** It belongs with daito, uses the existing config, runs from the morning job, and needs no new Python dependency: vectors are written with the standard library's `array('f')`.
- **Ranking is TypeScript, inside the plugin.** That means no extra background service to keep alive. A few thousand vectors fit in memory, and comparing against all of them takes a few milliseconds in JS.
- **The ranking core (`rank.ts`, `bm25.ts`, `text.ts`) has no Obsidian imports.** Node 26 runs `.ts` files directly, so it's tested with `node --test` and reused by the evaluation command.

Sizes for this library: 148 PDFs, about 2,000 pages, so roughly 4–6k chunks. At 1,024 dimensions as float32 that's about 25 MB of vectors, loaded once when Obsidian starts.

## Data sources (verified 19 Oct)

| Source | What we read | Notes |
|---|---|---|
| `zotero.sqlite` | `items`, `itemData`/`fields` (`title`, `abstractNote`, `date`, `publicationTitle`, `DOI`, `citationKey`), `creators`, `collections`, `tags`, `itemAttachments` | Read from a **temporary copy**, so Zotero being open doesn't matter. Exclude `deletedItems` and the types `attachment`, `note`, `annotation`. |
| `citationKey` | Present on all 160 items | Native Zotero field; no Better BibTeX database needed. |
| `abstractNote` | 136 of 156 papers | Papers without one rely on full-text chunks. |
| PDFs | `itemAttachments` with `contentType = application/pdf`, `path = storage:<file>` → `~/Zotero/storage/<attachmentKey>/<file>` | 148 PDFs. Several PDFs per item (supplementary files) all belong to the parent paper. |
| Web snapshots | `itemAttachments` with `contentType = text/html`, child items only (standalone snapshots have no paper) | Text via stdlib `html.parser` (`planner/htmltext.py`), dropping `head`, `script`, `style`, `nav`, `header`, `footer`, `aside` and similar; whitespace collapsed; chunked like a single PDF page with `page: 0`. Listed in `papers.json` as `snapshots: [{attachmentKey, hasText}]`. |
| PDF text | `pdftotext -enc UTF-8 <pdf> -` (poppler, at `/opt/homebrew/bin`) | Pages are separated by `\f`, which gives page numbers. Zotero's `.zotero-ft-cache` is not used because it has no reliable page breaks. |

## Index format: `.planner/search/` (inside the vault, hidden from Obsidian)

Written into `.planner/search.tmp/`, then renamed into place, so the plugin never reads a half-written index.

**`manifest.json`**
```json
{
  "format": 1,
  "built_at": "2026-10-20T04:06",
  "model": "qwen3-embedding:0.6b",
  "dims": 1024,
  "query_instruction": "Given a description of what a paper found or showed, retrieve that paper",
  "chunker": "pages-v2",
  "papers": 156,
  "chunks": 4812
}
```

**`papers.json`**: one entry per paper, in a stable order.
```json
{
  "key": "AB12CD34",
  "citekey": "roth2023tunable",
  "title": "Tunable hydrogel viscoelasticity modulates human neural maturation",
  "authors": ["Roth", "…"],
  "year": 2023,
  "journal": "Science Advances",
  "doi": "…",
  "tags": ["hydrogels"],
  "collections": ["Biomaterials"],
  "abstract": "…",
  "pdfs": [{"attachmentKey": "EF56GH78", "pages": 14, "hasText": true}],
  "abstractRow": 0
}
```
`abstractRow` is the vector row for title + abstract (or the title alone if there's no abstract).

**`chunks.json`**: `{ "paper": <index into papers>, "attachmentKey": "…", "page": 6, "text": "…", "row": 1 }`

**`vectors.f32`**: little-endian float32, `rows × dims`, every row L2-normalised. Row 0 upwards: abstract rows and chunk rows interleaved, as referenced above.

**`state.json`** (indexer only): per attachment `{mtime, size, chunks: [rows]}` and per paper `abstract_sha`, so re-indexing only touches what changed.

## Python side (daito)

### Files

| File | Responsibility |
|---|---|
| `planner/zotlib.py` | Copy and read `zotero.sqlite` → `Paper` records. No PDF work. |
| `planner/pdftext.py` | PDF → per-page text → cleaned, chunked text with page numbers. |
| `planner/embed.py` | Ollama `/api/embed` client: batching, truncation to `dims`, normalisation, retries. |
| `planner/searchindex.py` | Incremental build, atomic write, stats. |
| `planner/__main__.py` | `search index`, `search stats`; doctor checks. |

### Config (`config.toml`)

```toml
[search]
zotero_dir = "~/Zotero"
model = "qwen3-embedding:0.6b"      # fixed once chosen by the evaluation; changing it rebuilds everything
dims = 1024                         # Matryoshka-style truncation, then re-normalise
query_instruction = "Given a description of what a paper found or showed, retrieve that paper"
chunk_words = 300
chunk_overlap_words = 50
max_chunks_per_paper = 150          # stops a thesis or book from dominating results
batch_size = 32
keep_alive = "30m"
```

### Behaviour

**Reading Zotero (`zotlib`)**
- Copy `zotero.sqlite` to a temporary file and open the copy read-only. If the copy fails, retry once after 2 s, then give up with a clear message.
- One `Paper` per regular item that isn't in `deletedItems`, with its PDFs attached by `parentItemID`.
- Authors: last names, in `orderIndex` order. Year: the first 4-digit run in `date`.

**PDF text (`pdftext`)**
- Run `pdftotext -enc UTF-8 <pdf> -` with a 60 s timeout; split on `\f` to get pages (1-based).
- Clean-up:
  - join words hyphenated across line breaks (`viscoelas-\nticity` → `viscoelasticity`);
  - collapse whitespace;
  - drop lines that repeat on more than half the pages (running headers and footers).
- **Cut off the references:** drop everything from the first line on or after 60% of the document that matches `^(references|bibliography|literature cited)\s*$` (case-insensitive).
- Chunks are about `chunk_words` words with `chunk_overlap_words` overlap. They never cross a page boundary, and each keeps its page number. Merge a page with fewer than 40 words into the next one.
- A PDF with no text (scanned): `hasText = false`, no chunks, listed in `search stats`.

**Embedding (`embed`)**
- `POST {ollama_url}/api/embed` with `{"model", "input": [...], "keep_alive", "truncate": true}`.
- Documents (abstracts, chunks) are sent **without** an instruction. The query side (in the plugin) uses `Instruct: {query_instruction}\nQuery: {q}`, which is the format Qwen3-Embedding expects.
- Abstract row text: `"{title}\n\n{abstract}"`, or `"{title}"` when the paper has no abstract.
- Truncate each vector to `dims`, then L2-normalise.
- On a connection error, retry 3 times with backoff. If the model is missing, the error says `ollama pull <model>`.

**Building the index (`searchindex`)**
- **Incremental:** a PDF is re-chunked and re-embedded only if its `mtime` or `size` changed. An abstract only if its hash changed.
- **Full rebuild** when `model`, `dims` or `chunker` differ from the manifest, or with `--full`.
- Removed papers and PDFs disappear from the output.
- Rows are renumbered when writing (the output is compact); the vectors themselves are carried over from the previous build.
- Write everything to `search.tmp/` → `fsync` → replace `search/` (rename the old folder aside, rename the new one in, then delete the old). The plugin reloads when `manifest.built_at` changes.

**CLI**

| Command | Effect |
|---|---|
| `planner search index [--full] [--limit N]` | Build or update the index; prints counts, time, and PDFs with no text. |
| `planner search stats` | Papers, chunks, PDFs with no text, papers with no abstract, model, age. |

**Morning job:** after the brief and `Threads.md`, run `search index` and catch every failure. A failure becomes a `⚠ Setup:` warning and never blocks the brief.

**Doctor checks** (no model calls):
- the index exists and is less than 3 days old;
- the manifest's `model` and `dims` match `config.toml`;
- `ollama list` includes the model;
- `pdftotext` is on the path.

## TypeScript side (Obsidian plugin)

Lives in `obsidian/paper-search/` inside this repository. The build symlinks it into `<vault>/.obsidian/plugins/daito-paper-search/`.

### Files

| File | Responsibility | Obsidian imports? |
|---|---|---|
| `src/text.ts` | Tokeniser, sentence splitter, snippet choice | no |
| `src/bm25.ts` | BM25 over papers' metadata and chunks, with prefix matching on the last token | no |
| `src/rank.ts` | Paper scores, reciprocal rank fusion, deciding when to run semantic search | no |
| `src/vectors.ts` | Load `vectors.f32`, check it, dot products, top-k | no |
| `src/ollama.ts` | Query embedding: instruction, truncation, normalisation; dropping stale responses | no (HTTP function passed in) |
| `src/main.ts` | Plugin, settings, `SuggestModal`, commands, index reload | yes |
| `scripts/eval.ts` | Evaluation CLI (below) | no |

### Ranking

1. **Tokenise:**
   - lowercase, split on anything that isn't a letter or digit;
   - keep tokens with digits (`il6`, `3d`);
   - drop a small English stopword list.

   The last token counts as *incomplete* unless the query ends in a space.
2. **Keyword ranking (every keystroke):** BM25 with `k1 = 1.2`, `b = 0.75`.
   - Paper-level fields, with weights: title ×3, authors ×3, citekey ×3, journal ×1, tags and collections ×2, abstract ×1.5.
   - Chunk level: weight 1.
   - The incomplete last token matches any vocabulary word it's a prefix of, with that word's best score.
   - A paper's keyword score is the larger of its metadata score and its best chunk score.
3. **Semantic ranking (after a pause):** embed the query, take the dot product with every row, and score each paper by the larger of its abstract row and its best chunk row. Remember which row won, for the snippet.
4. **When semantic runs:** only once the query has at least 2 complete tokens, or at least 12 characters, **and** no keystroke for `debounce_ms` (default 200 ms). Every request carries a sequence number; a response older than the latest request is thrown away.
5. **Merge:** reciprocal rank fusion, `score = Σ 1 / (60 + rank)`, over whichever lists exist. Until semantic results arrive, the keyword order is shown alone.
6. **Snippet (extractive):**
   - Take the winning row's text: the best chunk, or the abstract.
   - Split it into sentences and pick the one with the most query-token overlap; if none overlap, take the first sentence.
   - Trim to about 160 characters around the match, with `…` at each cut.
   - Show the page number, or `abstract`.
7. **Stable list:** when results are re-ranked, keep the highlighted item if it's still in the top `limit` (default 12).

### Plugin behaviour

- **On load:** read the 4 index files through `app.vault.adapter` (they're in the hidden `.planner/` folder). Check the format, that `dims` matches the vector file length, and the row references. A bad index shows a notice once, and keyword search still works from `papers.json` if that's readable.
- **When the pop-up opens:**
  - reload the index if `manifest.built_at` changed;
  - send a warm-up request (`input: [""]` with `keep_alive`) so the model is loaded before your first pause.
- **HTTP** goes through Obsidian's `requestUrl` (avoids CORS) to `http://127.0.0.1:11434`.
- **If Ollama is down:** keyword results only, with a small footer: `semantic off: Ollama not reachable`. No error pop-ups.
- **Settings:** Ollama URL, debounce, minimum characters for semantic search, result limit, hotkey hint.

## Tests

Python tests use `unittest` with temporary directories, as `tests/test_r1.py` does. TypeScript tests use `node --test`. **No test calls a real model.** Embeddings come from a fake embedder: a deterministic vector derived from a hash of the token set, normalised. That makes texts that share words similar, which is enough to test the plumbing. Tests that touch Ollama or real PDFs run only when `DAITO_LIVE=1`.

### Fixtures (`tests/fixtures/search/`)

- `make_zotero.py` builds a minimal `zotero.sqlite` (only the tables and fields listed above) with 5 papers:
  - one without an abstract;
  - one in the trash;
  - one with 2 PDFs;
  - one with no PDF;
  - one ordinary paper.
- `sample.pdf`: 3 pages with a running header, a word hyphenated across a line break, and a `References` section on page 3. A committed binary, built once by `make_pdf.sh` (`textutil` + `cupsfilter`).
- `scanned.pdf`: one page with an image and no text layer.
- `index_small/`: a hand-built 4-paper index with `dims = 8`, for the TypeScript tests.

### Python: `tests/test_search_index.py`

**zotlib**
1. `test_reads_regular_items_excluding_trash_and_notes`: 4 papers returned; the trashed item and note/attachment types are excluded.
2. `test_citekey_authors_year_journal`: fields mapped; authors in `orderIndex` order; year taken from `"2023-05-01"` and from `"May 2023"`.
3. `test_pdfs_attached_to_parent`: the paper with 2 PDFs lists both; the paper without a PDF has `pdfs == []`; `storage:` paths resolve under `zotero_dir/storage/<attachmentKey>/`.
4. `test_reads_a_copy_not_the_live_db`: the original file is unchanged afterwards (same mtime) and no `-journal` or `-wal` file is created next to it.

**pdftext** (`pdftotext` patched with canned page text; the live tests use `sample.pdf`)
5. `test_pages_split_on_formfeed_one_based`
6. `test_dehyphenates_across_lines`: `viscoelas-\nticity` → `viscoelasticity`; a real hyphen in `cell-free` stays.
7. `test_drops_repeated_headers`: a line on more than half the pages is removed; a line on 1 page is kept.
8. `test_strips_references_after_60_percent`: everything from `References` on page 3 is dropped; a `References` line on page 1 of a 3-page document is kept.
9. `test_chunks_respect_pages_and_overlap`: no chunk spans 2 pages; the overlap equals `chunk_overlap_words`; short pages merge forward.
10. `test_max_chunks_per_paper_caps`: a 400-page fake document produces at most `max_chunks_per_paper` chunks, the first pages kept.
11. `test_scanned_pdf_has_no_text`: `hasText = false`, no chunks.
12. `test_pdftotext_timeout_is_a_skipped_pdf_not_a_crash`
13. `live_test_sample_pdf` (`DAITO_LIVE=1`): the real `pdftotext` on `sample.pdf` matches tests 5–8.

**embed** (HTTP patched)
14. `test_batches_inputs`: 70 inputs with batch size 32 → 3 requests, in order.
15. `test_truncates_and_normalises`: a 16-dim response with `dims = 8` → first 8 values, unit length.
16. `test_documents_have_no_instruction`: the request text is exactly the document text.
17. `test_missing_model_error_mentions_pull`
18. `test_retries_connection_errors_then_raises`
19. `live_test_ollama_roundtrip` (`DAITO_LIVE=1`): the real model returns `dims` floats; similar sentences score higher than unrelated ones.

**searchindex** (fake embedder)
20. `test_full_build_writes_all_files_consistently`: every `row` and `abstractRow` is in range; the vector file has exactly `rows × dims × 4` bytes; all rows have unit length.
21. `test_incremental_skips_unchanged_pdfs`: a second run makes 0 embed calls.
22. `test_changed_pdf_reembeds_only_that_pdf`
23. `test_changed_abstract_reembeds_only_that_row`
24. `test_removed_paper_disappears_and_rows_are_compact`
25. `test_model_or_dims_change_forces_full_rebuild`
26. `test_atomic_write_never_leaves_partial_index`: the embedder fails halfway → the previous `search/` is untouched and `search.tmp/` is cleaned up.
27. `test_paper_without_abstract_embeds_title_and_chunks`
28. `test_paper_without_pdf_has_abstract_row_only`

**CLI, morning job and doctor**
29. `test_morning_search_failure_is_a_warning_not_a_crash`: an `index` that raises → the brief is still written, and the warning text appears in it.
30. `test_doctor_flags_stale_or_mismatched_index`: the index is 4 days old → fail; the manifest model differs from config → fail, naming `planner search index --full`.
31. `test_doctor_flags_missing_ollama_model_and_pdftotext`

### TypeScript: `obsidian/paper-search/test/*.test.ts`

**text.ts**
1. `tokenises numbers and drops stopwords`: `"IL-6 in the 3D gels"` → `["il", "6", "3d", "gels"]`.
2. `marks last token incomplete unless trailing space`
3. `splits sentences without breaking "et al." or "Fig. 2"`
4. `snippet picks max-overlap sentence and trims around it`
5. `snippet falls back to the first sentence when nothing overlaps`

**bm25.ts**
6. `title match outranks body match for same term`: field weights work.
7. `prefix on incomplete last token`: `"viscoel"` finds `viscoelasticity`; a complete token does *not* match as a prefix.
8. `paper keyword score is max of metadata and best chunk`
9. `author surname query ranks that author's papers first`
10. `citekey exact match ranks first`

**vectors.ts**
11. `rejects vector file whose length ≠ rows × dims × 4`
12. `topk by dot product matches brute force reference`: a random 200 × 8 matrix, compared with a simple reference implementation.
13. `query truncation and renormalisation matches the indexer`: the same 16-dim input gives the same 8-dim output as Python test 15. Shared fixture values in `fixtures/trunc.json`.

**rank.ts**
14. `paper semantic score is max(abstract row, best chunk row) and records the winning row`
15. `rrf merges lists and handles a paper present in only one list`
16. `keyword-only ordering is shown before semantic arrives`
17. `semantic gating: needs ≥2 complete tokens or ≥12 chars`: `"vis"` no, `"stiff gels "` yes, `"viscoelasticit"` yes.
18. `stale semantic responses are dropped`: request #1 resolves after #2 → #1 is ignored.
19. `selection stays on the same paper after re-rank when still in top limit`
20. `ollama down → keyword results plus semantic-off flag, no throw`

**ollama.ts** (fake `requestUrl`)
21. `query is wrapped in the instruction format exactly`: `Instruct: …\nQuery: <q>`.
22. `warm-up request sends keep_alive and empty input`

**Plugin smoke test (manual, scripted checklist in `obsidian/paper-search/CHECK.md`)**
- [ ] Opens with the hotkey. The first keystroke shows keyword results in under 50 ms (no visible lag).
- [ ] Semantic results merge in after a pause, with no flicker and no lost selection.
- [ ] Enter opens Zotero at the right page; Cmd+Enter inserts `[[citekey]]`; Alt+Enter opens the note or the item.
- [ ] Stop Ollama (`brew services stop ollama`) → keyword only, with the footer message.
- [ ] Rebuild the index while Obsidian is open → the next pop-up uses the new index.

## Evaluation: choosing the model, and when to stop

This is the system-level test. Write the queries **before** building anything past the fixtures.

**`eval/queries.toml`** (you write it, 20 or more entries)
```toml
[[q]]
text = "faster stress relaxation made neurons mature quicker"
expect = ["roth2023tunable"]        # one or more acceptable citekeys
kind = "finding"                    # finding | method | topic | author-title

[[q]]
text = "mitochondria moving from immune cells into tumour cells"
expect = ["terasaki2026mitochondrial"]
kind = "finding"
```
Aim for at least 12 `finding` queries written from memory, without looking at the paper. A few of each other kind catch regressions.

**`node scripts/eval.ts --index <dir> [--model M] [--keyword-only]`** prints:
- recall@1, recall@5 and MRR, overall and per `kind`;
- semantic latency p50/p95, measured warm (after a warm-up);
- a list of misses: query, expected paper's rank, top-3 titles, and whether the expected paper's winning row was its abstract or a chunk.

**Steps**
1. **Baseline:** `--keyword-only` on the `0.6b` index. This measures what plain keyword search already gets you.
2. Build with `qwen3-embedding:0.6b` (dims 1024) → evaluate.
3. Build with `qwen3-embedding:4b` (dims 1024, then full 2560 if it helps) → evaluate.
4. Optional: `embeddinggemma` → evaluate.

**Decision rules**
- Pick the smallest model that is within 0.05 recall@5 of the best on `finding` queries.
- Use full dimensions only if they beat 1024 by at least 0.05 recall@5.

**Acceptance (done when all pass)**

| Metric | Target |
|---|---|
| `finding` recall@5 | ≥ 0.85 |
| `finding` recall@1 | ≥ 0.6 |
| Overall MRR | ≥ 0.7 |
| Keyword path per keystroke | < 20 ms at p95 (measured in the eval) |
| Semantic, warm, after the pause | < 300 ms at p95 |
| Index rebuild after one new paper | < 30 s |

**If the targets aren't met, look at the misses before adding anything:**

| What the misses look like | Response (phase 5) |
|---|---|
| The right paper is in the top 10 but rarely first | Reranker on the top 10 after the pause |
| The finding is only in the results or discussion, and the matching chunk ranks low | Extracted highlights: a model *selects* result sentences, kept only if they appear word for word in the PDF text |
| Queries use words the paper doesn't (abbreviations, field jargon) | Raise the abstract weight, or try the larger model at full dimensions |

## Build order

Each phase ends with its tests green and a commit.

| Phase | Work | Tests | Exit |
|---|---|---|---|
| 0 | Fixtures; `eval/queries.toml` (you); CHECK.md | — | 20+ queries written |
| 1 | `zotlib`, `pdftext` | Py 1–13 | `planner search stats` runs on the real library (read-only) |
| 2 | `embed`, `searchindex`, CLI | Py 14–28 | First real index built with `0.6b` |
| 3 | `text`, `bm25`, `vectors`, `rank`, `ollama`, `eval.ts` | TS 1–22 | Keyword baseline and `0.6b`/`4b` results in hand; **model chosen** |
| 4 | `main.ts` UI, settings, symlink install | CHECK.md | You use it for a week |
| 5 | Morning job hook, doctor checks; reranker or highlights only if the evaluation says so | Py 29–31 (+ new) | Acceptance table met |
| later | Same pop-up for vault notes (heading chunks, `obsidian://` links); "related papers" sidebar for the open note; vectors reused for clustering and theme drift | | |

## Rules

- **Never test against the real vault or the real Zotero folder.** Fixtures only. The real library is only read by `search stats`/`search index`, and those write only to `.planner/search/`.
- **Changing `model`, `dims` or the chunker means a full rebuild.** The doctor check enforces it.
- **No generated text in the index.** If highlights are added in phase 5, every stored sentence must appear word for word (after whitespace normalisation) in the PDF text, or it's discarded. That rule has its own test.
- **Dependencies:**
  - Python: none new (`pdftotext` comes from Homebrew poppler).
  - TypeScript: `obsidian` types and `esbuild` as build-time dev dependencies only.
- **Installing the plugin** (the symlink into `.obsidian/plugins/` and enabling it) is a manual step you approve.
