# Daily Planner — Spec (v1)

A small system on top of Obsidian daily notes. You keep writing messy notes; the
system keeps the structure out of sight, puts a collapsible brief at the top of each
day's note, and runs a smarter weekly review with a few questions.

## Principles

- **Your notes stay yours.** No checkboxes, no tags, no required format. The only new
  habit is a free-text `done` section at the end of the day.
- **The structure lives in a hidden folder.** Extracted data is kept in `.planner/` inside the vault,
  which Obsidian doesn't show.
- **Daily is cheap and local. Weekly is smart and paid.** The daily brief uses no LLM judgment;
  the weekly review is where the thinking happens.
- **The brief carries no daily questions or plans.** It shows what happened. You decide what to do.

## Your note (unchanged, plus one section)

```
Flow
- gym first
- maybe cafe later

type A
- MiB simulation+derivation schlögl
- sam au anki (lower priority)
type B
- weinberg next reading research
  - find evidence on existing approaches to AS
type C
- think summer placements ±30m action plan

done
- mib sim mostly, derivation not started
- half of zitnik
- anki no
```

`done` is optional. A day without it counts as "no record", not as "did nothing".
Put the headings in Obsidian's Daily Notes template so they're already there each day.

## Components

### 1. Morning run (first wake while online, `planner morning`)

launchd (`launchd/com.planner.morning.plist`) runs a check at login and every 5 minutes. The check
exits immediately unless today's run hasn't happened yet. A "day" starts at 04:00, so a 1am
session still belongs to the previous day. The first check of the day that can reach the
extraction host:

1. **Weekly catch-up.** If last Sunday's review is missing (laptop shut, offline), write it now,
   so the week's Focus is in the brief. Never backfills weeks before the first review.
2. **Extract** new or edited notes (`.planner/days/YYYY-MM-DD.json`). Notes holding only the
   brief and the empty template are skipped as "didn't write that day".
3. **Write the brief** into today's note, creating the note from `Templates/Daily.md` if needed.

If you stay offline for 60 minutes after the first check, it runs anyway with the local model.

**Daily template.** `Templates/Daily.md` (Flow / type A / type B / type C / done) is used both by
Obsidian's Daily Notes plugin (`.obsidian/daily-notes.json`) and by the morning run, so
whichever creates the note first produces the same format. A `done` section only counts once
something is written under it.

### Health checks (no model calls)

Every morning run checks the setup and puts any problem at the top of the brief as a
`⚠ Setup:` line with the fix. A warning opens the callout so it isn't folded away. `planner doctor`
runs the same checks on demand.

| Kind | Check | Catches |
|---|---|---|
| Permissions | write probe in `.planner/`, `secrets.toml` mode, both launchd jobs loaded | macOS privacy blocks, a world-readable key file, unloaded jobs |
| Rebuild | `bin/planner-run.sh` (the launchd entrypoint) tests the venv; if it's broken it runs with any Python 3.11+ and flags it; if none works, posts one macOS notification a day | Homebrew Python changes, missing `anthropic` package |
| Staleness | Groq model list, Anthropic Models API (`lifecycle`, `deprecated_at`), Ollama tags, notes this week extracted by the fallback | retired or deprecated models, rejected keys, missing local fallback, silent Groq failures |

If extraction or the weekly catch-up fails outright, the brief is still written from earlier data,
with a warning. Results of the last run are in `.planner/health.json`.

### 2. Weekly review (API, Sunday 21:00, `planner weekly`)

Writes `Reviews/2026-W42.md` (see format below). It uses a strong API model and reads:
- the week's raw notes (the model reads your actual words, not only the JSON)
- the week's sidecars + 4-week stats
- the last 3 review notes, **including your answers to their questions**

## The brief (inline, collapsible)

Inserted at the very top of today's note. The `-` after the callout type makes it
**collapsed by default**; change it to `+` in config if you want it open.

```markdown
%% planner:start %%
> [!summary]- Brief
> **Carried over:** MiB derivation (partial) · Zitnik paper (half read)
> **Slipping:** summer placements, planned 4 of last 5 days, not done
> **Week focus:** placements in 30m blocks before lunch
> **Last 7 days:** A 9/12 · B 4/7 · C 0/5
%% planner:end %%
```

`%% … %%` are Obsidian comments, which don't show in reading view.

**Insertion rules** (so it never fights you):
- Markers present → replace what's between them (only happens if the job re-runs).
- Markers absent and the brief hasn't been inserted for this date yet → insert it at the top,
  creating the note from the template if it doesn't exist.
- Markers absent and the brief was already inserted (recorded in `.planner/state.json`) → you deleted it, so
  leave it alone.
- Never touch anything outside the markers.

"Week focus" is copied from the `Focus` section of the latest review note, which you edit.
That's how the weekly review carries into the daily briefs.

## Sidecar schema — `.planner/days/YYYY-MM-DD.json`

```json
{
  "date": "2026-10-18",
  "source_hash": "sha256 of the note text",
  "flow": ["gym first", "maybe cafe later"],
  "planned": [
    {
      "text": "MiB simulation+derivation schlögl + reading for next week",
      "type": "A",
      "thread": "mib-schlogl",
      "est_min": null,
      "priority": "normal",
      "subtasks": []
    },
    {
      "text": "think summer placements action plan",
      "type": "C",
      "thread": "summer-placements",
      "est_min": 30,
      "priority": "normal",
      "subtasks": []
    }
  ],
  "done_section": true,
  "outcomes": [
    { "thread": "mib-schlogl", "status": "partial", "note": "sim mostly, derivation not started" },
    { "thread": "sam-au-anki", "status": "skipped", "note": null }
  ],
  "unplanned_done": [
    { "text": "half of zitnik", "thread": "zitnik-activity-cliffs", "type": "B" }
  ]
}
```

