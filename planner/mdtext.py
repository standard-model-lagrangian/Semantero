"""Markdown notes → clean text, sections and chunks for the notes search index.

Pure functions: nothing here touches the disk. Line numbers always refer to the ORIGINAL file, so every
removal keeps the number of lines (blanks replace removed text) and `Section.line` can be used to jump
to a heading.
"""
import re
from dataclasses import dataclass, field, replace

from .pdftext import chunk_pages

SEP = " › "
_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@dataclass
class Section:
    path: str          # heading path, "Materials › EHS"; "" before the first heading
    level: int         # 1-6, 0 before the first heading
    line: int          # 1-based line of the heading (first non-blank line for the lead section)
    text: str = ""     # clean text, whitespace collapsed


@dataclass
class NoteChunk:
    heading: str
    line: int
    text: str


@dataclass
class Note:
    title: str
    tags: list[str] = field(default_factory=list)
    aliases: list[str] = field(default_factory=list)
    citekey: str | None = None
    sections: list[Section] = field(default_factory=list)

    @property
    def body_text(self) -> str:
        return " ".join(s.text for s in self.sections if s.text).strip()


# ── frontmatter ────────────────────────────────────────────────────────────────

_KEY_RE = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9_ .-]*?)\s*:\s*(.*)$")


def _unquote(v: str) -> str:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def _parse_value(raw: str):
    """A scalar, or a list for `[a, b]`; None when the value is malformed."""
    raw = raw.strip()
    if raw.startswith("["):
        if not raw.endswith("]"):
            return None
        inner = raw[1:-1]
        return [_unquote(x) for x in inner.split(",") if x.strip()]
    if raw and raw[0] in "\"'" and (len(raw) < 2 or raw[-1] != raw[0]):
        return None
    return _unquote(raw)


def parse_frontmatter(text: str) -> tuple[dict, int]:
    """(meta, number of lines the block occupies). `({}, 0)` when there is none or it is malformed."""
    lines = text.lstrip("﻿").split("\n")
    if not lines or lines[0].rstrip() != "---":
        return {}, 0
    end = None
    for i in range(1, len(lines)):
        if lines[i].rstrip() in ("---", "..."):
            end = i
            break
    if end is None:
        return {}, 0
    meta: dict = {}
    current: str | None = None
    for ln in lines[1:end]:
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        item = re.match(r"^\s*-\s+(.*)$", ln)
        if item and current is not None:
            if not isinstance(meta.get(current), list):
                meta[current] = [] if meta.get(current) in ("", None) else [meta[current]]
            meta[current].append(_unquote(item.group(1)))
            continue
        if ln[:1] in " \t" and current is not None:
            continue  # continuation of a multi-line scalar: ignored, never fatal
        m = _KEY_RE.match(ln)
        if not m:
            return {}, 0
        key = m.group(1).strip().lower()
        val = _parse_value(m.group(2))
        if val is None:
            return {}, 0
        meta[key] = val
        current = key
    return meta, end + 1


def _as_list(v) -> list[str]:
    if v is None:
        return []
    items = v if isinstance(v, list) else re.split(r"[,\s]+", str(v))
    return [str(x).strip().lstrip("#") for x in items if str(x).strip().lstrip("#")]


# ── cleaning ───────────────────────────────────────────────────────────────────

def _keep_newlines(m: re.Match) -> str:
    return "\n" * m.group(0).count("\n")


_PLANNER_BLOCKS = [
    re.compile(r"%%\s*planner:start\s*%%.*?%%\s*planner:end\s*%%", re.S),
    re.compile(r"%%\s*planner:threads:start\s*%%.*?%%\s*planner:threads:end\s*%%", re.S),
]
_COMMENT_RE = re.compile(r"%%.*?%%", re.S)
_EMBED_RE = re.compile(r"!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)")
_WIKILINK_RE = re.compile(r"\[\[([^\]]*)\]\]")
_MDLINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_TAG_RE = re.compile(r"(?<![\w/#&.:])#([A-Za-z][\w/-]*)")


def _wikilink(m: re.Match) -> str:
    inner = m.group(1)
    if "|" in inner:
        return inner.split("|", 1)[1].strip()
    if "#" in inner:
        target, heading = inner.split("#", 1)
        heading = heading.lstrip("^")
        return f"{target} {heading}".strip()
    return inner.strip()


def _strip_inline(line: str) -> str:
    line = _EMBED_RE.sub("", line)
    line = _WIKILINK_RE.sub(_wikilink, line)
    line = _MDLINK_RE.sub(r"\1", line)
    line = re.sub(r"<[^>]+>", " ", line)
    line = re.sub(r"\*\*|__|~~|==", "", line)
    line = re.sub(r"(?<![\w*])\*(\S(?:[^*]*?\S)?)\*(?![\w*])", r"\1", line)
    line = re.sub(r"(?<![\w_])_(\S(?:[^_]*?\S)?)_(?![\w_])", r"\1", line)
    line = line.replace("`", "")
    return line


def _strip_line(line: str) -> str:
    """Markup removal for one body line (outside code fences)."""
    line = re.sub(r"^\s*(?:>\s*)+", "", line)                           # blockquote / callout prefix
    line = re.sub(r"^\s*\[![^\]]*\][+-]?\s*", "", line)                 # callout header
    line = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?", "", line)  # list marker, checkbox
    stripped = line.strip()
    if stripped.startswith("|"):
        if re.fullmatch(r"[|\s:-]+", stripped):
            return ""
        line = stripped.replace("|", " ")
    return _strip_inline(line)


