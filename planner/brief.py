"""Render the daily brief callout and insert it into a note without touching anything else."""
import os
import re
from datetime import date
from pathlib import Path

from .stats import WORK, Stats
from .vault import BLOCK_RE, END, START

FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.S)
MAX_ITEMS = 4


def _short(text: str, n: int = 70) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _day(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d:%a} {d.day} {d:%b}"


def week_focus(reviews_dir: Path) -> list[str]:
    """Bullets under '## Focus' in the most recent weekly review note, if any."""
    if not reviews_dir.is_dir():
        return []
    reviews = sorted(reviews_dir.glob("*-W*.md"))
    if not reviews:
        return []
    m = re.search(r"^## Focus\s*\n(.*?)(?=^## |\Z)", reviews[-1].read_text(), re.S | re.M)
    if not m:
        return []
    return [ln.strip()[2:].strip() for ln in m.group(1).splitlines()
            if ln.strip().startswith("- ") and ln.strip()[2:].strip() and "(suggested" not in ln]


def render(st: Stats, focus: list[str], collapsed: bool = True, warnings: list[str] | None = None) -> str:
    warnings = warnings or []
    # Open the callout when something needs fixing, so the warning isn't folded away.
    fold = "+" if warnings or not collapsed else "-"
    lines = [f"> [!summary]{fold} Brief · {_day(st.day.isoformat())}"]
    lines += [f"> **⚠ Setup:** {w}" for w in warnings]
    if not st.prev_date:
        lines.append("> No earlier notes yet.")
    else:
        if st.carried:
            items = " · ".join(
                _short(it["text"], 50)
                + (f" (+{it['extra']})" if it.get("extra") else "")
                + (" (partial)" if it["status"] == "partial" else "")
                for it in st.carried[:MAX_ITEMS]
            )
            more = f" · +{len(st.carried) - MAX_ITEMS} more" if len(st.carried) > MAX_ITEMS else ""
            if st.prev_has_done:
                lines.append(f"> **Carried over** from {_day(st.prev_date)}: {items}{more}")
            else:
                lines.append(f"> **Planned {_day(st.prev_date)}** (no done record): {items}{more}")
        for s in st.slipping[:3]:
            # Without done records we can't say it stalled, only that it keeps reappearing.
            label = "Slipping" if st.slip_window_records else "Keeps coming back"
            tail = ", no progress marked" if st.slip_window_records else ""
            lines.append(f"> **{label}:** {_short(s.text)}, on {s.notes_seen} of your last "
                         f"{s.notes_total} notes since {_day(s.first_seen)}{tail}")
    if focus:
        lines.append(f"> **Week focus:** {' · '.join(_short(f, 60) for f in focus[:3])}")
    if st.week_notes:
        planned = " · ".join(f"{t} {st.week_progress[t]}/{st.week_planned[t]}" for t in WORK if st.week_planned[t])
        if st.week_records == 0:
            lines.append(f"> **Last 7 days:** {planned or 'no A/B/C tasks'} done/planned. "
                         "Only inline marks (~~strikethrough~~, *done*) count so far; a `done` section tonight fills this in.")
        else:
            lines.append(f"> **Last 7 days:** {planned} done/planned ({st.week_records} of {st.week_notes} notes have a `done` section)")
    return "\n".join([START, *lines, END]) + "\n"


def upsert(text: str | None, block: str, already_inserted: bool, template: str = "") -> str | None:
    """New note text with the block in place, or None to leave the note alone.

    Markers present: replace between them, wherever they are.
    No note yet: create it with the brief followed by the daily template.
    Markers absent and never inserted for this date: insert at the top (after frontmatter).
    Markers absent but inserted before: you deleted it, so respect that.
    """
    if text is None:
        return block + "\n" + template if template else block
    if BLOCK_RE.search(text):
        return BLOCK_RE.sub(lambda _: block, text, count=1)
    if already_inserted:
        return None
    fm = FRONTMATTER_RE.match(text)
    head, rest = (text[: fm.end()], text[fm.end():]) if fm else ("", text)
    return head + block + "\n" + rest


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.planner-tmp")
    tmp.write_text(text)
    os.replace(tmp, path)
