"""Search index of the vault's Markdown notes: `.planner/notes/`, in the same format as `.planner/search/`.

Every note is one `papers.json` entry (so the paper-search engine ranks notes unchanged) with its heading
sections as chunks. Vectors are reused by the hash of the text they embed, so renames, touches and edits
elsewhere in a note never re-embed anything that did not change.
"""
import array
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from . import mdtext
from .config import SearchSettings
from .indexfiles import building, compute_content_hash, embed_texts, publish
from .indexfiles import manifest as index_manifest
from .store import load_json, write_json
from .vault import DAILY_RE

CHUNKER = "md-headings-v1"
DEFAULTS = {
    "enabled": True,
    "exclude": ["Templates/**", "Threads.md", "Zotero Template.md", "Zotero Citation Template.md"],
    "chunk_words": 200,
    "chunk_overlap_words": 40,
    "min_section_words": 25,
    "lead_words": 120,
    "max_chunks_per_note": 60,
}
MIN_BODY_WORDS = 3


class VaultUnreadable(RuntimeError):
    """The vault (or a folder in it) could not be listed, or it suddenly has no notes. Writing an index from a partial
    scan would drop those notes and make the next good run re-embed them, so the build stops and the old index stays."""


def notes_enabled(cfg) -> bool:
    notes = getattr(cfg, "notes", None)
    return bool(notes) and bool(notes.get("enabled", True))


def settings(cfg) -> dict:
    return {**DEFAULTS, **(getattr(cfg, "notes", None) or {})}


# ── exclude globs ──────────────────────────────────────────────────────────────

def glob_to_regex(pattern: str) -> re.Pattern:
    """Vault-relative glob: `*` and `?` stay inside one folder, `**` crosses folders, `**/` may match nothing."""
    if not isinstance(pattern, str) or not pattern.strip():
        raise ValueError(f"empty exclude pattern: {pattern!r}")
    if pattern.startswith("/") or ".." in pattern.split("/"):
        raise ValueError(f"exclude pattern must be vault-relative with no '..': {pattern!r}")
    out, i = [], 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("".join(out) + r"\Z")


def compile_excludes(globs: list[str]) -> list[re.Pattern]:
    return [glob_to_regex(g) for g in globs]


# ── scan ───────────────────────────────────────────────────────────────────────

def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def scan(vault: Path, excludes: list[re.Pattern]) -> tuple[list[tuple[str, Path]], int]:
    """(included notes as (vault-relative path, absolute path) sorted by path, number excluded by globs).

    Excluded folders are never listed (so an unreadable excluded folder is no error) and count once each; excluded
    files count once each. Dot-folders and dotfiles are skipped silently (Obsidian ignores them too). Any folder that
    cannot be listed raises VaultUnreadable."""
    if not vault.is_dir():
        raise VaultUnreadable(f"vault not found: {vault}")
    files: list[tuple[str, Path]] = []
    excluded = 0

    def excluded_dir(rel: str) -> bool:
        return any(rx.match(f"{rel}/\0") for rx in excludes)

    def on_error(err: OSError) -> None:
        rel = Path(err.filename).relative_to(vault).as_posix() if err.filename else "."
        raise VaultUnreadable(f"can't read {rel or 'the vault'} ({err.strerror or err}). "
                              "Check the vault path and that this job may read it (System Settings → Privacy & Security)")

    for dirpath, dirnames, filenames in os.walk(vault, onerror=on_error):
        rel_dir = Path(dirpath).relative_to(vault).as_posix()
        keep = []
        for d in sorted(dirnames):
            if d.startswith("."):
                continue
            if excluded_dir(d if rel_dir == "." else f"{rel_dir}/{d}"):
                excluded += 1
                continue
            keep.append(d)
        dirnames[:] = keep
        for fn in sorted(filenames):
            if fn.startswith(".") or not fn.lower().endswith(".md"):
                continue
            abs_path = Path(dirpath) / fn
            rel = abs_path.relative_to(vault).as_posix()
            if any(rx.match(rel) for rx in excludes):
                excluded += 1
                continue
            files.append((rel, abs_path))
    files.sort(key=lambda t: t[0])
    return files, excluded


