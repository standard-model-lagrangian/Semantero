"""Plain-code stats over extracted sidecars. No model calls."""
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

WORK = ("A", "B", "C")
PROGRESS = ("done", "partial")
# A "done" heading on its own line, the end-of-day section from the template.
DONE_HEADING = re.compile(r"^\s*#*\s*done\s*:?\s*$", re.I)
SECTION_HEADING = re.compile(r"^\s*#*\s*(flow|type [abc]|done)\s*:?\s*$", re.I)


def has_done_section(note_path: Path) -> bool:
    """A done heading with at least one non-empty line under it (the template's empty one doesn't count)."""
    if not note_path.exists():
        return False
    lines = note_path.read_text().splitlines()
    for i, ln in enumerate(lines):
        if DONE_HEADING.match(ln):
            for nxt in lines[i + 1:]:
                if SECTION_HEADING.match(nxt):
                    break
                if nxt.strip().lstrip("-*").strip():
                    return True
    return False


@dataclass
class Slip:
    thread: str
    text: str           # most recent wording, in the author's words
    type: str
    notes_seen: int     # notes in the window that mention it
    notes_total: int    # notes in the window
    first_seen: str


@dataclass
class Stats:
    day: date
    prev_date: str | None = None
    prev_has_done: bool = False
    carried: list[dict] = field(default_factory=list)
    slipping: list[Slip] = field(default_factory=list)
    slip_window_records: int = 0  # notes in the slip window with a done section
    week_planned: Counter = field(default_factory=Counter)
    week_progress: Counter = field(default_factory=Counter)
    week_records: int = 0   # notes in the last 7 days that have a done section
    week_notes: int = 0


def compute(day: date, sides: list[dict], daily_dir: Path, slip_window_notes: int = 6, slip_min: int = 3) -> Stats:
    """Stats for the brief on `day`, using only notes written before it."""
    before = sorted((s for s in sides if s["date"] < day.isoformat()), key=lambda s: s["date"])
    st = Stats(day=day)
    if not before:
        return st

    prev = before[-1]
    st.prev_date = prev["date"]
    st.prev_has_done = has_done_section(daily_dir / f"{prev['date']}.md")
    for it in prev["items"]:
        if it["kind"] != "task" or it["type"] not in WORK or not it["planned"]:
            continue
        # Without a done section, "unknown" means no record, not "not done"; the brief labels it so.
        if it["status"] != "done":
            st.carried.append(it)

    # Slipping: work that keeps reappearing across your recent notes without progress.
    window = before[-slip_window_notes:]
    seen: dict[str, list[dict]] = {}
    progressed: set[str] = set()
    st.slip_window_records = sum(has_done_section(daily_dir / f"{s['date']}.md") for s in window)
    for s in window:
        for it in s["items"]:
            if it["kind"] != "task" or it["type"] not in WORK or not it["thread"]:
                continue
            seen.setdefault(it["thread"], [])
            if not any(x["_date"] == s["date"] for x in seen[it["thread"]]):
                seen[it["thread"]].append({**it, "_date": s["date"]})
            if it["status"] in PROGRESS:
                progressed.add(it["thread"])
    for tid, hits in seen.items():
        if len(hits) >= slip_min and tid not in progressed:
            last = hits[-1]
            st.slipping.append(Slip(tid, last["text"], last["type"], len(hits), len(window), hits[0]["_date"]))
    st.slipping.sort(key=lambda s: (-s.notes_seen, s.first_seen))

    # Last 7 calendar days, per type.
    cutoff = (day - timedelta(days=7)).isoformat()
    for s in before:
        if s["date"] < cutoff:
            continue
        st.week_notes += 1
        if has_done_section(daily_dir / f"{s['date']}.md"):
            st.week_records += 1
        for it in s["items"]:
            if it["kind"] == "task" and it["type"] in WORK and it["planned"]:
                st.week_planned[it["type"]] += 1
                if it["status"] in PROGRESS:
                    st.week_progress[it["type"]] += 1
    return st
