"""Readable text from Zotero web snapshots (HTML attachments), standard library only."""
import re
from html.parser import HTMLParser
from pathlib import Path

from .pdftext import Chunk, chunk_pages

# Elements whose content is never body text. All have required end tags, so start/end pair up.
# Not "head": SingleFile drops optional tags, so </head> is often missing; its text-bearing
# children (title, script, style) are skipped instead.
SKIP_TAGS = {
    "script", "style", "noscript", "template", "title", "nav", "header", "footer",
    "aside", "svg", "math", "iframe", "object", "canvas", "button", "select",
}


class _TextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag == "body":
            self.skip_depth = 0  # an unclosed skip tag before <body> must not hide the page
        if tag in SKIP_TAGS:
            self.skip_depth += 1
        else:
            # Tag boundaries separate words ("<td>a</td><td>b</td>" is "a b", not "ab").
            self.parts.append(" ")

    def handle_startendtag(self, tag, attrs):
        self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
        else:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        m = re.search(rb"""<meta[^>]+charset=["']?([A-Za-z0-9_-]+)""", raw[:4096], re.I)
        if m:
            try:
                return raw.decode(m.group(1).decode("ascii"), errors="replace")
            except LookupError:
                pass
        return raw.decode("cp1252", errors="replace")


def html_to_text(html: str) -> str:
    parser = _TextParser()
    parser.feed(html)
    parser.close()
    return re.sub(r"\s+", " ", "".join(parser.parts)).strip()


def extract_chunks(
    html_path: Path,
    chunk_words: int = 300,
    chunk_overlap_words: int = 50,
    max_chunks: int = 150,
) -> tuple[bool, int, list[Chunk]]:
    """Same contract as pdftext.extract_chunks. A snapshot has no pages: chunks carry page 0."""
    try:
        text = html_to_text(_decode(Path(html_path).read_bytes()))
    except (OSError, ValueError):
        return False, 0, []
    if not text:
        return False, 0, []
    return True, 0, chunk_pages([(0, text)], chunk_words, chunk_overlap_words, max_chunks)