def note_key(rel: str) -> str:
    return "N" + hashlib.sha1(rel.encode("utf-8")).hexdigest()[:10]


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ── build ──────────────────────────────────────────────────────────────────────

def _signature(cfg, files: list[tuple[str, Path]], ns: dict, s: SearchSettings) -> str:
    """Everything a build depends on, cheaply: each note's path, mtime and size, the paper index (literature notes
    are matched against it), the model and the settings. Unchanged means nothing to do."""
    stats_sig = []
    for rel, p in files:
        try:
            st = p.stat()
        except OSError:
            continue
        stats_sig.append([rel, st.st_mtime_ns, st.st_size])
    papers_hash = (load_json(cfg.data_dir / "search" / "manifest.json", {}) or {}).get("content_hash")
    return _sha(json.dumps({
        "files": stats_sig, "papers": papers_hash, "model": s.model, "dims": s.dims, "chunker": CHUNKER,
        "ns": {k: ns[k] for k in sorted(ns)}, "vault": str(cfg.vault), "daily": str(cfg.daily_dir),
    }, sort_keys=True))


def _vector_cache(notes_dir: Path, dims: int) -> tuple[array.array, dict[str, int]]:
    """The previous build's vectors and, for each text it embedded, sha256(text) -> row."""
    prev_vecs = array.array("f")
    cache: dict[str, int] = {}
    vf = notes_dir / "vectors.f32"
    if vf.exists():
        prev_vecs.frombytes(vf.read_bytes())
    nrows = len(prev_vecs) // dims if dims else 0
    for p in load_json(notes_dir / "papers.json", []) or []:
        r = p.get("abstractRow")
        if isinstance(r, int) and 0 <= r < nrows:
            title, lead = p.get("title", ""), p.get("abstract")
            cache[_sha(f"{title}\n\n{lead}" if lead else title)] = r
    for c in load_json(notes_dir / "chunks.json", []) or []:
        r = c.get("row")
        if isinstance(r, int) and 0 <= r < nrows:
            cache[_sha(c.get("text", ""))] = r
    return prev_vecs, cache


@dataclass
class _Note:
    entry: dict                  # its papers.json entry (rows filled in by _layout)
    abstract_text: str | None    # title + lead, embedded as the note's "abstract"; None for a note too short to embed
    chunks: list[dict]


def _parse_notes(cfg, files: list[tuple[str, Path]], ns: dict) -> tuple[list[_Note], list[str]]:
    """Every readable note as an entry with its chunks; unreadable ones are listed as skipped."""
    search_papers = load_json(cfg.data_dir / "search" / "papers.json", []) or []
    citekeys = {p.get("citekey") for p in search_papers if p.get("citekey")}
    notes: list[_Note] = []
    skipped: list[str] = []
    for rel, abs_path in files:
        try:
            text = _read_text(abs_path)
            st = abs_path.stat()
        except OSError as e:
            skipped.append(f"{rel}: {e.strerror or e}")
            continue
        basename = abs_path.stem
        daily_iso = abs_path.stem if DAILY_RE.match(abs_path.name) and abs_path.parent == cfg.daily_dir else None
        note = mdtext.parse_note(text, basename, daily_iso)

        lit_of = None
        if note.citekey and note.citekey in citekeys:
            lit_of = note.citekey
        elif basename in citekeys:
            lit_of = basename
        kind = "litnote" if lit_of else ("daily" if daily_iso else "note")

        chunks: list[dict] = []
        lead = ""
        abstract_text = None
        if len(note.body_text.split()) >= MIN_BODY_WORDS:
            lead = mdtext.lead_text(note.sections, ns["lead_words"])
            abstract_text = f"{note.title}\n\n{lead}" if lead else note.title
            for c in mdtext.chunk_note(note.sections, ns["chunk_words"], ns["chunk_overlap_words"],
                                       ns["min_section_words"], ns["max_chunks_per_note"]):
                chunks.append({"attachmentKey": "", "page": 0, "text": c.text, "row": None,
                               "heading": c.heading, "line": c.line})
        folder = abs_path.parent.relative_to(cfg.vault).as_posix()
        notes.append(_Note(entry={
            "key": note_key(rel), "citekey": basename, "title": note.title, "authors": [],
            "year": None, "journal": None, "doi": None, "tags": note.tags,
            "collections": [] if folder == "." else [folder],
            "abstract": lead or None, "pdfs": [], "abstractRow": None,
            "kind": kind, "path": rel, "mtime": int(st.st_mtime), "litnoteOf": lit_of,
        }, abstract_text=abstract_text, chunks=chunks))
    return notes, skipped


