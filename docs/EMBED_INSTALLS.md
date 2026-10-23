# Embedding installs: four models in the real plugin and app

Four embedding models, each with its own paper + notes index, that you switch between and judge by using them: the
search pop-up (`⌘⇧0`), `@@` citations, the Related panel and Daito Search. One is live at a time; switching swaps
folders, so it takes a second and re-embeds nothing. Background: [EMBED_BENCH_PLAN.md](EMBED_BENCH_PLAN.md) (why these
four, why pplx runs frozen), [../pplx/README.md](../pplx/README.md) (how pplx runs).

| Profile | Model | Runs on | Quantisation | Stored per row | Query model in RAM |
|---|---|---|---|---|---|
| `qwen3-0.6b` (current) | Qwen3-Embedding 0.6B | Ollama | Q8_0 | 1 × 1024 | ~0.6 GB |
| `qwen3-4b` | Qwen3-Embedding 4B | Ollama (`qwen3-embedding:4b-q8_0`) | Q8_0 | 1 × 2560 | ~4.4 GB |
| `qwen3-8b` | Qwen3-Embedding 8B | Ollama (`qwen3-embedding:8b`) | Q4_K_M | 1 × 4096 | ~5 GB |
| `pplx-v2-late` | pplx-embed-v2-late 0.6B | pinned llama.cpp + `pplxd` | Q8_0 (parity-checked) | ~400 × 128 (one per token) + 1 × 128 | ~0.56 GB |

## Using them

```bash
.venv/bin/python -m planner profile list            # * marks the live one; size and age of each
.venv/bin/python -m planner profile use qwen3-4b    # switch, then catch up with changes since it was built
.venv/bin/python -m planner profile build qwen3-8b  # build or update one without touching the live one
```

After `use`:
- **Daito Search** reloads by itself within a few seconds (it watches `.planner/`).
- **Obsidian** picks up the new index the next time you open the search pop-up or the Related panel refreshes; if a
  view looks stale, run "Reload app without saving" once.
- The Zotero watcher, the 5-minute notes tick and the morning run keep the **live** profile up to date with its own
  model. The others wait as they were; `use` catches a profile up (only new or changed texts are embedded).

Switch back to the current setup with `planner profile use qwen3-0.6b`.

## What to look at when judging

The keyword half (BM25) and the merge (RRF, k = 60) are identical in every install, so differences come from the
embedding alone. Things that tend to separate models:
- **findings you half-remember** ("the paper where faster stress relaxation made neurons mature quicker"), the main
  reason semantic search exists here;
- **paraphrase with no shared words** with the paper (a keyword match can't rescue those);
- **methods and concepts across papers** ("microrheology of soft gels") and how sensible ranks 2–10 are;
- **notes**: Daito Search's Notes scope, and the Related panel on a few notes you know well;
- **speed**: the delay before semantic results merge in, and the first query after a while (model load).

Pick the queries before switching, run the same list in each install, and note which one put the paper you meant
highest. Writing the good ones into `eval/queries.toml` (or a git-ignored `eval/queries.local.toml` for personal ones)
lets `scripts/eval.ts` score them later.

## Implementation notes: quantisation, dimensions, chunking

- **Same chunks everywhere.** All four use the same chunkers (papers: 300 words with 50 overlap, at most 150 per paper;
  notes: heading sections, 200 words with 40 overlap), so every model ranks the same rows.
- **Quantisation.** The 0.6B models and the 4B run at Q8_0 (near-lossless for embeddings). The 8B runs at Ollama's
  default Q4_K_M: at Q8_0 it is 8.1 GB, too much to keep loaded next to Obsidian on 16 GB. pplx's Q8_0 GGUF was checked
  against the official fp32 output: per-token cosine ≥ 0.9999, the same top result for 20/20 test queries
  ([../pplx/README.md](../pplx/README.md)).
- **Dimensions and Matryoshka.** Each Qwen profile stores its native width (1024 / 2560 / 4096), so you judge each model
  at its best. Qwen3-Embedding is Matryoshka-trained: the first N values of a stored vector, re-normalised, are what an
  N-dim index would hold, so a cheaper 1024-dim variant of the 4B or 8B can be cut from the stored vectors later
  without re-embedding, if one of them wins. The plugin loads `vectors.f32` into memory: ~90 MB of papers vectors for
  the 4B, ~150 MB for the 8B, against ~37 MB today.
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

| | Build from scratch (M4, ~9,100 paper texts; estimates from the first batches) | Disk |
|---|---|---|
| `qwen3-0.6b` | under an hour | ~55 MB |
| `qwen3-4b` | ~4 h | ~110 MB |
| `qwen3-8b` | 6 h or more | ~170 MB |
| `pplx-v2-late` | ~1–1.5 h | ~20 MB index + ~1 GB token cache in `~/Library/Application Support/daito/cache/` |

Builds of different profiles compete for the GPU, so they run one after another. pplx's token cache lives outside the
vault on purpose: the vault is in Documents, which may sync to iCloud.

## Removing

- One profile: `rm -rf "<vault>/.planner/profiles/<name>"` (not the live one; switch first), and `ollama rm <model>`.
- pplx entirely: `launchctl bootout gui/$(id -u)/com.planner.pplxd`, `rm ~/Library/LaunchAgents/com.planner.pplxd.plist`,
  `rm -rf ~/Library/Application\ Support/daito`.
- The profile machinery itself stays harmless: with no `<vault>/.planner/profile.json`, `config.toml` decides as before.
