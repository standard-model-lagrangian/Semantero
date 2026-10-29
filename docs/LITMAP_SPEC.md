# Weekly literature map: spec (test-driven)

Once a week, show where the papers you added to Zotero landed in your library. It is one shared 3-D map of every paper
you have. The last few weeks' additions are coloured by age (newest darkest), so you can see three weeks of reading in
one view. A line joins each of this week's papers to the earlier paper that covers it best. Below the map, a note says
for each new paper how much of it your library already covered, which earlier paper is closest, whether it combines
things no single earlier paper covers, and the closest pair of passages, quoted.

Status: **M1 implemented** (`planner/litmap.py`, `planner litmap`, tests LM1–LM15). Not built yet: `litmap sweep`, the
weekly launchd job, the doctor check and the plugin's 3-D view (see [Milestones](#milestones)). Same rules as the
other specs: see [AGENTS.md](../AGENTS.md). It reads the paper index built by [SEARCH_SPEC.md](SEARCH_SPEC.md) and
changes nothing in it.

## Principles

- **Local, no new dependencies.** Python standard library only, like the rest of `planner/` (numpy stays inside
  `pplxd`). It uses the vectors already in `.planner/search/vectors.f32`. Its only network call is to the local pplx
  service, to score the quoted passages, and it works without it.