def _blank_frontmatter(text: str, n_lines: int) -> str:
    if not n_lines:
        return text.lstrip("﻿")
    lines = text.lstrip("﻿").split("\n")
    return "\n".join([""] * n_lines + lines[n_lines:])


def collect_inline_tags(text: str) -> list[str]:
    """`#tags` in prose: never inside code fences, inline code or comments."""
    for rx in _PLANNER_BLOCKS:
        text = rx.sub(_keep_newlines, text)
    text = _COMMENT_RE.sub(_keep_newlines, text)
    out, fence = [], False
    for ln in text.split("\n"):
        if _FENCE_RE.match(ln):
            fence = not fence
            continue
        if fence or _HEADING_RE.match(ln):
            continue
        ln = re.sub(r"`[^`]*`", "", ln)
        ln = re.sub(r"https?://\S+", "", ln)
        for m in _TAG_RE.finditer(ln):
            tag = m.group(1)
            if tag not in out:
                out.append(tag)
    return out


def format_daily_title(iso: str) -> str:
    import datetime
    d = datetime.date.fromisoformat(iso)
    return f"{_DAY_NAMES[d.weekday()]} {d.day:02d} {_MONTH_NAMES[d.month - 1]} {d.year}"


def parse_note(text: str, basename: str, daily_iso: str | None = None) -> Note:
    """Parse one note. `basename` has no extension; `daily_iso` is set for YYYY-MM-DD daily notes."""
    meta, fm_lines = parse_frontmatter(text)
    body = _blank_frontmatter(text, fm_lines)
    tag_source = body
    for rx in _PLANNER_BLOCKS:
        body = rx.sub(_keep_newlines, body)
    body = _COMMENT_RE.sub(_keep_newlines, body)

    sections: list[Section] = []
    stack: list[tuple[int, str]] = []   # (level, heading text)
    cur = Section(path="", level=0, line=0)
    buf: list[str] = []
    fence = False
    h1: str | None = None

    def flush():
        cur.text = re.sub(r"\s+", " ", " ".join(buf)).strip()
        if cur.line == 0:
            cur.line = 1
        if cur.text or cur.level > 0:
            sections.append(cur)

    for i, raw in enumerate(body.split("\n"), start=1):
        if _FENCE_RE.match(raw):
            fence = not fence
            continue
        m = None if fence else _HEADING_RE.match(raw)
        if m:
            flush()
            level, title = len(m.group(1)), _strip_inline(m.group(2)).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            if h1 is None and level == 1 and title:
                h1 = title
            cur = Section(path=SEP.join(t for _, t in stack), level=level, line=i)
            buf = []
            continue
        piece = raw if fence else _strip_line(raw)
        if piece.strip():
            if cur.level == 0 and cur.line == 0:
                cur.line = i
            buf.append(piece.strip())
    flush()

    fm_title = meta.get("title")
    title = (str(fm_title).strip() if isinstance(fm_title, str) and fm_title.strip() else None)
    if not title and daily_iso:
        title = format_daily_title(daily_iso)
    title = title or h1 or basename

    tags: list[str] = []
    for t in _as_list(meta.get("tags")) + collect_inline_tags(tag_source) + _as_list(meta.get("aliases")):
        if t not in tags:
            tags.append(t)
    citekey = meta.get("citekey")
    return Note(
        title=title,
        tags=tags,
        aliases=_as_list(meta.get("aliases")),
        citekey=str(citekey).strip() if isinstance(citekey, str) and citekey.strip() else None,
        sections=sections,
    )


# ── sections → chunks ──────────────────────────────────────────────────────────

def _words(s: Section) -> int:
    return len(s.text.split())


def merge_sections(sections: list[Section], min_words: int) -> list[Section]:
    """Short sections merge forward into the next section of the same or deeper level (keeping their own
    heading; a lead with no heading takes the next one), and a short trailing section merges back."""
    out: list[Section] = []
    i = 0
    n = len(sections)
    while i < n:
        s = replace(sections[i])
        while _words(s) < min_words and i + 1 < n and sections[i + 1].level >= s.level:
            nxt = sections[i + 1]
            text = f"{s.text} {nxt.text}".strip()
            if s.level == 0:
                s = Section(path=nxt.path, level=nxt.level, line=nxt.line if nxt.text else s.line, text=text)
            else:
                s = Section(path=s.path, level=s.level, line=s.line, text=text)
            i += 1
        out.append(s)
        i += 1
    if len(out) > 1 and _words(out[-1]) < min_words:
        last = out.pop()
        prev = out[-1]
        out[-1] = Section(path=prev.path, level=prev.level, line=prev.line, text=f"{prev.text} {last.text}".strip())
    return out


def chunk_note(sections: list[Section], chunk_words: int, overlap: int, min_section_words: int,
               max_chunks: int) -> list[NoteChunk]:
    merged = merge_sections([s for s in sections if s.text], min_section_words)
    chunks: list[NoteChunk] = []
    for s in merged:
        for c in chunk_pages([(0, s.text)], chunk_words, overlap, 10**9):
            chunks.append(NoteChunk(heading=s.path, line=s.line, text=c.text))
            if len(chunks) >= max_chunks:
                return chunks
    return chunks


def lead_text(sections: list[Section], lead_words: int) -> str:
    words = " ".join(s.text for s in sections if s.text).split()
    return " ".join(words[:lead_words])
