import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Chunk:
    page: int
    text: str

    def to_dict(self, paper_idx: int, attachment_key: str, row: int):
        return {
            "paper": paper_idx,
            "attachmentKey": attachment_key,
            "page": self.page,
            "text": self.text,
            "row": row,
        }


def clean_page_text(text: str) -> str:
    """Dehyphenate across lines and normalize whitespace."""
    # Join words hyphenated across line breaks: viscoelas-\nticity -> viscoelasticity
    text = re.sub(r"(\b[a-zA-Z]+)-[ \t]*\r?\n[ \t]*([a-zA-Z]+\b)", r"\1\2", text)
    # Collapse intra-line whitespace
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(lines).strip()


def clean_document_pages(raw_pages: list[str]) -> list[tuple[int, str]]:
    """Clean multi-page document:
    - Drop repeated running headers/footers (lines occurring on > 50% of pages)
    - Dehyphenate across lines
    - Strip references from line on or after 60% of document
    - Merge short pages (< 40 words) forward into next page
    """
    total_pages = len(raw_pages)
    if total_pages == 0:
        return []

    # 1. Count line occurrences across pages for repeated headers/footers
    line_counts: Counter[str] = Counter()
    for page in raw_pages:
        unique_lines = {line.strip() for line in page.splitlines() if line.strip()}
        for line in unique_lines:
            line_counts[line] += 1

    header_threshold = total_pages / 2.0
    repeated_headers = {line for line, cnt in line_counts.items() if cnt > header_threshold}

    # 2. Filter headers and dehyphenate each page
    pages_lines: list[tuple[int, list[str]]] = []
    for i, page in enumerate(raw_pages):
        page_num = i + 1
        filtered_lines = [
            line for line in page.splitlines()
            if line.strip() not in repeated_headers
        ]
        page_raw = "\n".join(filtered_lines)
        dehyphenated = clean_page_text(page_raw)
        pages_lines.append((page_num, dehyphenated.splitlines()))

    # 3. Cut off references on or after 60% of document
    total_lines = sum(len(lines) for _, lines in pages_lines)
    ref_pattern = re.compile(r"^(references|bibliography|literature cited)\s*$", re.I)

    cutoff_found = False
    current_line_idx = 0
    cleaned_after_refs: list[tuple[int, str]] = []

    for page_num, lines in pages_lines:
        if cutoff_found:
            break
        page_fraction = (page_num - 1) / total_pages if total_pages > 0 else 0.0
        kept_lines = []
        for line in lines:
            line_fraction = current_line_idx / total_lines if total_lines > 0 else 0.0
            is_after_60 = (page_fraction >= 0.6) or (line_fraction >= 0.6)
            if is_after_60 and ref_pattern.match(line.strip()):
                cutoff_found = True
                break
            kept_lines.append(line)
            current_line_idx += 1
        page_text = " ".join(kept_lines)
        # Collapse multiple spaces
        page_text = re.sub(r"\s+", " ", page_text).strip()
        if page_text:
            cleaned_after_refs.append((page_num, page_text))

    # 4. Merge short pages (< 40 words) forward into the next page
    merged_pages: list[tuple[int, str]] = []
    pending_text = ""
    for i, (page_num, text) in enumerate(cleaned_after_refs):
        combined = f"{pending_text} {text}".strip() if pending_text else text
        word_count = len(combined.split())
        has_next = i + 1 < len(cleaned_after_refs)

        if word_count < 40 and has_next:
            pending_text = combined
        else:
            merged_pages.append((page_num, combined))
            pending_text = ""

    # If pending text remained at the end, append to last merged page or add it
    if pending_text:
        if merged_pages:
            last_num, last_text = merged_pages[-1]
            merged_pages[-1] = (last_num, f"{last_text} {pending_text}".strip())
        else:
            merged_pages.append((total_pages, pending_text))

    return [(p_num, text) for p_num, text in merged_pages if text]


def extract_chunks(
    pdf_path: Path,
    chunk_words: int = 300,
    chunk_overlap_words: int = 50,
    max_chunks: int = 150,
) -> tuple[bool, int, list[Chunk]]:
    """Extract clean text and chunks from a PDF using pdftotext."""
    pdf_path = Path(pdf_path)
    try:
        res = subprocess.run(
            ["pdftotext", "-enc", "UTF-8", str(pdf_path), "-"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if res.returncode != 0:
            return False, 0, []
        raw_stdout = res.stdout
    except (subprocess.TimeoutExpired, subprocess.SubprocessError, OSError):
        return False, 0, []

    # Split on formfeed (\f or \x0c)
    raw_pages = raw_stdout.split("\x0c")
    # Drop trailing empty entry if present
    while raw_pages and not raw_pages[-1].strip():
        raw_pages.pop()

    num_pages = len(raw_pages)
    if num_pages == 0:
        return False, 0, []

    # Check if scanned (no text)
    total_words = sum(len(p.split()) for p in raw_pages)
    if total_words == 0:
        return False, num_pages, []

    cleaned_pages = clean_document_pages(raw_pages)

    chunks: list[Chunk] = []
    step = max(1, chunk_words - chunk_overlap_words)

    for page_num, text in cleaned_pages:
        words = text.split()
        if not words:
            continue
        if len(words) <= chunk_words:
            chunks.append(Chunk(page=page_num, text=" ".join(words)))
        else:
            start = 0
            while start < len(words):
                chunk_w = words[start : start + chunk_words]
                if chunk_w:
                    chunks.append(Chunk(page=page_num, text=" ".join(chunk_w)))
                if start + chunk_words >= len(words):
                    break
                start += step

        if len(chunks) >= max_chunks:
            chunks = chunks[:max_chunks]
            break

    return True, num_pages, chunks