def _texts(notes: list[_Note]):
    for n in notes:
        if n.abstract_text:
            yield n.abstract_text
        yield from (c["text"] for c in n.chunks)


def _layout(notes: list[_Note], vec_for) -> tuple[array.array, list[dict], int]:
    """Compact rows in note order for every text with a vector; returns the vectors, chunks.json and how many texts
    have none (embedding failed)."""
    vectors = array.array("f")
    chunks_data: list[dict] = []
    row = missing = 0
    for idx, n in enumerate(notes):
        if n.abstract_text:
            v = vec_for(n.abstract_text)
            if v is not None:
                n.entry["abstractRow"] = row
                vectors.extend(v)
                row += 1
            else:
                missing += 1
        for c in n.chunks:
            v = vec_for(c["text"])
            if v is not None:
                c["row"] = row
                vectors.extend(v)
                row += 1
            else:
                missing += 1
            chunks_data.append({"paper": idx, **c})
    return vectors, chunks_data, missing


def build_index(
    cfg,
    full: bool = False,
    embed_fn=None,
    lock_timeout: float = 60.0,
    blocking: bool = True,
    allow_fallback: bool | None = None,
) -> dict:
    """Build or update `.planner/notes/`. Raises BlockingIOError when `blocking=False` and another build runs."""
    if allow_fallback is None:
        allow_fallback = embed_fn is None
    t0 = time.time()
    ns = settings(cfg)
    s = SearchSettings.of(cfg)

    with building(cfg, "notes", "notes.lock", timeout=lock_timeout, blocking=blocking) as dirs:
        notes_dir = dirs.live
        files, excluded = scan(cfg.vault, compile_excludes(ns["exclude"]))
        if not files and not full and notes_dir.exists():
            prev = load_json(notes_dir / "manifest.json") or {}
            if prev.get("papers"):
                raise VaultUnreadable(f"{cfg.vault} has no notes now (the index has {prev['papers']}); "
                                      "keeping the index. If that is right, run: planner notes index --full")
        signature = _signature(cfg, files, ns, s)

        prev_manifest = load_json(notes_dir / "manifest.json") if notes_dir.exists() else None
        prev_state = load_json(notes_dir / "state.json") if notes_dir.exists() else None
        comparable = (
            not full and isinstance(prev_manifest, dict) and isinstance(prev_state, dict)
            and prev_state.get("model") == s.model and prev_state.get("dims") == s.dims
            and prev_state.get("chunker") == CHUNKER
        )
        if comparable and prev_state.get("signature") == signature and not prev_manifest.get("degraded"):
            return {"notes": prev_manifest.get("papers", 0), "chunks": prev_manifest.get("chunks", 0),
                    "elapsed": time.time() - t0, "changed": False, "embedded": 0, "skipped": [],
                    "excluded": excluded, "missing_vectors": 0, "content_hash": prev_manifest.get("content_hash")}

        prev_vecs, cache = _vector_cache(notes_dir, s.dims) if comparable else (array.array("f"), {})
        notes, skipped = _parse_notes(cfg, files, ns)

        # Embed each text no build has a vector for yet (once, however many notes share it).
        pending = list(dict.fromkeys(t for t in _texts(notes) if _sha(t) not in cache))
        new_vec: dict[str, list[float]] = {}
        embed_ok = True
        if pending:
            # One try on the 5-minute tick: a down service must not hold it for minutes.
            vecs = embed_texts(pending, s, embed_fn=embed_fn, allow_fallback=allow_fallback, label="notes index",
                               max_retries=1 if allow_fallback else 3)
            embed_ok = vecs is not None
            new_vec = {_sha(t): v for t, v in zip(pending, vecs or [])}

        def vec_for(t: str):
            h = _sha(t)
            if h in new_vec:
                return new_vec[h]
            r = cache.get(h)
            return prev_vecs[r * s.dims:(r + 1) * s.dims] if r is not None else None

        vectors, chunks_data, missing = _layout(notes, vec_for)
        entries = [n.entry for n in notes]
        # Modified times are left out of the hash: a touch with no edit must not rewrite the index (that makes the
        # app reload). They are refreshed whenever the content changes.
        content_hash = compute_content_hash([{k: v for k, v in e.items() if k != "mtime"} for e in entries],
                                            chunks_data, vectors.tobytes())
        state = {"model": s.model, "dims": s.dims, "chunker": CHUNKER, "signature": signature}
        if missing:
            state["degraded"] = True
        result = {"notes": len(entries), "chunks": len(chunks_data), "skipped": skipped, "excluded": excluded,
                  "missing_vectors": missing, "content_hash": content_hash}

        if (comparable and prev_manifest.get("content_hash") == content_hash
                and bool(prev_manifest.get("degraded")) == bool(missing)):
            # Touched or re-saved but nothing that is indexed changed: refresh the signature only.
            if prev_state.get("signature") != signature:
                write_json(notes_dir / "state.json", state)
            return {**result, "elapsed": time.time() - t0, "changed": False, "embedded": 0}

        manifest = index_manifest(
            s, corpus="notes", content_hash=content_hash, chunker=CHUNKER, vault=str(cfg.vault),
            vault_name=cfg.vault.name, papers=len(entries), chunks=len(chunks_data), excluded=excluded,
            missing_vectors=missing, degraded=bool(missing))
        publish(dirs, manifest, entries, chunks_data, state, vectors)
        return {**result, "elapsed": time.time() - t0, "changed": True, "embedded": len(new_vec), "embed_ok": embed_ok}


