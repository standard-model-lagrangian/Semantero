import hashlib
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

START = "%% planner:start %%"
END = "%% planner:end %%"
BLOCK_RE = re.compile(re.escape(START) + r".*?" + re.escape(END) + r"\n?", re.S)

DAILY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")
YESTERDAY_RE = re.compile(r"^\s*(?:[-*]\s*)?(?:y|yesterday)\s*:\s*(.+?)\s*$", re.I)
DONE_ALIAS_RE = re.compile(r"^(\s*#*\s*)status/done(\s*:?\s*)$", re.I | re.M)
DONE_HEADING = re.compile(r"^\s*#*\s*(?:status/)?done\s*:?\s*$", re.I)
SECTION_HEADING = re.compile(r"^\s*#*\s*(flow|type [abc]|(?:status/)?done|thoughts?)\s*:?\s*$", re.I)


def logical_today(day_starts_hour: int = 4, now: datetime | None = None) -> date:
    """A day starts at day_starts_hour (default 4am), so a 1am session still counts as yesterday."""
    now = now or datetime.now()
    return (now - timedelta(hours=day_starts_hour)).date()


def split_yesterday(text: str) -> tuple[str, list[str]]:
    """(text without `y:` lines, the `y:` lines' contents)."""
    kept, y_lines = [], []
    for ln in text.splitlines():
        m = YESTERDAY_RE.match(ln)
        if m:
            y_lines.append(m.group(1).strip())
        else:
            kept.append(ln)
    res = "\n".join(kept)
    if text.endswith("\n") and res:
        res += "\n"
    return res, y_lines


def _append_done_lines(text: str, lines: list[str]) -> str:
    bullet_lines = [f"- {ln}" for ln in lines]
    raw_lines = text.splitlines()
    done_idx = -1
    for i, ln in enumerate(raw_lines):
        if DONE_HEADING.match(ln):
            done_idx = i
            break
    if done_idx == -1:
        suffix = "\n".join(["", "done", *bullet_lines, ""])
        return text.rstrip("\n") + "\n" + suffix.lstrip("\n")

    next_sec_idx = len(raw_lines)
    for j in range(done_idx + 1, len(raw_lines)):
        if SECTION_HEADING.match(raw_lines[j]):
            next_sec_idx = j
            break

    insert_idx = next_sec_idx
    for k in range(next_sec_idx - 1, done_idx, -1):
        if raw_lines[k].strip():
            insert_idx = k + 1
            break
    if insert_idx == next_sec_idx and done_idx == next_sec_idx - 1:
        insert_idx = done_idx + 1

    new_lines = raw_lines[:insert_idx] + bullet_lines + raw_lines[insert_idx:]
    res = "\n".join(new_lines)
    if text.endswith("\n"):
        res += "\n"
    return res


def note_text(path: Path) -> str:
    """The note as the planner reads it.

    - the brief block is removed;
    - this note's own `y:` lines are removed (they describe yesterday, not today);
    - a `status/done` heading is read as `done`, the wording the extraction prompt uses;
    - `y:` lines from the next day's note (exactly date + 1) are appended under a `done` heading.
    """
    if not path.exists():
        return ""
    text = path.read_text()
    text = BLOCK_RE.sub("", text)
    text, _ = split_yesterday(text)
    text = DONE_ALIAS_RE.sub(r"\1done\2", text)

    m = DAILY_RE.match(path.name)
    if m:
        try:
            curr_date = date.fromisoformat(m.group(1))
            next_date = curr_date + timedelta(days=1)
            next_path = path.with_name(f"{next_date.isoformat()}.md")
            if next_path.exists():
                _, next_y_lines = split_yesterday(BLOCK_RE.sub("", next_path.read_text()))
                if next_y_lines:
                    text = _append_done_lines(text, next_y_lines)
        except ValueError:
            pass

    return text


def future_notes(daily_dir: Path, today: date | None = None) -> list[Path]:
    """Daily notes dated after today."""
    today = today or logical_today()
    bad = []
    if not daily_dir.is_dir():
        return bad
    for p in daily_dir.iterdir():
        m = DAILY_RE.match(p.name)
        if m:
            d = date.fromisoformat(m.group(1))
            if d > today:
                bad.append(p)
    return sorted(bad)


def daily_notes(daily_dir: Path, today: date | None = None) -> list[tuple[date, Path]]:
    """Daily notes sorted by date. Future-dated files (typos) are skipped with a warning."""
    today = today or logical_today()
    notes = []
    for p in daily_dir.iterdir():
        m = DAILY_RE.match(p.name)
        if not m:
            continue
        d = date.fromisoformat(m.group(1))
        if d > today:
            print(f"skipping {p.name}: date is in the future (filename typo?)", file=sys.stderr)
            continue
        notes.append((d, p))
    return sorted(notes)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# Used when Templates/Daily.md is missing; mirrors the author's own plain-text headings.
DEFAULT_TEMPLATE = "Flow\n- \n\ntype A\n- \ntype B\n- \ntype C\n- \n\nstatus/done\n- \n\nthoughts\n- \n"


def template_text(path: Path) -> str:
    return path.read_text() if path.exists() else DEFAULT_TEMPLATE


def is_blank(text: str, template: str = DEFAULT_TEMPLATE) -> bool:
    """True if the note holds nothing beyond the template's headings and empty bullets."""
    # note_text() reads `status/done` as `done`, so skip both spellings of the template's headings.
    skip = {ln.strip().lower() for ln in (template + "\n" + DONE_ALIAS_RE.sub(r"\1done\2", template)).splitlines()}
    for ln in text.splitlines():
        s = ln.strip()
        if not s or not s.lstrip("-*").strip() or s.lower() in skip:
            continue
        return False
    return True

