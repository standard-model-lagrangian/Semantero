# Embedding installs: two models in the real plugin and app

Two embedding models, each with its own paper + notes index, that you switch between and judge by using them: the
search pop-up (`⌘⇧0`), `@@` citations, the Related panel and Semantero. One is live at a time; switching swaps
folders, so it takes a second and re-embeds nothing. Background: [EMBED_BENCH_PLAN.md](EMBED_BENCH_PLAN.md) (the
original lineup, why pplx runs frozen), [../pplx/README.md](../pplx/README.md) (how pplx runs).

| Profile | Model | Runs on | Quantisation | Stored per row | Query model in RAM |
|---|---|---|---|---|---|
| `qwen3-0.6b` (`--model qwen`) | Qwen3-Embedding 0.6B | Ollama | Q8_0 | 1 × 1024 | ~0.6 GB |
| `pplx-v2-late` (default for new installs) | pplx-embed-v2-late 0.6B | pinned llama.cpp + `pplxd` | Q8_0 (parity-checked) | ~400 × 128 (one per token) + 1 × 128 | ~0.56 GB |

Qwen3-Embedding 4B and 8B were in the first lineup and were dropped: a marginal gain over the 0.6B for 4–8 h builds and
query models of 4.4–5 GB, too slow to embed new papers and notes as they arrive without scheduling.

## Using them

```bash
.venv/bin/python -m planner profile list            # * marks the live one; size and age of each
.venv/bin/python -m planner profile build pplx-v2-late  # build or update it without touching the live one
.venv/bin/python -m planner profile use pplx-v2-late    # switch, then catch up with changes since it was built
```

After `use`:
- **Semantero** reloads by itself within a few seconds (it watches `.planner/`).
- **Obsidian** picks up the new index the next time you open the search pop-up or the Related panel refreshes; if a
  view looks stale, run "Reload app without saving" once.
- The Zotero watcher, and the 5-minute notes job keep the **live** profile up to date with its own
  model. The others wait as they were; `use` catches a profile up (only new or changed texts are embedded).

Switch to the other one with `planner profile use qwen3-0.6b` or `planner profile use pplx-v2-late`.

**New installs** start on `pplx-v2-late`: `setup-search.sh` downloads the converted model (`pplx/fetch.sh`), starts `com.planner.pplxd` and writes
`<vault>/.planner/profile.json` before the first build. `--model qwen` skips all that and uses `config.toml`'s
`[search]` (Qwen3 through Ollama), as before. Neither touches a vault that already has an index.

## What to look at when judging

The keyword half (BM25) and the merge (RRF, k = 60) are identical in every install, so differences come from the
embedding alone. Things that tend to separate models:
- **findings you half-remember** ("the paper where faster stress relaxation made neurons mature quicker"), the main
  reason semantic search exists here;
- **paraphrase with no shared words** with the paper (a keyword match can't rescue those);
- **methods and concepts across papers** ("microrheology of soft gels") and how sensible ranks 2–10 are;
- **notes**: Semantero's Notes scope, and the Related panel on a few notes you know well;
- **speed**: the delay before semantic results merge in, and the first query after a while (model load).

Pick the queries before switching, run the same list in each install, and note which one put the paper you meant
highest. Writing the good ones into `eval/queries.toml` (or a git-ignored `eval/queries.local.toml` for personal ones)
lets `scripts/eval.ts` score them later.

## Implementation notes: quantisation, dimensions, chunking

- **Same chunks everywhere.** Both use the same chunkers (papers: 300 words with 50 overlap, at most 150 per paper;
  notes: heading sections, 200 words with 40 overlap), so every model ranks the same rows.
- **Quantisation.** Both run at Q8_0 (near-lossless for embeddings). pplx's Q8_0 GGUF was checked against the official
  fp32 output: per-token cosine ≥ 0.9999, the same top result for 20/20 test queries ([../pplx/README.md](../pplx/README.md)).
- **Dimensions.** Qwen stores its native 1024 per row; pplx its native 128 per token.
- **Instructions vs markers.** Qwen embeds documents as they are and queries as `Instruct: … Query: …` (the
  instructions in `config.toml`; the Related panel's own setting). pplx takes no instruction: it prefixes `[Q] ` to
  queries and `[D] ` to documents, as the model was trained, and the instruction settings are ignored.
- **Late interaction (pplx).** pplx keeps one 128-dim vector per token and scores a query by MaxSim: for each query
  token its best match among a row's tokens, summed. The service returns that sum divided by the number of query tokens
  (a mean best-match cosine), so scores sit on a cosine-like scale; ranking is unchanged. Documents drop punctuation-only
  tokens, as the model's own pipeline does. `vectors.f32` holds a 128-dim mean vector per row, used only as the row's
  key into the token cache (see `planner/pplx.py`).
- **Length limits.** Ollama truncates at the model's context (32k/40k tokens: never reached). pplx documents are capped at
  2048 tokens (the model allows 4096; our chunks are ~300–600) and queries at 1024.
- **Related panel threshold.** `relatedMinScore` (0.25) was calibrated for the 0.6B. Other models' scores sit on other
  scales, so the panel may show a few more or fewer papers; the order is what to judge.

## Costs

| | Build from scratch (M4, ~9,100 paper texts; estimates) | Disk |
|---|---|---|
| `qwen3-0.6b` | under an hour | ~55 MB |
| `pplx-v2-late` | ~1–1.5 h | ~20 MB index + ~1 GB token cache in `~/Library/Application Support/Semantero/cache/` |

pplx's token cache lives outside the
vault on purpose: the vault is in Documents, which may sync to iCloud.

## Removing

- One profile: `rm -rf "<vault>/.planner/profiles/<name>"` (not the live one; switch first), and `ollama rm <model>`.
- pplx entirely: `launchctl bootout gui/$(id -u)/com.planner.pplxd`, `rm ~/Library/LaunchAgents/com.planner.pplxd.plist`,
  then delete everything in `~/Library/Application\ Support/Semantero` except `spotlight.json` (the launcher's state
  shares that folder).
- The profile machinery itself stays harmless: with no `<vault>/.planner/profile.json`, `config.toml` decides as before.
