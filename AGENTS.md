# AGENTS.md

A personal planning layer over Obsidian daily notes. The owner writes messy notes in plain text; this project does the structuring out of sight. It puts a short brief at the top of each day's note and writes a weekly review. Full design rationale: [SPEC.md](SPEC.md).

## What it does

- **Morning run** (`planner morning`, launchd every 5 min, does the work once per day on the first check after 04:00 while online):
  1. Writes last Sunday's weekly review first if it's missing (only for weeks since reviews began).
  2. Extracts new or edited daily notes into structured sidecars (gpt-oss-120b on Groq; local qwen3:8b via Ollama as fallback).
  3. Runs health checks, then writes a collapsible brief into today's note, creating the note from the template if needed.
  4. Regenerates `Threads.md` in the vault root with active and quiet multi-day project timelines.
  5. On subsequent 5-min checks: refreshes the brief if `y:` lines were added to today's note, and after 21:00 nudges with an evening reminder if today has no done record.
- **Brief**: carried-over or planned items from the last real note (grouped by thread with `(+N)` for sub-bullets), work that keeps recurring without progress, the week's Focus from the latest review, last-7-days done/planned per type, and `⚠ Setup:` warnings. The callout opens when there are warnings.
- **Done capture & `y:` lines**: either write under `status/done` (or `done`) in the evening, or add `y: <item>` lines in the next morning's note. The planner strips `y:` lines from today's note and appends them to yesterday's note for extraction and stats.
- **Project view (`Threads.md`)**: auto-generated timeline of active (last 14d) and quiet (15–60d) A/B/C projects with `[[YYYY-MM-DD]]` date links and status marks, delimited by `%% planner:threads:start %%` / `%% planner:threads:end %%`.
- **Evening reminder**: launchd prompts at 21:00 with a dialog to open the note if no done record exists.
- **Weekly review** (`planner weekly`, Sundays 21:00, Claude Haiku 5.5): writes `Reviews/YYYY-Www.md` with what happened, patterns, calibration, ≤3 questions (the owner answers inline; next review reads the answers), Focus bullets and thread cleanup.
- **Thread cleanup**: the review's merges and reassignments go into `.planner/thread_fixes.json`, applied over the raw sidecars whenever they're read.
- **Health checks** (`planner doctor`, also every morning, no model calls): vault access, future-dated notes, `secrets.toml` mode, launchd jobs, venv/SDK, Groq model still listed, Anthropic model lifecycle, Ollama model present, notes that fell back to local.

## Assumptions

- macOS, Apple silicon, Homebrew. Python 3.11+ (venv currently on Homebrew 3.15). Only third-party dependency: `anthropic` (weekly review and health checks).
- Vault at `~/Documents/Obsidian Vault`. Daily notes are `YYYY-MM-DD.md` at the vault root. Future-dated files are flagged by `doctor`.
- Note format: plain-text headings `Flow`, `type A`, `type B`, `type C`, `status/done` (or `done`), `thoughts`, from `Templates/Daily.md`, which is shared with Obsidian's Daily Notes plugin via `.obsidian/daily-notes.json`. A: head-down high-friction work. B: open-ended but defined. C: exploratory. Older notes have no headings; the extractor infers types.
- A day without a filled `done` section is "no record", not "nothing done". A note holding only the brief and the empty template is a skipped day.
- A day starts at 04:00 (`[schedule] day_starts_hour`).
- Keys live in `secrets.toml` (chmod 600, git-ignored): `GROQ_API_KEY`, `ANTHROPIC_API_KEY`. See `secrets.example.toml`.
- The project path has a **trailing space**: `"/Users/frederick/Visual Studio /productivity work "`. Always quote it.

## Layout

```
planner/       __main__ (CLI), extract, threads, fixes, stats, brief, weekly, health, llm, vault, config
prompts/       extract.md (per-note extraction), weekly.md (review)
bin/           planner-run.sh: launchd entrypoint; falls back to any Python 3.11+ if .venv is broken
launchd/       com.planner.morning.plist, com.planner.weekly.plist (installed copies in ~/Library/LaunchAgents)
config.toml    vault paths, models, schedule, brief tuning, threads config
Vault side:    .planner/days/*.json (sidecars), threads.json, thread_fixes.json, state.json, health.json
               Reviews/YYYY-Www.md, Templates/Daily.md, Threads.md
logs/          morning.log, weekly.log (git-ignored)
```

## Commands

Run from the project folder with `.venv/bin/python -m planner …`:

| Command | Effect |
|---|---|
| `doctor` | all health checks with fixes; exit 1 on any failure |
| `brief [--date D]` | dry run: print the brief and where it would go. `--write` inserts it |
| `threads [--date D]` | dry run: print Threads.md content. `--write` updates the file |
| `remind [--force]` | show evening reminder dialog now (for testing) |
| `backfill [--force] [--only D…]` | extract stale notes, rebuild `threads.json` |
| `show [--threads] [--date D]` | inspect extracted data |
| `weekly --dry-run --force` | generate a review and print it, write nothing |
| `morning [--force]` | the daily run; `--force` reruns today |
| `compare DIR…`, `models groq`, `prompt D` | evaluation and debugging |
| `--model SPEC`, `--data DIR` (global) | override extraction model or data folder (for comparisons) |

## Rules for changes and testing

- **Never test against the real vault.** Copy the daily notes, `.planner`, `Templates` and `Reviews` into a scratch directory and patch `config.load` (and `datetime`/`online` in `planner.__main__` to simulate days or offline). Dry-run flags (`brief`, `weekly --dry-run`) are safe on real data.
- **The brief is delimited by `%% planner:start %%` / `%% planner:end %%`.** Only text between the markers is ever replaced. The block is stripped before extraction and hashing. A brief deleted by the owner stays deleted (`state.json` → `brief_inserted`).
- **Never overwrite an existing review** without `--force`: it holds the owner's answers.
- **Editing `prompts/extract.md` changes `PROMPT_VERSION`,** which invalidates every sidecar, so the next run re-extracts all notes. Groq's free tier rate-limits this to around 10 minutes, with automatic waits. Changing the `extract` model does the same.
- **Sidecars are raw model output.** Corrections belong in `thread_fixes.json`, not in edited sidecars.
- **Python model calls:** Anthropic goes through the official SDK (`planner/llm.py`). Groq and other OpenAI-compatible hosts use stdlib HTTP. Haiku has no server-side refusal fallback; Sonnet and Opus get `fallbacks: "default"`.
- **After changing a plist:** `launchctl bootout gui/$(id -u)/<label>`, copy it to `~/Library/LaunchAgents/`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`.

## Operations

- **Broken venv** (Homebrew Python changed): `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install anthropic`. Until rebuilt, the wrapper runs on another Python and the brief warns.
- **Model retired:** `doctor` names it. Pick a replacement with `models groq`, or a current Claude ID, and update `config.toml`.
- **Rotate keys:** edit `secrets.toml`, then run `doctor`.
- **Stop everything:** `launchctl bootout gui/$(id -u)/com.planner.morning` (and `.weekly`).
- **Costs:** Groq free tier, one note a day at `reasoning_effort = "high"` (~10s). The weekly review is about 12k characters of input to Haiku, a fraction of a cent.
