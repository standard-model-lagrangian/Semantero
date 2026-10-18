"""Sunday review: digest the week for Claude, write the review note, apply thread cleanup."""
import re
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

from . import brief, fixes
from .config import ROOT
from .extract import thread_id
from .stats import PROGRESS, WORK, has_done_section

PROMPT = (ROOT / "prompts" / "weekly.md").read_text()
HISTORY_WEEKS = 4
PREVIOUS_REVIEWS = 3
MAX_QUESTIONS = 3
MAX_FOCUS = 3

_FIX = lambda keys: {"type": "object", "properties": {k: {"type": "string"} for k in keys}, "required": list(keys)}
_STRINGS = {"type": "array", "items": {"type": "string"}}
SCHEMA = {
    "type": "object",
    "properties": {
        "what_happened": {"type": "string"},
        "patterns": _STRINGS,
        "calibration": {"type": "string"},
        "questions": _STRINGS,
        "focus": _STRINGS,
        "merges": {"type": "array", "items": _FIX(["from", "into", "reason"])},
        "reassign": {"type": "array", "items": _FIX(["item", "to", "reason"])},
    },
    "required": ["what_happened", "patterns", "calibration", "questions", "focus", "merges", "reassign"],
}


def week_ending(today: date) -> date:
    """The most recent Sunday on or before today (a Monday catch-up run reviews the week just gone)."""
    return today - timedelta(days=(today.weekday() + 1) % 7)


def review_path(reviews_dir: Path, end: date) -> Path:
    iso = end.isocalendar()
    return reviews_dir / f"{iso.year}-W{iso.week:02d}.md"


def _day(d: str) -> str:
    x = date.fromisoformat(d)
    return f"{x:%a} {x.day} {x:%b}"


def digest(end: date, sides: list[dict], daily_dir: Path, reviews_dir: Path) -> tuple[str, dict]:
    """The user message for Claude, plus an item-id index used to apply reassignments."""
    start = end - timedelta(days=6)
    hist_start = end - timedelta(days=7 * HISTORY_WEEKS - 1)
    in_week = lambda d: start.isoformat() <= d <= end.isoformat()
    hist = [s for s in sides if hist_start.isoformat() <= s["date"] <= end.isoformat()]
    out, index = [], {}

    out.append(f"# Week {end.isocalendar().week}: {_day(start.isoformat())} to {_day(end.isoformat())}\n")
    out.append("## This week's notes, as written\n")
    for s in hist:
        if not in_week(s["date"]):
            continue
        raw = brief.BLOCK_RE.sub("", (daily_dir / f"{s['date']}.md").read_text()).strip()
        done = "has a done section" if has_done_section(daily_dir / f"{s['date']}.md") else "no done section"
        out.append(f"### {_day(s['date'])} ({done})\n```\n{raw}\n```\n")
    if not any(in_week(s["date"]) for s in hist):
        out.append("(no notes this week)\n")

    out.append(f"## Extracted tasks, last {HISTORY_WEEKS} weeks (id, type, status, thread, text)\n")
    thread_days, thread_progress, thread_texts, thread_type = defaultdict(set), Counter(), defaultdict(list), {}
    for s in hist:
        for i, it in enumerate(s["items"]):
            if it["kind"] != "task":
                continue
            iid = f"{s['date']}#{i}"
            index[iid] = (s["date"], it["text"])
            out.append(f"- {iid} [{it['type']}] {it['status']} thread={it['thread'] or '-'} \"{it['text']}\"")
            if it["thread"]:
                thread_days[it["thread"]].add(s["date"])
                thread_type[it["thread"]] = it["type"]
                thread_progress[it["thread"]] += it["status"] in PROGRESS
                if it["text"] not in thread_texts[it["thread"]]:
                    thread_texts[it["thread"]].append(it["text"])

    out.append(f"\n## Threads, last {HISTORY_WEEKS} weeks (id, type, notes it appears in, notes with progress)\n")
    for tid in sorted(thread_days, key=lambda t: (-len(thread_days[t]), t)):
        days = sorted(thread_days[tid])
        out.append(f"- {tid} [{thread_type[tid]}] in {len(days)} notes ({', '.join(d[5:] for d in days)}), "
                   f"progress in {thread_progress[tid]}; wording: " + " | ".join(f'"{t}"' for t in thread_texts[tid][-3:]))

    out.append("\n## Planned A/B/C tasks per week (done or partial / planned)\n")
    for w in range(HISTORY_WEEKS - 1, -1, -1):
        w_end = end - timedelta(days=7 * w)
        w_start = w_end - timedelta(days=6)
        ws = [s for s in hist if w_start.isoformat() <= s["date"] <= w_end.isoformat()]
        planned, progress = Counter(), Counter()
        for s in ws:
            for it in s["items"]:
                if it["kind"] == "task" and it["type"] in WORK and it["planned"]:
                    planned[it["type"]] += 1
                    progress[it["type"]] += it["status"] in PROGRESS
        records = sum(has_done_section(daily_dir / f"{s['date']}.md") for s in ws)
        per = ", ".join(f"{t} {progress[t]}/{planned[t]}" for t in WORK) if ws else "no notes"
        out.append(f"- W{w_end.isocalendar().week}: {len(ws)} notes, {records} with a done section; {per}")

    previous = sorted(p for p in reviews_dir.glob("*-W*.md") if p.name < review_path(reviews_dir, end).name) \
        if reviews_dir.is_dir() else []
    out.append("\n## Previous reviews, most recent first (the author's answers are under each question)\n")
    if previous:
        for p in reversed(previous[-PREVIOUS_REVIEWS:]):
            out.append(f"### {p.stem}\n{p.read_text().strip()}\n")
    else:
        out.append("(this is the first review)\n")
    return "\n".join(out), index


