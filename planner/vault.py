import hashlib
import re
import sys
from datetime import date
from pathlib import Path

DAILY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")


def daily_notes(daily_dir: Path, today: date | None = None) -> list[tuple[date, Path]]:
    """Daily notes sorted by date. Future-dated files (typos) are skipped with a warning."""
    today = today or date.today()
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
DEFAULT_TEMPLATE = "Flow\n- \n\ntype A\n- \ntype B\n- \ntype C\n- \n\ndone\n- \n"


def template_text(path: Path) -> str:
    return path.read_text() if path.exists() else DEFAULT_TEMPLATE


def is_blank(text: str, template: str = DEFAULT_TEMPLATE) -> bool:
    """True if the note holds nothing beyond the template's headings and empty bullets."""
    skip = {ln.strip().lower() for ln in template.splitlines()}
    for ln in text.splitlines():
        s = ln.strip()
        if not s or not s.lstrip("-*").strip() or s.lower() in skip:
            continue
        return False
    return True