- `type`: `A|B|C|other`, taken from the heading the bullet sits under.
- `priority`: `low|normal|high`, inferred from asides like "(lower priority)".
- `status`: `done|partial|skipped`. A planned thread missing from `done` gets `unknown` (set in code, not by the model).
- Output is constrained with Ollama's JSON-schema `format` parameter.

## Threads — `.planner/threads.json`

```json
{
  "summer-placements": {
    "name": "Summer placements",
    "type": "C",
    "first_seen": "2026-10-14",
    "last_seen": "2026-10-18",
    "recent_texts": ["think summer placements ±30m action plan", "..."]
  }
}
```

The extractor receives the active threads (seen in the last 21 days, with their last 2
texts) and either reuses an id or proposes `new:<slug>`. That's what links
"weinberg next reading research" on Tuesday with "weinberg lit search" on Thursday.

## Stats (plain code)

- Per thread: days planned, days done or partial, current slip streak (planned and not done),
  days since last progress.
- Per type over the last 7 days: planned vs. done, partial and unknown.
- Carry-overs: yesterday's `partial` items, plus planned items with `unknown` status when there's no `done` section.
- "Slipping" = slip streak ≥ 3, or planned ≥ 4 of the last 7 days with no progress.

## Weekly review note — `Reviews/YYYY-Www.md`

```markdown
# Week 42 review

## What happened
Short narrative by type: what moved and what didn't.

## Patterns
2–4 observations backed by the data, e.g. "Type C only ever appears after
type A is done; it hasn't happened on any day with a gym session."

## Calibration
Planned vs. done per type, with one line on what that implies for planning.

## Questions
1. Placements has slipped every day this week. Is it the wrong size, wrong time, or not actually a priority?
   answer:
2. ...
   answer:

## Focus
- (suggested, edit freely; shown in daily briefs all week)
```

At most 3 questions. Answer them whenever you like, or don't. Next week's review reads the answers and
follows up on them. An existing review is never overwritten (it holds your answers).

**Thread cleanup.** The review also returns merges (two ids, same work) and reassignments
(one item filed under the wrong thread). These go into `.planner/thread_fixes.json`, a layer
applied whenever sidecars are read, so they survive re-extraction and the nightly model sees
the cleaned thread ids. Each review lists what it changed under `## Thread cleanup`.

## Models

| Job | Default | Notes |
|---|---|---|
| Extraction (nightly) | Groq `openai/gpt-oss-120b`; local Ollama `qwen3:8b` (thinking on) as fallback | Chosen after comparing local qwen3:8b, Groq Qwen 3.8 27B and gpt-oss-120b on all notes: gpt-oss linked the same work across days most accurately. About 4s per note, within Groq's free tier. |
| Daily brief | none (template) | |
| Weekly review | Claude Haiku 5.5 (`claude-haiku-5-5`, effort high) via the `anthropic` SDK; switch `weekly` in config to `anthropic:claude-sonnet-5-5` for sharper reviews | ~15–25k input tokens/week, about cents per week. Sends that week's notes to the API. |

Every model is set in `config.toml`; keys live in `secrets.toml` (chmod 600). If Groq fails,
the nightly job falls back to local and re-extracts with Groq on the next run.

## Code layout

```
productivity work/
  .venv/                   # only dependency: anthropic (weekly review); run everything with .venv/bin/python
  config.toml              # vault path, folders, models, schedule, callout state
  planner/
    cli.py                 # planner nightly | weekly | backfill | brief --dry-run
    config.py
    vault.py               # find daily notes, read/write, marker-safe insertion
    extract.py             # Ollama call + pydantic schema
    threads.py             # thread registry merge
    stats.py
    brief.py               # template rendering
    weekly.py              # API call, writes review note
  prompts/
    extract.md
    weekly.md
  launchd/
    com.planner.nightly.plist
    com.planner.weekly.plist
```

## Config — `config.toml`

```toml
vault = "~/path/to/vault"
daily_folder = "Daily"            # where YYYY-MM-DD.md notes live
reviews_folder = "Reviews"
daily_template = "Templates/Daily.md"

[brief]
collapsed = true
lookback_days = 7

[models]
extract = "ollama:qwen3:8b"
extract_fallback = "anthropic:claude-haiku-5-5"
weekly = "anthropic:claude-sonnet-5-5"

[schedule]
nightly = "04:00"
weekly = "Sun 21:00"   # launchd/com.planner.weekly.plist
```

## Build order

1. **`planner backfill`**: run extraction over your existing notes and inspect the JSON.
   This shows whether the local model is good enough before anything else is built.
2. Threads + stats + `planner brief --dry-run` (prints the brief without writing it).
3. Marker-safe insertion into the note, then the launchd nightly job.
4. Weekly review after about 1–2 weeks of data, so it has something to work with.

## Open items

- Vault path and daily-notes folder.
- Set up Obsidian's Daily Notes template with `Flow / type A / type B / type C / done`.