def cleanup(result: dict, index: dict, known: set[str], fx: dict) -> list[str]:
    """Apply the model's merges and reassignments to fx in place; returns readable lines for the note."""
    applied = []
    for m in result.get("merges", []):
        src, dst = thread_id(m["from"]), thread_id(m["into"])
        if src in known and dst in known and src != dst and fixes.resolve(dst, fx["aliases"]) != src:
            fx["aliases"][src] = dst
            applied.append(f"merged `{src}` into `{dst}`: {m['reason']}")
    for r in result.get("reassign", []):
        if r["item"] not in index:
            continue
        day, text = index[r["item"]]
        to = thread_id(r["to"])
        if to:
            fx["items"][fixes.item_key(day, text)] = to
            applied.append(f"moved \"{text}\" ({_day(day)}) to `{to}`: {r['reason']}")
    return applied


def render(end: date, result: dict, applied: list[str], model: str, when: str) -> str:
    start = end - timedelta(days=6)
    lines = [
        f"# Week {end.isocalendar().week} review · {start.day} {start:%b} to {end.day} {end:%b} {end.year}",
        f"%% written by planner ({model}) on {when}. Answer the questions inline; next week's review reads your answers. %%",
        "",
        "## What happened",
        result["what_happened"].strip(),
        "",
        "## Patterns",
        *[f"- {p.strip()}" for p in result["patterns"]],
        "",
        "## Calibration",
        result["calibration"].strip(),
        "",
        "## Questions",
    ]
    for i, q in enumerate(result["questions"][:MAX_QUESTIONS], 1):
        lines += [f"{i}. {q.strip()}", "   answer: "]
    lines += [
        "",
        "## Focus",
        "%% Suggested; edit freely. These bullets show in your daily briefs all week. %%",
        *[f"- {f.strip()}" for f in result["focus"][:MAX_FOCUS]],
        "",
        "## Thread cleanup",
        *([f"- {a}" for a in applied] or ["- nothing to fix this week"]),
        "",
    ]
    return "\n".join(lines)