# ── stats ──────────────────────────────────────────────────────────────────────

def get_stats(cfg) -> dict:
    notes_dir = cfg.data_dir / "notes"
    manifest = load_json(notes_dir / "manifest.json")
    if not manifest:
        return {"indexed": False}
    papers = load_json(notes_dir / "papers.json", []) or []
    kinds: dict[str, int] = {}
    for p in papers:
        kinds[p.get("kind", "note")] = kinds.get(p.get("kind", "note"), 0) + 1
    age = "unknown"
    try:
        diff = datetime.now() - datetime.fromisoformat(manifest.get("built_at", ""))
        age = f"{diff.days}d {diff.seconds // 3600}h ago" if diff.days else f"{diff.seconds // 3600}h ago"
    except (TypeError, ValueError):
        pass
    return {
        "indexed": True, "notes": len(papers), "kinds": kinds, "chunks": manifest.get("chunks", 0),
        "litnotes": kinds.get("litnote", 0), "excluded": manifest.get("excluded", 0),
        "model": manifest.get("model"), "dims": manifest.get("dims"), "age": age,
        "built_at": manifest.get("built_at"), "degraded": bool(manifest.get("degraded")),
        "missing_vectors": manifest.get("missing_vectors", 0),
    }


def print_stats(cfg) -> None:
    st = get_stats(cfg)
    if not st["indexed"]:
        print("Notes index: none yet. Run: planner notes index")
        return
    print("Notes Search Stats:")
    print(f"  Notes:                {st['notes']}  (" + ", ".join(f"{k}: {v}" for k, v in sorted(st['kinds'].items())) + ")")
    print(f"  Chunks:               {st['chunks']}")
    print(f"  Literature notes:     {st['litnotes']} matched to Zotero papers")
    print(f"  Excluded by globs:    {st['excluded']}")
    print(f"  Model:                {st['model']} (dims: {st['dims']})")
    print(f"  Index age:            {st['age']}")
    if st["degraded"]:
        print(f"  Degraded:             yes, keyword-only for {st['missing_vectors']} texts (the embedding service was unavailable)")