- **Each job gets the measure that suits it.** Several ways of comparing papers agree equally well with how you file
  them (see [Measuring paper similarity](#measuring-paper-similarity)), so each job uses the one that gives it what it
  needs: the cheapest for the map, a one-directional one for novelty, the model's own scoring for any passage quoted.
- **Relative distances over neat clusters.** The map has to keep "A is closer to B than to C" roughly true across the
  whole library, not just draw tidy islands.
- **The map is for finding your way, and the numbers are the truth.** Every claim of the form "this paper is far from
  what you had" comes from the full vector space, never from the plot.
- **Every claim comes with its evidence.** The closest earlier passage is quoted next to the new one. Nothing says
  whether a claim is true.
- **Dots stay where they are.** A paper keeps its position from week to week. Only new papers get placed. Everything
  moves only when the layout is rebuilt on purpose (a new *epoch*, below).
- **One map, with weeks shown by colour.** Earlier weeks are filtered views of the same layout (papers whose Zotero
  `dateAdded` falls in that week). Nothing per week has to be stored, and any past week can be drawn at once.
- **Never colour alone, and safe for colour-blind readers.** Week age is shown by the lightness of one hue. A legend
  and the note's text always back it up.
- **Zero input.** Nothing to tag or answer.
- **Off by default.** `[litmap] enabled = false` in `config.toml`. The Obsidian-only setup is unchanged.

## What the data looks like (owner's library, 28 Oct 2026)

204 papers, all with a Zotero `dateAdded` (no bulk-import clumps: at most 4 papers in the same minute); 195 have text
chunks, a median of 48 chunks of about 1,900 characters each. Weekly additions range from 0 to 32, and most weeks have
1 to 3. One week on its own is often a single dot, which is why the map shows several weeks over the whole library.

The index stores one 128-dim vector per chunk. For the pplx model that vector is the mean of the chunk's token vectors
(the model itself scores token by token, with MaxSim; [pplx/README.md](../pplx/README.md)). **Chunk records name their
vector row** (`chunks.json` → `row`): each paper's title-and-abstract row (`abstractRow`) sits just before its chunks,
so a chunk's position in the list is not its row. An early analysis for this spec got that wrong; every number below
is from the corrected run.

## Measuring paper similarity

Measured once on the owner's library with a scratch script (numpy, 195 papers). "Related" was approximated by two
labels the owner already keeps: the two papers share a Zotero collection (180 papers, 23 % of pairs), or share a tag
(102 papers, 7 % of pairs). Score: AUC (0.5 is chance, 1.0 perfect). Citations in notes were too rare to use (3 notes
cite two or more papers). These labels only test *topical* similarity; whether a new or bridging paper is worth your
time is the owner's call (see [Evaluation](#evaluation-and-kill-criterion)).

| Measure | Same collection | Shared tag |
|---|---|---|
| Average best match per chunk ("Chamfer") | 0.84 | 0.87 |
| Paper mean vector, centred | 0.84 | 0.86 |
| Optimal transport between chunk sets | 0.84 | 0.87 |
| Shared nearest neighbours | 0.84 | 0.85 |
| Title + abstract vector only | 0.82 | 0.86 |
| Paper mean vector, not centred | 0.81 | 0.80 |
| Top-5 best chunk pairs / single best pair | 0.80 / 0.78 | 0.82 / 0.80 |
| Distribution distance (MMD) | 0.80 | 0.84 |
| Share of chunks with a close match | 0.73 | 0.75 |
| Subspace angles | 0.69 | 0.72 |

The top five overlap within their 90 % intervals (about ±0.04). Other findings that set the design:

- **Centre the vectors.** Raw mean-token vectors share one big common direction (median cosine distance between two
  papers 0.009). Subtracting the library mean spreads that to a median of 1.05 and ranks better (0.84 against 0.81).
- **Token-level MaxSim adds nothing at paper level** (rank correlation 0.91 with chunk Chamfer; on a 30-paper subset
  both score 0.90–0.91), **but chunk mean vectors are a weak stand-in at passage level**: their ranking of chunk pairs
  correlates 0.48 with MaxSim, and only 36 % of a chunk's 10 nearest chunks are the same. So a quoted passage is chosen
  with MaxSim.
- **Best-match measures are swamped by junk.** 27 % of each paper's single best match in another paper involves a
  reference list or boilerplate. Unfiltered, the top "bridge" pairs all matched on reference lists; after that come
  author lists, reproducibility checklists, tables of numbers and garbled PDF text. Averaging measures barely notice.
- **qwen3-embedding vectors are no better** (0.80 against pplx's 0.83 on the 165 papers both indexes have).
- **Hubs are modest.** The top 1 % of chunks take 5.8 % of all top-10 neighbour slots; 8 % of chunks are nobody's
  neighbour. A hub correction (CSLS) brings that to 1 % at a small cost in topical agreement (0.82): worth it for
  serendipity features, not for this map.

## Choosing the layout

Each paper needs a position, not a group. Two scores, measured on the centred paper vectors:

- *Global*: the rank correlation between every pair's real distance and its distance on the map ("are relative
  distances consistent?").
- *Local*: the share of each paper's 10 nearest neighbours that are still among its 10 nearest on the map.

| Method | Global, 2-D | Global, 3-D | Local, 2-D | Local, 3-D |
|---|---|---|---|---|
| PCA | 0.86 | 0.88 | 0.38 | 0.44 |
| Metric MDS | 0.87 | 0.91 | 0.43 | 0.50 |
| **MDS with Sammon weighting** | 0.86 | **0.90** | 0.43 | **0.54** |
| t-SNE, perplexity 5 / 15 / 30 | 0.68 / 0.70 / 0.73 | 0.70 / 0.71 / 0.73 | 0.57 / 0.64 / 0.65 | 0.60 / 0.69 / 0.69 |

- **3-D helps every method**, by up to 0.04 on the global score and 0.03 to 0.11 on the local one.
- **t-SNE keeps neighbourhoods best but scrambles the global picture.** Its gaps between clusters mean little.
- **MDS with Sammon weighting is the compromise.** It fits the real distances, with small distances counting more. It
  has almost no settings and gives the same answer on every run (rank correlation 1.00 across seeds; t-SNE 0.98).
- **Paper mean vectors, not Chamfer, feed the map.** A Chamfer distance matrix lays out about as well (0.89 / 0.49) but
  costs far more and adds nothing the map can show.

## Pipeline

1. **Papers and dates.** Read `papers.json`, `chunks.json` and `vectors.f32` from the live paper index. Read
   `items.key → dateAdded` from Zotero through `zotlib.open_snapshot` (never the live file), and convert it from UTC to
   local time. Weeks are ISO weeks in local time. A paper with no Zotero date or no chunk vectors is skipped and
   counted. *Decision:* the date is read at render time and not added to `papers.json`.
2. **Vectors.** A chunk's vector is the row its record names, normalised. Chunk vectors are centred on the library's
   mean chunk vector and normalised again. A paper's vector is the normalised mean of its raw chunk vectors, centred on
   the mean paper vector and normalised again. Both means are recomputed on every run from the current library; that
   moves no pinned point.
3. **Junk.** A chunk is junk when it reads like a reference list (8 or more years), names boilerplate (licence,
   copyright, funding, acknowledgements, competing interests, author contributions, data availability,
   correspondence), is an author list (15 or more initials), is a checklist or reporting summary, or is mostly not
   letters (under 60 % letters among its non-space characters, or control characters: tables and broken PDF text).
   Junk chunks take no part in novelty and are never quoted. A paper whose chunks are all junk keeps all of them.
4. **Novelty** (for each paper `p`, against `E`: the papers added **before `p`'s week started**, so five papers on a
   new topic can't make each other look familiar):
   - *Candidates:* the 40 papers in `E` whose paper vectors are closest to `p`'s (all of `E` if it is smaller). This
     keeps the cost at seconds; the exact version compares every chunk of the library.
   - `cover(p→q)`: the mean over `p`'s chunks of each chunk's best cosine with a chunk of `q` (one-directional
     Chamfer: how much of `p` does `q` cover).
   - `nearest(p)`: the candidate with the highest `cover(p→q)`.
   - `library cover(p)`: the mean over `p`'s chunks of each chunk's best cosine with any candidate chunk.
     **Novelty** is `1 − library cover`, shown as a percentile among every paper's novelty at the time it was added.
   - **Recombination** is `library cover − cover(p→nearest)`: high when no single earlier paper covers `p` but the
     library as a whole does (a new combination of familiar things).
   - Per week: **spread**, the mean pairwise paper-vector cosine among the week's additions (0 is as alike as
     two random papers of the library), and **mean novelty**. (A centroid "drift" was tried and dropped: on
     centred vectors the centroid of everything before a week points away from that week by construction.)
5. **Quoted passages** (this week's papers only). Candidate pairs are the 3 best chunk pairs between `p` and
   `nearest(p)` by cosine, junk excluded, with distinct chunks of `p`. When the live index is the pplx profile and the
   service answers, each candidate chunk of `p` is sent to `/rowscores`, and the best chunk of `nearest(p)` by MaxSim
   wins. The service's `content_hash` must match the index that was read, or the rows might not line up. Otherwise
   the best cosine pair is used, and the note says which way the pair was chosen. Each passage is quoted as the run
   of whole sentences (up to 320 characters) that shares the most content words with the other passage, so the quote
   shows the overlap rather than wherever the chunk happens to start. Web snapshots have no page numbers.
6. **Layout** (3-D), stored in `<data>/litmap/layout.json` as `{model, epoch, built_at, coords: {key: [x, y, z]}}`.
   Distances are `1 − cosine` of paper vectors.
   - *New epoch* (first run, a different `model`, more than 10 % of the stored keys no longer in the library, or
     `--relayout`): MDS with Sammon weighting over all papers, fitted by SMACOF for 300 iterations from a PCA start
     (power iteration, fixed sign convention), in double precision (plain Python floats, never `array('f')`: in single
     precision the weighted inverse is too inaccurate and the layout falls apart). Same input, same picture.
   - *Same epoch*: stored points are **pinned**. Each new paper starts at the similarity-weighted mean of its 5 nearest
     placed neighbours, then only its own weighted stress against the other points is minimised (200 iterations).
   - Removed papers are dropped from `coords`, and nothing else moves.
   - The global and local scores are recomputed on every run and written to the note's footer. If they fall more than
     0.05 below the values recorded at the start of the epoch, the footer says it's time for `--relayout`.
7. **Week colours.** The window is the last `weeks` ISO weeks (default 3), coloured by age on one blue ramp, validated
   with the dataviz palette checker (ordinal: one hue, lightness strictly ordered, visible gaps, the faintest step at
   least 2:1 against the background):

   | Week | Light surface `#fcfcfb` | Dark surface `#1a1a19` |
   |---|---|---|
   | This week | `#104281` | `#9ec5f4` |
   | 1 week ago | `#2a78d6` | `#3987e5` |
   | 2 weeks ago | `#86b6ef` | `#184f95` |

   The rest of the library is small dots in the muted text colour at low opacity. Colour stands for *age*: next week,
   today's dark dots become mid-blue. The legend names the weeks by date.
8. **Picture.** One self-contained SVG (no scripts, no external fonts; a `prefers-color-scheme` rule switches the
   palette), drawn from a fixed camera looking along the layout's axis of least spread. Depth is shown by dot size and
   opacity. This week's papers are larger dots, each with a 1.5 px line to `nearest(p)` and a label ("FirstAuthor
   Year", or the start of the title when Zotero has no authors; nudged apart and kept inside the frame; up to 12, the
   rest numbered to match the note). Older weeks get no labels and no lines. A
   legend shows each week with its date range and count, "0 added" for an empty week.
9. **Note** `<folder>/<YYYY>-W<ww>.md`: the SVG embed; then one section per paper added this week (title and
   `[[citekey]]`, novelty and its percentile, nearest earlier paper as `[[citekey]]` with its cover, recombination, the
   two quoted passages and how they were chosen); then spread and mean novelty for each week in the window; then the layout
   scores. The planner's weekly review can embed the note if it exists.

## Milestones

- **M1 (implemented): Python.** Everything in the pipeline, the command below, tests LM1–LM15. Enough to run the
  backtest.
- **M1b: `litmap sweep`.** Lay out the library with each candidate method (PCA, metric MDS, Sammon MDS, t-SNE at
  perplexity 5, 15 and 30, all in 3-D), print both scores, write one SVG with a small map per candidate, and say how far
  this week's papers move between them. You pick once; weekly runs never sweep. Then `method` becomes a setting.
- **M1c: running it weekly.** A launchd job `com.planner.litmap` (a template like the others) before the weekly
  review, and a doctor check: layout model against the live index, age of the last map.
- **M2: a 3-D view in the plugin**, only if M1 passes the backtest. A "Literature map" side view reading
  `<data>/litmap/layout.json` plus a small `map.json` (week window, novelty) written by M1, on a plain `<canvas>` with a
  hand-written orthographic projection (no WebGL, no libraries). Drag to rotate, scroll to zoom, hover for a title and
  its nearest earlier paper, click to open as the search modal does. Toggles for the window (1 to 8 weeks) and for
  collection tinting.

## Command and config

```
.venv/bin/python -m planner litmap [--week 2026-W44] [--weeks 3] [--relayout] [--dry-run] [--out DIR]
```

`--week` defaults to the last complete ISO week. `--dry-run` prints the per-paper summary and writes nothing. `--out
DIR` writes the note, the SVG and the layout into `DIR` instead of the vault and `<data>/litmap/`, for backtests; it
runs even when `enabled = false`. Without `--out`, a disabled litmap prints how to enable it and exits 0. The command
takes the non-blocking `<data>/litmap.lock` (busy: says so and exits 0), and every file is written atomically through
`store.py`.

```toml
[litmap]
enabled = false
folder = "Literature maps"   # inside the vault; holds <week>.md and <week>.svg
weeks = 3                    # how many weeks the colour window covers
```

## Tests (written first; `tests/test_litmap.py`)

Fixtures: a synthetic index in a temporary folder (three clusters in 16 dims sharing one common direction, like the
real vectors; abstract rows interleaved with chunk rows, as the real builder writes them), fake dates, a fake MaxSim
scorer, and the existing `tests/fixtures/search` Zotero library for the date read. No real titles.

| # | Behaviour |
|---|---|
| LM1 | Week assignment: a UTC `dateAdded` late on Sunday maps to the local ISO week; papers with no date or no chunks are skipped and counted; Zotero dates are read from a snapshot |
| LM2 | Chunk vectors come from each record's `row`, never its position; abstract rows are not chunks; paper and chunk vectors are centred and normalised |
| LM3 | `nearest(p)` ignores papers added in the same week and later; papers in the first week have no nearest and no novelty |
| LM4 | Novelty percentile: a paper in a new cluster ranks above one inside an existing cluster |
| LM5 | Recombination: a paper whose chunks split between two clusters covered by two different papers scores higher than one covered by a single paper |
| LM6 | SMACOF lowers the Sammon stress of its PCA start, more with more iterations; the layout scores give 1.0 for a perfect layout |
| LM7 | Same epoch: every stored coordinate is unchanged after adding papers; a new paper lands nearer its own cluster than any other |
| LM8 | Determinism: the same inputs give byte-identical `layout.json`, SVG and note |
| LM9 | New epoch on a model change, on more than 10 % keys removed and on `--relayout`; not on a single removal |
| LM10 | Week window: with `weeks = 3`, papers get ages 0, 1 and 2 by ISO week; older ones are library grey; colours match the table |
| LM11 | SVG: parses as XML, has no `<script>`, one legend entry per week with its date range and count ("0 added" for an empty week), the label cap with numbering, lines only for this week's papers |
| LM12 | Junk: reference lists, author lists, checklists, boilerplate, tables and garbled text are junk; ordinary prose is not; junk is never quoted |
| LM13 | Passages: with a scorer, the MaxSim-best pair is quoted and labelled so; with no scorer, or a scorer whose `content_hash` differs from the index, the best cosine pair is quoted and labelled so |
| LM14 | Note: one section per paper added this week with novelty, percentile, nearest, recombination and both passages; spread and mean novelty per week; layout scores. Quotes are the sentences sharing the most words with the other passage; no page for web snapshots |
| LM15 | Command: `enabled = false` without `--out` is a no-op with a message; `--out` writes only there; `--dry-run` writes nothing; a held lock exits 0 with "busy" |

**Budgets (this Mac, about 200 papers, Python 3.15):** computing everything, including a full relayout, ≤ 30 s
(measured: about 10 s). Each MaxSim call takes about 3 s, at most 3 per new paper: a week of 18 papers took
2 min 40 s in all, the 32 papers of W27 almost 5 min. On Python 3.11 (CI) dot products are about 4 times slower.

## Evaluation and kill criterion

- **Backtest before scheduling:** render W27 (the biggest week) and W44 with a 3-week window into a scratch folder
  (`--out`). Does the most novel paper of each week match the owner's sense of "that was a new area for me"? Do the
  recombination scores pick papers that really combine familiar things? Are the quoted passages the right ones? If
  the novelty ranking looks arbitrary in both weeks, stop: the vectors don't capture what you mean by novelty.
- **Approximation check (done 29 Oct 2026):** novelty from the 40 candidate papers against novelty from every earlier
  paper, on all 194 papers with earlier papers: rank correlation 0.999 (largest difference 0.02), the same nearest
  paper for every paper, recombination rank correlation 0.997; 6 s against 16 s.
- **Use test:** after 4 weekly notes, did the owner look at the map at least twice? If not, keep only the per-paper
  text and drop the picture (and M2).

## Later

- Bridges: best chunk match minus typical match between otherwise distant papers, after the junk filter, with the
  hub correction, passages confirmed by MaxSim. The first filtered results were papers sharing a lab method.
- Comparing methods sections with methods sections, to tell "shared technique" from "shared idea".
- Halos for papers whose place depends on the layout method (from `sweep`).
- A week trajectory: each week's centroid joined by an arrow.
- Notes as a second layer: your own notes from that week as hollow markers on the same map.
- Region names chosen locally: the top BM25 terms of each area's chunks.
- A one-paragraph API caption in the planner repo's weekly review. Quotes only, no verdicts.
- Landmark MDS once the library outgrows exact MDS (about 1,500 papers).
