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
import shutil
import time
from datetime import datetime
from pathlib import Path

from . import embed, mdtext
from .searchindex import atomic_swap, compute_content_hash, fsync_files, load_json, named_lock, write_json
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
    excludes = compile_excludes(ns["exclude"])

    notes_dir = cfg.data_dir / "notes"
    tmp_dir = cfg.data_dir / "notes.tmp"
    old_dir = cfg.data_dir / "notes.old"
    search_dir = cfg.data_dir / "search"

    model = cfg.search.get("model", "qwen3-embedding:0.6b")
    dims = int(cfg.search.get("dims", 1024))
    query_instruction = cfg.search.get(
        "query_instruction", "Given a description of what a paper found or showed, retrieve that paper")
    batch_size = int(cfg.search.get("batch_size", 32))
    keep_alive = cfg.search.get("keep_alive", "5m")
    ollama_url = cfg.search.get("ollama_url", "http://localhost:11434")
    backend = cfg.search.get("backend", "ollama")   # "pplx": the pplx-embed-v2-late profile (planner/pplx.py)
    pplx_url = cfg.search.get("pplx_url", "http://127.0.0.1:11435")

    with named_lock(cfg, "notes.lock", timeout=lock_timeout, blocking=blocking):
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        try:
            files, excluded = scan(cfg.vault, excludes)
            if not files and not full and notes_dir.exists():
                prev = load_json(notes_dir / "manifest.json") or {}
                if prev.get("papers"):
                    raise VaultUnreadable(f"{cfg.vault} has no notes now (the index has {prev['papers']}); "
                                          "keeping the index. If that is right, run: planner notes index --full")
            stats_sig = []
            for rel, p in files:
                try:
                    st = p.stat()
                except OSError:
                    continue
                stats_sig.append([rel, st.st_mtime_ns, st.st_size])

            papers_manifest = load_json(search_dir / "manifest.json", {}) or {}
            papers_hash = papers_manifest.get("content_hash")
            signature = _sha(json.dumps({
                "files": stats_sig, "papers": papers_hash, "model": model, "dims": dims, "chunker": CHUNKER,
                "ns": {k: ns[k] for k in sorted(ns)}, "vault": str(cfg.vault), "daily": str(cfg.daily_dir),
            }, sort_keys=True))

            prev_manifest = load_json(notes_dir / "manifest.json") if notes_dir.exists() else None
            prev_state = load_json(notes_dir / "state.json") if notes_dir.exists() else None
            comparable = (
                not full and isinstance(prev_manifest, dict) and isinstance(prev_state, dict)
                and prev_state.get("model") == model and prev_state.get("dims") == dims
                and prev_state.get("chunker") == CHUNKER
            )
            if comparable and prev_state.get("signature") == signature and not prev_manifest.get("degraded"):
                elapsed = time.time() - t0
                return {"notes": prev_manifest.get("papers", 0), "chunks": prev_manifest.get("chunks", 0),
                        "elapsed": elapsed, "changed": False, "embedded": 0, "skipped": [],
                        "excluded": excluded, "missing_vectors": 0,
                        "content_hash": prev_manifest.get("content_hash")}

            # Vector cache: sha(embedded text) -> row in the previous vectors.f32
            prev_vecs = array.array("f")
            cache: dict[str, int] = {}
            if comparable:
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

            citekeys = {p.get("citekey") for p in (load_json(search_dir / "papers.json", []) or []) if p.get("citekey")}

            entries: list[dict] = []           # papers.json entries (rows filled in later)
            entry_chunks: list[list[dict]] = []
            entry_abstract_text: list[str | None] = []
            skipped: list[str] = []
            for rel, abs_path in files:
                try:
                    text = _read_text(abs_path)
                    st = abs_path.stat()
                except OSError as e:
                    skipped.append(f"{rel}: {e.strerror or e}")
                    continue
                basename = abs_path.stem
                daily_iso = None
                if DAILY_RE.match(abs_path.name) and abs_path.parent == cfg.daily_dir:
                    daily_iso = abs_path.stem
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
                entries.append({
                    "key": note_key(rel), "citekey": basename, "title": note.title, "authors": [],
                    "year": None, "journal": None, "doi": None, "tags": note.tags,
                    "collections": [] if folder == "." else [folder],
                    "abstract": lead or None, "pdfs": [], "abstractRow": None,
                    "kind": kind, "path": rel, "mtime": int(st.st_mtime), "litnoteOf": lit_of,
                })
                entry_chunks.append(chunks)
                entry_abstract_text.append(abstract_text)

            # What needs embedding
            pending: list[str] = []
            seen = set(cache)
            for abs_text, chunks in zip(entry_abstract_text, entry_chunks):
                for t in ([abs_text] if abs_text else []) + [c["text"] for c in chunks]:
                    h = _sha(t)
                    if h not in seen:
                        seen.add(h)
                        pending.append(t)

            new_vec: dict[str, list[float]] = {}
            embed_ok = True
            if pending:
                try:
                    if embed_fn:
                        vecs = embed_fn(pending, dims=dims)
                    else:
                        vecs = embed.embed(pending, model=model, dims=dims, batch_size=batch_size,
                                           keep_alive=keep_alive, ollama_url=ollama_url,
                                           max_retries=1 if allow_fallback else 3, backend=backend, pplx_url=pplx_url)
                    for t, v in zip(pending, vecs):
                        new_vec[_sha(t)] = v
                except Exception as e:
                    if not allow_fallback:
                        raise
                    print(f"notes index: Ollama embedding unavailable ({e}); falling back to keyword-only", flush=True)
                    embed_ok = False

            # Assign compact rows
            vectors = array.array("f")
            row = 0
            missing = 0

            def vec_for(t: str):
                h = _sha(t)
                if h in new_vec:
                    return new_vec[h]
                r = cache.get(h)
                if r is not None:
                    return prev_vecs[r * dims:(r + 1) * dims]
                return None

            chunks_data: list[dict] = []
            for idx, (entry, abs_text, chunks) in enumerate(zip(entries, entry_abstract_text, entry_chunks)):
                if abs_text:
                    v = vec_for(abs_text)
                    if v is not None:
                        entry["abstractRow"] = row
                        vectors.extend(v)
                        row += 1
                    else:
                        missing += 1
                for c in chunks:
                    v = vec_for(c["text"])
                    if v is not None:
                        c["row"] = row
                        vectors.extend(v)
                        row += 1
                    else:
                        missing += 1
                    chunks_data.append({"paper": idx, **c})

            vec_bytes = vectors.tobytes()
            # Modified times are left out of the hash: a touch with no edit must not rewrite the index (that makes the
            # app reload). They are refreshed whenever the content changes.
            content_hash = compute_content_hash([{k: v for k, v in e.items() if k != "mtime"} for e in entries],
                                                chunks_data, vec_bytes)
            state = {"model": model, "dims": dims, "chunker": CHUNKER, "signature": signature}
            if missing:
                state["degraded"] = True

            if (comparable and prev_manifest.get("content_hash") == content_hash
                    and bool(prev_manifest.get("degraded")) == bool(missing)):
                # Touched or re-saved but nothing that is indexed changed: refresh the signature only.
                if prev_state.get("signature") != signature:
                    write_json(notes_dir / "state.json", state)
                return {"notes": len(entries), "chunks": len(chunks_data), "elapsed": time.time() - t0,
                        "changed": False, "embedded": 0, "skipped": skipped, "excluded": excluded,
                        "missing_vectors": missing, "content_hash": content_hash}

            manifest = {
                "format": 1, "corpus": "notes",
                "built_at": datetime.now().strftime("%Y-%m-%dT%H:%M"),
                "content_hash": content_hash, "model": model, "dims": dims,
                "query_instruction": query_instruction, "chunker": CHUNKER,
                "vault": str(cfg.vault), "vault_name": cfg.vault.name,
                "papers": len(entries), "chunks": len(chunks_data),
                "excluded": excluded, "missing_vectors": missing, "degraded": bool(missing),
            }
            if backend != "ollama":
                manifest["backend"] = backend   # readers score rows through that backend's service, at backend_url
                manifest["backend_url"] = pplx_url
            tmp_dir.mkdir(parents=True, exist_ok=True)
            write_json(tmp_dir / "manifest.json", manifest)
            write_json(tmp_dir / "papers.json", entries)
            write_json(tmp_dir / "chunks.json", chunks_data)
            write_json(tmp_dir / "state.json", state)
            with open(tmp_dir / "vectors.f32", "wb") as f:
                vectors.tofile(f)
                f.flush()
                os.fsync(f.fileno())
            fsync_files(tmp_dir, ["manifest.json", "papers.json", "chunks.json", "state.json"])
            atomic_swap(tmp_dir, notes_dir, old_dir)
            return {"notes": len(entries), "chunks": len(chunks_data), "elapsed": time.time() - t0,
                    "changed": True, "embedded": len(new_vec), "skipped": skipped, "excluded": excluded,
                    "missing_vectors": missing, "content_hash": content_hash, "embed_ok": embed_ok}
        except Exception:
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir)
            raise


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
    except Exception:
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
        print(f"  Degraded:             yes, keyword-only for {st['missing_vectors']} texts (Ollama was unavailable)")
