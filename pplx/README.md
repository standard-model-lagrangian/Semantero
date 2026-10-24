# pplx-embed-v2-late, frozen

How the `pplx-v2-late` profile ([../docs/EMBED_INSTALLS.md](../docs/EMBED_INSTALLS.md)) runs
[`perplexity-ai/pplx-embed-v2-late-0.6b`](https://huggingface.co/perplexity-ai/pplx-embed-v2-late-0.6b) (MIT) locally
with nothing that changes under it: one GGUF file and one llama.cpp binary, both pinned and checksummed. Python, torch
and transformers are used once, to convert and check; never at runtime.

## The model, and what llama.cpp does and doesn't do

From the model's `modules.json`: Qwen3.5 text tower (12 layers alternating Gated DeltaNet and full attention, hidden size
1024, **bidirectional**: `is_causal: false`) → `Dense` 1024 → 128, no bias → `MultiVectorMask` (documents drop
punctuation-only tokens) → `Normalize`. Queries are prefixed with the special token `[Q] `, documents with `[D] `, first
(PyLate puts them second; this model doesn't). Scoring is MaxSim.

llama.cpp (build `b11829`) runs the text tower and returns every token's final hidden state (`llama-server
--embedding --pooling none`). The rest is applied in `planner/pplxd.py` from two small files written by
`convert/export_head.py`: `proj.f32` (the Dense weight) and `head.json` (prefix token ids, skiplist token ids, lengths).

## Converting (`make pplx-convert`, once; rerun only to change a version)

`convert/convert.sh`:
1. downloads llama.cpp `b11829` (macOS arm64 binary + source for the converter) and the model at revision
   `7bba8e7cf2075dec747fa8557f41eb90e70361ed`, into `~/Library/Application Support/Semantero/`;
2. a Python 3.12 env from `convert/requirements.lock` (exact versions);
3. `stage.py`: the checkpoint is a `Qwen3_5Model` (text + vision) that the converter doesn't register, so it writes a
   text-only copy (`language_model.*` → `model.*`, `text_config` as `Qwen3_5TextModel`);
4. `convert_gguf.py`: llama.cpp's converter, plus two metadata keys it wouldn't write for this checkpoint:
   `qwen35.attention.causal = false` and pooling `none`; F16, then `llama-quantize` → Q8_0;
5. `reference.py` + `parity.py`: the official sentence-transformers pipeline (fp32, CPU) vs the pinned llama-server on
   `convert/parity_texts.json` (50 synthetic passages from 1 to ~1,300 words, incl. maths, non-Latin text, punctuation
   runs; 20 queries). Results go to `PARITY.md` next to the model;
6. `runtime.json` and `SHA256SUMS` (GGUF, `proj.f32`, `head.json`, the `llama-server` binary). `pplxd` refuses to start
   if any of them changed.

The conversion is deterministic: rerunning it reproduces the same Q8_0 file, byte for byte.

### Parity (23 Oct 2026)

| Check | F16 | Q8_0 (used) |
|---|---|---|
| Token ids identical to the reference tokenizer | 70/70 | 70/70 |
| Per-token cosine, median / min | 1.00000 / 1.00000 | 0.99999 / 0.99993 |
| MaxSim ranking of the 50 passages per query, worst Kendall τ | 0.998 | 0.987 |
| Same top-1 passage | 20/20 | 20/20 |

The first run showed 59 "token mismatches": those were the reference batch's right-padding, not real differences
(`reference.py` now strips them).

## Running (`make pplx-setup`)

`planner/pplxd.py` runs from its own venv (Python 3.12 + numpy, pinned in `requirements-pplxd.txt`) as the launchd job
`com.planner.pplxd`, on `127.0.0.1:11435`:
- starts the pinned `llama-server` on first use (one slot, 2048-token micro-batch, ~0.56 GB resident); llama-server unloads the
  model after 5 idle minutes by itself (`--sleep-idle-seconds`);
- `POST /encode` (index builders): token vectors → the token cache, mean vector → the builder, which stores it in
  `vectors.f32` like any model's vector;
- `POST /rowscores` (plugin, app): encodes the query, MaxSim over the whole token cache in fp16 → fp32 blocks of 64k
  tokens on 4 threads, then each live row's score through its key. Measured on synthetic data: ~200 ms for 4.5M tokens
  on one thread;
- `POST /warm`, `GET /health`.

**Token cache** (`~/Library/Application Support/Semantero/cache/<model>/<vault hash>/`): `tokens.f16` (append-only, 256
bytes a token) and `keys.bin` (one 48-byte record per text: SHA-256 of its mean vector, first token, count). Tokens are
written and synced before their key, so a crash leaves only unreferenced tokens, trimmed on the next start. Texts that
change leave their old tokens behind; to reclaim the space, delete the cache folder and run
`planner profile build pplx-v2-late --full`.

**Why the mean vector is the key:** the builders already keep, per row, the vector the backend returned, reuse it for
unchanged texts and write it to `vectors.f32` in row order. Hashing it gives the service a row → tokens map without
any change to the index format, the incremental logic or the atomic swaps; the service needs nothing but `vectors.f32`.

## Upgrading a pin

Change `LLAMA_TAG` or `HF_REV` in `convert/convert.sh` (and the model name in `profiles.toml` if the revision changes),
run `make pplx-convert`, read `PARITY.md`, then `launchctl kickstart -k gui/$(id -u)/com.planner.pplxd`. A new model
revision means a new model folder and token cache: rebuild the profile with `--full`.
