# Embedding model bench: plan

Status: **implemented as switchable installs instead of a separate bench app** (owner's request, 23 Oct 2026):
see [EMBED_INSTALLS.md](EMBED_INSTALLS.md), [../pplx/README.md](../pplx/README.md) and the decisions log. The rest of
this page is the plan as written; the bench app, blind voting and token-pruning columns were not built. Goal: choose the one embedding model the paper index, the notes index, the Obsidian plugin and Daito Search all use, by comparing contenders side by side in one local app on the owner's real library, then migrate to the winner.

SEARCH_SPEC.md already fixes the rule that there is **one embedding model, recorded in the manifest, and changing it is a full rebuild**. This bench never touches the live index; it builds shadow indexes next to it and the live setup keeps running on `qwen3-embedding:0.6b` until the decision is made.

---

## 1. Contenders

| Slot | Model | Runs on | Vector shape | Notes |
|---|---|---|---|---|
| **A** (baseline) | `qwen3-embedding:0.6b` | Ollama (already installed) | 1 × 1024 per row | What ships today. ~400 MB while loaded. |
| **B** | `qwen3-embedding:4b` | Ollama (already pulled, 2.5 GB) | 1 × 2560, also scored truncated to 1024 | Same family, same instruction format, drop-in. |
| B′ (optional) | `qwen3-embedding:8b` | Ollama (~4.7 GB Q4) | 1 × 4096 / 1024 | Only if B clearly beats A; on a 16 GB M4 it can't sit loaded next to the others. |
| **C** | `perplexity-ai/pplx-embed-v2-late-0.6b` | Frozen GGUF on a pinned `llama-server` (llama.cpp), `--embedding --pooling none` | **many × 128 per row** (one vector per token, MaxSim scoring) | MIT. Qwen3.5-based (hybrid Gated DeltaNet + full attention), 340M active params. Not in Ollama; converted to GGUF once by us. |

Why C is the 0.6B late-interaction model and not another v2 variant:

- `pplx-embed-v2` ships as three models: `late-0.6b`, `late-9b` and `context-9b-preview`. The two 9B models are ~8–9B parameters (the context model publishes F32 weights, ~32 GB). On this 16 GB M4, neither fits next to anything else, so they are out of scope unless we test them on other hardware.
- `context-9b-preview` is also marked as a preview whose interface may change without backward compatibility. That's a poor base for an index meant to stay fixed.
- **C is not a drop-in replacement.** It is ColBERT-style: each chunk becomes ~300–500 vectors of 128 dims, and a query is scored by summing, for each query token, its best match among the chunk's token vectors (MaxSim). The current index format (`vectors.f32`, one row per abstract/chunk), the TypeScript dot-product pass and the Accelerate pass in the app all assume one vector per row. Section 7 spells out what adopting it would cost.
- **How C runs (the frozen route):** Ollama runs on llama.cpp, but its `/api/embed` only returns one pooled vector per input. llama.cpp's own `llama-server` can return every token's hidden state (`--pooling none`), and llama.cpp supports the Qwen3.5 architecture. The model's last step, a linear projection from the hidden size to 128 dims (the sentence-transformers `Dense` module), is one small matrix. We extract it once and apply it ourselves, then L2-normalise. So C is:
  - **converted once**: HF checkpoint → GGUF (text tower only, Q8_0) with llama.cpp's `convert_hf_to_gguf.py`, plus `proj.f32` (the projection matrix) and `markers.json` (the query/document marker tokens);
  - **served by a pinned binary**: one llama.cpp release build kept in `~/Library/Application Support/daito/llama/<build>/`, never installed or upgraded through Homebrew, and started on demand by whoever needs it;
  - **called over HTTP** by every client, just like Ollama today. There is no Python, torch, transformers or sentence-transformers at runtime. The Python environment is used **once**, for the conversion and the reference output, and is then not needed.
  - Documents and queries go through the same frozen file and binary, so the two sides can't drift apart after an update, and a version bump is always a deliberate re-conversion followed by the parity check in Phase 0.
- Optional control: `pplx-embed-v1-0.6b` (single vector, MIT) can be added as slot D. That would show whether a win for C comes from Perplexity's training or from multi-vector scoring. The column costs one more index build.

All contenders are open weights under permissive licences (Apache-2.0 / MIT), in line with the FOSS-only preference.

---

## 2. What is held constant (so the only variable is the embedding)

- **Same rows.** Every shadow index reuses the live index's `papers.json` and `chunks.json` byte for byte (a snapshot copied at bench start), so chunking, page numbers and snippets are identical. Only the vectors differ.
- **Same keyword side.** BM25 with prefix expansion comes from `obsidian/paper-search/src/bm25.ts`, unchanged.
- **Same fusion.** RRF with k = 60 comes from `engine.ts` (`semanticFromRowScores` + the merge), unchanged. The bench supplies per-row semantic scores and the existing engine does the rest. This keeps the "one ranking implementation" rule: the only new scoring code is MaxSim for C, and it outputs the same per-row score array.
- **Same paper aggregation.** A paper's semantic score is its best row, as `scorePaperSemantic` does today.
- **Model-native query formats.** Qwen gets `Instruct: {query_instruction}\nQuery: {q}` with the current instructions (paper and note). pplx gets its own query or document marker, placed **first** as its card requires (PyLate puts markers second, which this model doesn't expect), and no instruction. The markers come from `markers.json`, which records what `encode_query` / `encode_document` prepend in the reference implementation. Each model is run the way its authors intend, not forced into the other's format.
- **Warm measurements.** Every latency figure is taken after a warm-up and reported as p50/p95.

---

## 3. Architecture

```
bench/                                   new, self-contained; nothing else imports it
  README.md                              how to run, where data lives
  convert/                               one-off conversion, run once per model version
    requirements.lock                    exact pins + hashes: torch, sentence-transformers>=6, transformers>=5.4, gguf, numpy
    convert.sh                           fetch pinned llama.cpp build + model revision → GGUF (Q8_0), proj.f32, markers.json
    reference.py                         sentence-transformers reference vectors for the parity check (Phase 0)
    parity.py                            llama-server output vs reference: per-token cosine, MaxSim rank agreement
  llamaserver.py                         stdlib-only client: start pinned llama-server on demand, POST /embeddings, apply proj, normalise
  build_index.py                         shadow index builder, stdlib only (Qwen via planner/embed.py, pplx via llamaserver.py)
  server.ts                              Node HTTP server: loads corpora once, serves the UI and /search, /related, /eval, /vote
  scorers.ts                             one interface, implementations: OllamaDense, OllamaDense@dims, PplxLate (+ pruned variants)
  maxsim.ts                              MaxSim over the mmapped token store → per-row scores; int8 dequant; the only new scoring code
  metrics.ts                             recall@k, MRR, nDCG@10, bootstrap CIs, win-rates
  ui/index.html, ui/app.js, ui/app.css   vanilla, no build step
  test/                                  unit tests on fixtures + fakes (no network)
Makefile                                 bench-convert, bench-index, bench
```

**Data location:** personal data stays out of the repo, so everything the bench writes goes to `~/Library/Caches/daito-bench/`:

```
snapshot/{search,notes}/                 read-only copy of the live index (papers.json, chunks.json, manifest)
qwen3-0.6b/{search,notes}/vectors.f32    copied from the live index (no rebuild needed)
qwen3-4b/{search,notes}/vectors.f32      2560 dims, truncated to 1024 at load for the B@1024 column
pplx-late-0.6b/{search,notes}/tokens.i8 + scales.f32 + offsets.u32 + tokids.u32
                                         per-token vectors, int8 with a per-vector scale, row r = tokens[offsets[r]:offsets[r+1]];
                                         token ids kept so pruning variants are computed at load, not rebuilt
judgments.jsonl                          the owner's votes and relevance marks (append-only)
runs/<timestamp>.json                    each eval run's full results
```

The model files live apart from the data, because they are part of the frozen runtime:

```
~/Library/Application Support/daito/llama/<llama.cpp build>/llama-server        pinned release binary (+ its dylibs)
~/Library/Application Support/daito/models/pplx-embed-v2-late-0.6b@<hf revision>/
    model.q8_0.gguf, proj.f32, markers.json, SHA256SUMS, PARITY.md (the Phase 0 result for this exact pair)
```

**Process layout while the app is running:**

```
browser ── http://127.0.0.1:8765 ──► server.ts (Node 26, runs .ts natively)
                                       ├─ BM25 + RRF + snippets (existing engine code)
                                       ├─ Ollama :11434      → query vector for A, B → rowScores (dot product)
                                       └─ llama-server :8766 → query token states → proj → maxsim.ts → per-row scores for C
```

`maxsim.ts` returns a `Float32Array` of per-row scores, which is the same thing `rowScores()` returns for the dense models. From there every column goes through identical code. The token store is mmapped, so the OS can drop its pages under memory pressure and it is not held as private memory.

**llama-server lifecycle:** started by whichever client first needs it (bench server, indexer), bound to 127.0.0.1 only, with a pidfile in `~/Library/Caches/daito-bench/`. An idle timer stops it after 5 minutes without a request, mirroring Ollama's `keep_alive`. A launchd job is not needed for the bench.

**Isolation from the two setups:** the runtime path (`llamaserver.py`, `build_index.py`, `server.ts`, `maxsim.ts`) uses only the standard library and Node. Torch lives only in `bench/convert/.venv`, used once for the conversion and the parity check, and never enters the main venv, whose only dependency stays `anthropic`. `make check` runs the bench's Node unit tests, which need no models, and nothing else. The Obsidian-only setup is unaffected.

### Keeping the token store small

The full-precision store would be ~3.5M token vectors for papers alone (~0.9 GB at fp16). The bench stores and tests three reductions. Each pruned variant is its own column, so its cost in quality is measured on the same queries rather than assumed:

| Variant | What it does | Expected size (papers) |
|---|---|---|
| **C** (full) | every document token, int8 + per-vector scale | ~0.45 GB |
| **C-prune** | drops document tokens that are punctuation, whitespace or in a fixed stopword list (by token id, from `tokids.u32`), as ColBERTv2-style systems do | ~0.3 GB (−30–40%) |
| **C-prune-dedup** | C-prune, then also merges near-duplicate vectors within a row (cosine > 0.97 to an already-kept vector in the same chunk) | measured |

- Query tokens are never pruned: queries are short and each query token contributes one MaxSim term.
- int8 vs fp16 is checked once in Phase 0 (MaxSim rank agreement > 0.99 on the reference set). If int8 fails, the store stays fp16 and the sizes double.
- Pruning is applied at load from `tokids.u32`, so trying a different stopword list never needs a rebuild.

---

## 4. The app

One page, three tabs.

### Tab 1: Search (side by side)

- A query box, a scope switch (Papers / Notes / Both, matching the launcher scopes) and a mode switch:
  - **Hybrid** (what users see: BM25 + dense, RRF), the default;
  - **Dense only** (the embedding alone, which shows the real difference that RRF partly hides);
  - **Keyword** (a single reference column showing what BM25 alone returns).
- One column per contender, top 10 each. Each row shows title, year, citekey or note path, the winning snippet with its page, the row type (abstract or chunk) and the semantic score.
- Cues across columns:
  - A badge on results that appear in only one column.
  - A rank delta against the baseline (↑3, ↓2, new).
  - Hovering a result highlights it in every column.
- Per-column footer: query-embedding latency, scoring latency, total.
- **Blind mode** (on by default): columns are shuffled and labelled A/B/C per query, and model names stay hidden until you have voted.
- **Judging:**
  - Mark any result as relevant with 0/1/2 stars (graded relevance, stored per citekey or note path so it carries across columns and future runs).
  - Then give a per-query verdict: best column, tie, or all bad.
  - Keyboard: `1`–`4` picks a column, `0` marks a tie, `j/k` moves between rows, `r` stars a row.
  - Votes are appended to `judgments.jsonl` with the query, the shuffled order, each column's top 10 and the time.

### Tab 2: Related papers (the sidebar panel's path)

- Pick a vault note (searchable list) or paste a passage. The bench builds the passage exactly as `related.ts` does: section or cursor extraction, markdown cleaning, at most 2000 characters at sentence boundaries.
- Each model's related list appears side by side with its own `relatedMinScore`. Scores are not comparable across models (pplx MaxSim sums are on a different scale than Qwen cosines), so each model gets its own threshold, calibrated in tab 3.
- **Stored-vector mode for C (no encoder call):** a vault note is already in the notes index, so its sections' token vectors are already on disk. For a picked note, C can use the stored vectors of the note's section (or of the section around the cursor) as the "query" and run MaxSim against the paper store. That needs no `llama-server`, no model in memory and no encoding latency. It is shown as an extra column, **C-stored**, next to C (live-encoded passage), so the bench measures whether it matches.
  - Caveat: the stored vectors are as fresh as the notes index (the 5-minute tick), so text typed in the last few minutes isn't reflected. Pasted passages always use live encoding.
  - Long sections make long "queries" (hundreds of tokens), which makes MaxSim slower and favours long papers. The bench caps the query side at the section's first 256 document tokens after pruning, and reports latency for this column separately.
- Judging works the same way as in tab 1.

### Tab 3: Scorecard

- **Run eval** runs every contender over `eval/queries.toml` and `eval/related.toml` plus every query you've judged in tabs 1–2, then shows:

  | | A 0.6b | B 4b@1024 | B 4b@2560 | C | C-prune | C-prune-dedup |
  |---|---|---|---|---|---|---|
  | recall@1 / @5, MRR (finding, method, topic, author-title, all) | | | | | | |
  | nDCG@10 on your starred judgments | | | | | | |
  | Related Hit@5 (+ calibrated min score); for C also C-stored | | | | | | |
  | Blind win-rate (n votes, 95% CI) | | | | | | |
  | Query latency p50 / p95 (warm): embed + score | | | | | | |
  | Cold first query (includes starting llama-server for C) | | | | | | |
  | Model RAM while loaded | | | | | | |
  | Index size on disk (papers + notes) | | | | | | |
  | Full build time | | | | | | |

  In blind voting, the C variants count as one column (the one you pick in Settings, C-prune by default), so you are not shown three near-identical columns.

- 95% bootstrap confidence intervals on every quality metric. With ~40–60 queries a difference of one or two hits is noise, and the scorecard should say so rather than crown a winner on it.
- A misses list per model: query, the expected item's rank, and what came first instead.
- Pairwise "who got it and who didn't" counts (A-only, B-only, both, neither), which say more than averages at this sample size.
- Export: **Save run** writes `runs/<timestamp>.json` and copies a markdown summary for DECISIONS_AND_GAPS.md. The summary holds aggregate numbers only, with no queries or titles, because the repo is public.

---

## 5. Evaluation set

The current set has 38 paper queries (24 finding, 7 method, 4 topic, 3 author-title), 11 related-panel notes and **no notes-search queries**. That is too thin to separate models that are close.

Before looking at any bench results:

1. **Add 20 fresh `finding` queries**, written from memory without opening the papers, the way the existing ones were. They are the most realistic query type and the one the decision rule uses.
2. **Add 15 notes queries** (`expect_note = [...]`), since notes search currently has no ground truth at all.
3. **Add 5–10 related-panel cases** covering long notes and notes that cite several papers.

The new cases go in git-ignored `eval/queries.local.toml` and `eval/related.local.toml`, because they name personal notes. The loaders merge them with the committed files. The existing parsers (`parseQueries`) already accept both shapes.

Then, during normal work over a week, run real queries in tab 1 and vote, with **≥ 30 blind votes** before reading the win-rates.

---

## 6. Build and run sequence

**Phase 0: conversion and spikes, go/no-go (½–1 day)**

- **S-a: reference output.** In `bench/convert/.venv` (locked), load pplx-embed-v2-late-0.6b with `MultiVectorEncoder` (CPU is fine; MPS optional). Write reference token vectors for a fixed parity set, saved outside the repo:
  - 50 synthetic or public-domain passages of 50–400 words;
  - 20 queries;
  - edge cases: an empty string, a single word, text over the maximum length, non-ASCII text and maths.
  
  Also record what the model's modules are (Transformer → Dense 128? normalisation?), the exact marker tokens, the maximum length, and tokens per 300-word chunk.
- **S-b: conversion.**
  - Pin a llama.cpp release; record the tag and SHA256 of the binary.
  - Run `convert_hf_to_gguf.py` on the text tower at a pinned HF revision, producing F16 and Q8_0.
  - Extract the `Dense` weights to `proj.f32` and the marker tokens to `markers.json`.
  - Expected snags:
    - the multimodal checkpoint needs its vision tower stripped or ignored;
    - the converter may not recognise the repo's architecture name, which may need a one-line `--model-arch` mapping or a small patch kept in `bench/convert/`;
    - the tokenizer must match exactly.
- **S-c: parity (the acceptance test for the conversion).** Run `llama-server --embedding --pooling none` on the parity set, apply `proj.f32`, normalise, and compare with S-a:

  | Check | Pass |
  |---|---|
  | Token ids identical to the reference tokenizer | 100% of inputs |
  | Per-token cosine, F16 GGUF vs reference | median ≥ 0.999, min ≥ 0.99 |
  | Per-token cosine, Q8_0 GGUF vs reference | median ≥ 0.995, min ≥ 0.98 |
  | MaxSim ranking of the 50 passages for each of the 20 queries (Q8_0 vs reference) | Kendall τ ≥ 0.95, same top-1 in ≥ 19/20 |
  | int8 token store vs fp16 store (same GGUF) | same top-1 in 20/20 |

  The result is written to `PARITY.md` next to the model files, with the llama.cpp tag, the HF revision and the hashes. **No parity, no column:** if F16 passes but Q8_0 doesn't, C runs F16; if neither passes, the fallback below applies.
- **S-d: speed and memory.**
  - llama-server: documents/s at batch 8/16/32, query latency p50/p95 for a 20-token query, RSS while loaded, cold start time.
  - `qwen3-embedding:4b` through Ollama: throughput at batch 32, and RAM.
- **S-e: MaxSim cost.** Score one query against the full paper token store (full, C-prune) in `maxsim.ts`. Target < 150 ms p95.
  - If that misses, add a candidate stage: the top 200 rows by C's mean-pooled vector, then MaxSim on those. It runs as a separate column, so the shortcut's cost is measured, not assumed.
- **Fallback if the conversion fails:** C runs from a frozen, hash-locked Python environment (sentence-transformers) used for indexing and queries in the bench only. The scorecard marks C as "not frozen". The plan then says that adopting C needs either a fix upstream in llama.cpp or a permanent Python service (section 7).
- Output: the parity table and the speed numbers go in a short note in DECISIONS_AND_GAPS.md.

**Phase 1: shadow indexes (test-first; builds run in the background, resumable)**
- `build_index.py --model {qwen3-4b|pplx-late-0.6b} --corpus {search|notes}`:
  - reads the snapshot;
  - embeds in batches, flushing to `*.partial` every N rows so an interrupted build resumes;
  - writes through `.tmp` and then a swap, matching the index writers' rule;
  - checks that the row count equals the snapshot's.
- Qwen documents are embedded without an instruction (as now). pplx documents get the document marker and go through `llamaserver.py` (projection, normalisation, int8 with a per-vector scale, token ids kept for pruning).
- Unit tests with a fake llama-server: projection and normalisation, int8 round-trip error, offsets, resuming from `*.partial`, and refusing to write when the model file's hash differs from `SHA256SUMS`.
- The baseline (A) needs no build: its vectors are copied from the live index.
- Expected build time: tens of minutes per model on the M4. Phase 0 measures it.

**Phase 2: server + scorers (test-first)**
- `scorers.ts` gets a fake-Ollama test and a fake-llama-server test, plus a test that, given the same per-row scores, the bench's results equal `engine.ts`'s exactly. That test proves the bench adds no ranking code of its own.
- `maxsim.ts` gets tests against hand-computed MaxSim on a tiny store, including pruned rows, an empty row after pruning (score 0, never NaN) and the C-stored query path.
- `metrics.ts` gets unit tests for recall, MRR, nDCG and bootstrap against hand-computed cases.

**Phase 3: UI.** Tabs 1–3 above. Checked in the in-app browser at desktop width and at 375 px.

**Phase 4: judge (owner, about a week of normal use).** Write the new eval cases first, then use tab 1 for real queries, and finish with a scorecard run.

**Phase 5: decide, then migrate (section 7).**

New commands:

```
make bench-convert   # once: locked convert venv, pinned llama.cpp build, GGUF + proj + markers, parity check → PARITY.md
make bench-index     # snapshot + build B and C shadow indexes (background-friendly, resumable; stdlib only)
make bench           # start server (llama-server starts on demand), open http://127.0.0.1:8765
```

---

## 7. Deciding, and what each outcome costs

**Decision rule.** This extends SEARCH_SPEC's rule; the owner makes the final call.

1. **Quality bar:** on `finding` queries, the smallest model within 0.05 recall@5 of the best counts as "as good". Use full dimensions only if they beat 1024 by ≥ 0.05.
2. **Your judgment:** a model wins outright only if its blind win-rate CI excludes the others'. Otherwise it is a tie on quality, and the next rule decides.
3. **Operational guardrails:** these break ties, and they veto only if they're badly missed:
   - query embedding p95 < 150 ms warm (the launcher's semantic pass must not lag typing);
   - model RAM while loaded ≤ ~3 GB on a 16 GB machine;
   - a rebuild of the full library stays a coffee-break job, not an overnight one.

**Migration cost by winner:**

| Winner | Work | Size |
|---|---|---|
| A, stay on 0.6b | Record the result in DECISIONS_AND_GAPS.md. Keep the expanded eval set. | Hours |
| B, Qwen3 4b | `config.toml` `[search] model/dims` → full rebuild of both indexes. Re-run `eval-related.ts` to recalibrate `relatedMinScore`. Update the RAM figures (~400 MB → ~3 GB while loaded) and the `keep_alive` comment. Re-run perf budgets B1–B14 and the launcher memory checks. Doctor's model check follows config automatically. Plugin, launcher-core, Swift: no code change (same Ollama API, same vector format). | ~1 day |
| C, pplx-embed-v2-late (frozen GGUF route, Phase 0 passed) | 1. A new index format (int8 token store + scales + offsets, the winning pruning variant, manifest `format: 2`, `scoring: "maxsim"`, plus the model file's hash). 2. `planner/embed.py` gains a llama-server backend (stdlib HTTP, same as Ollama), and the plugin and the app gain a matching client. 3. The pinned llama-server and the model files are installed by `make install-global` / `setup-search.sh` into `~/Library/Application Support/daito/`, started on demand with an idle stop, and checked by `doctor` (binary and model hashes, parity file present). 4. MaxSim in the shared TS core (from `maxsim.ts`) and in the Accelerate path in Swift, plus conformance cases. 5. The launcher mmaps the token store instead of loading it, so its own memory budget barely moves (the pages belong to the OS cache). 6. The Related panel uses stored note vectors when they are fresh (if C-stored matched C in the bench). No Python or torch at runtime; the Obsidian-only setup gets one downloaded binary and one model file instead of an Ollama model. | **Several days**; gets its own spec before starting |
| C, fallback route (Phase 0 failed) | Same as above, but item 2 becomes a permanent, hash-locked Python service with torch (~1.5–2 GB while loaded) that the plugin, the app and the indexer call, and the Obsidian-only setup gains Python + torch. | Several days to build, plus ongoing upkeep; not recommended unless C's lead is large |

**Upkeep after the switch:**

| | Runs on | What can break on an update | RAM while loaded |
|---|---|---|---|
| A / B | Ollama (updates itself) | an Ollama release changing `/api/embed` or the model's quantisation | ~0.4 GB (A), ~3 GB (B) |
| C, frozen | pinned llama-server + pinned GGUF | nothing, until we deliberately bump either; a bump re-runs `make bench-convert` and its parity check | ~0.65 GB (Q8_0), measured in Phase 0 |

The difference in migration cost is why the scorecard reports C's margin with confidence intervals: C should be adopted only if its lead is clear enough to justify several days of work and a second runtime next to Ollama (which still runs `qwen3:8b` for extraction fallback).

---

## 8. Risks

- **The GGUF conversion:** this is a fine-tune of a multimodal Qwen3.5 checkpoint with hybrid attention (Gated DeltaNet + full attention). llama.cpp's converter may not accept it as is, and a quiet mismatch (a wrong tokenizer, a missing final norm, markers in the wrong place) would produce plausible but worse vectors. The parity check in Phase 0 exists for exactly this; nothing is built on C until it passes, and the fallback is written down.
- **Projection and normalisation done outside the model:** a mistake there wouldn't crash, only degrade results. Covered by the parity check (which compares the final 128-d vectors, not hidden states) and by unit tests.
- **Pruning hurting recall:** each variant is a measured column; the default store is chosen from the scorecard, not assumed.
- **C-stored drifting from C:** the bench shows both side by side; C-stored is only adopted for the Related panel if it matches C within the CIs.
- **Memory while benchmarking:** A + B + C loaded together is about 0.6 + 3 + 0.65 GB, which is fine. Adding B′ (8b) is not, so the 8b column, if added, loads on demand with `keep_alive: 0`.
- **Score scales differ** (cosine vs MaxSim sum), so the bench never compares raw scores across columns: RRF only uses ranks, and related-panel thresholds are calibrated per model.
- **Small eval set:** mitigated by section 5, bootstrap CIs and pairwise hit counts.
- **Live index changes during the bench:** the bench uses its snapshot. A **Re-snapshot** button rebuilds the shadow indexes from the current live index.
- **Privacy:** queries, titles, judgments and runs live in `~/Library/Caches/daito-bench/`. Only aggregate numbers ever go into the repo.

---

## 9. Done when

- [ ] Phase 0 numbers recorded; GGUF parity table passed and saved as `PARITY.md` with the llama.cpp tag, HF revision and hashes (or the fallback route taken, with the reason recorded).
- [ ] Shadow indexes for B and C built from the same snapshot; row counts match; C's pruned variants computed at load.
- [ ] Bench tests pass under `make check`; equivalence test proves identical ranking given identical row scores.
- [ ] App shows all contenders side by side for search, notes and related (including C-stored), blind by default, with votes persisted.
- [ ] The bench runs with no Python package beyond the standard library: torch is used only by `make bench-convert`.
- [ ] ≥ 60 labelled queries and ≥ 30 blind votes; scorecard run saved.
- [ ] Decision and aggregate numbers recorded in DECISIONS_AND_GAPS.md; migration for the winner planned (B) or specced (C).
