"""The paper index: Zotero's library (items, PDFs, web snapshots) as <data_dir>/search/ (format: docs/SEARCH_SPEC.md)."""
import array
import hashlib
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import htmltext, pdftext, zotlib
from .config import SearchSettings
from .indexfiles import append_vector, building, compute_content_hash, embed_texts, publish
from .indexfiles import manifest as index_manifest
from .store import load_json, write_json


def get_stats(cfg) -> dict:
    search_dir = cfg.data_dir / "search"
    manifest_path = search_dir / "manifest.json"
    papers_path = search_dir / "papers.json"
    chunks_path = search_dir / "chunks.json"

    s = SearchSettings.of(cfg)

    if manifest_path.exists():
        manifest = load_json(manifest_path, {})
        papers = load_json(papers_path, [])
        # The manifest has the chunk count; reading chunks.json (all chunk text) just to count it cost ~200 MB.
        chunks = range(manifest["chunks"]) if isinstance(manifest.get("chunks"), int) else load_json(chunks_path, [])

        built_at_str = manifest.get("built_at", "")
        age_str = "unknown"
        if built_at_str:
            try:
                built_dt = datetime.fromisoformat(built_at_str)
                now = datetime.now()
                diff = now - built_dt
                days = diff.days
                hours = diff.seconds // 3600
                if days > 0:
                    age_str = f"{days}d {hours}h ago"
                else:
                    age_str = f"{hours}h ago"
            except Exception:
                age_str = built_at_str

        no_abstract_count = sum(1 for p in papers if not p.get("abstract"))
        no_text_pdfs = []
        for p in papers:
            for pdf in p.get("pdfs", []):
                if not pdf.get("hasText"):
                    no_text_pdfs.append(f"{p.get('citekey')}:{pdf.get('attachmentKey')}")

        return {
            "indexed": True,
            "papers": len(papers),
            "chunks": len(chunks),
            "no_text_pdfs": no_text_pdfs,
            "no_abstract": no_abstract_count,
            "model": manifest.get("model", s.model),
            "dims": manifest.get("dims", s.dims),
            "age": age_str,
            "built_at": built_at_str,
            "content_hash": manifest.get("content_hash"),
        }
    else:
        try:
            raw_papers = zotlib.read_library(s.zotero_dir)
            papers_count = len(raw_papers)
            no_abstract_count = sum(1 for p in raw_papers if not p.abstract)
        except Exception:
            papers_count = 0
            no_abstract_count = 0

        return {
            "indexed": False,
            "papers": papers_count,
            "chunks": 0,
            "no_text_pdfs": [],
            "no_abstract": no_abstract_count,
            "model": s.model,
            "dims": s.dims,
            "age": "no index",
            "built_at": None,
            "content_hash": None,
        }


def print_stats(cfg):
    st = get_stats(cfg)
    print("Paper Search Stats:")
    print(f"  Papers:               {st['papers']}")
    print(f"  Chunks:               {st['chunks']}")
    print(f"  Papers w/o abstract:  {st['no_abstract']}")
    print(f"  PDFs w/o text:        {len(st['no_text_pdfs'])}")
    if st["no_text_pdfs"]:
        for item in st["no_text_pdfs"]:
            print(f"    - {item}")
    print(f"  Model:                {st['model']} (dims: {st['dims']})")
    print(f"  Index age:            {st['age']}")


RECONCILE_EVERY = timedelta(days=7)
# v2: web snapshots (text/html attachments) are chunked too, with page 0
CHUNKER = "pages-v2"


def _unchanged_result(search_dir: Path, state, fingerprint, s: SearchSettings, t0) -> dict | None:
    """The no-change result when the library fingerprint matches the last successful build, else None. A full
    reconcile still runs at least weekly (`reconciled_at`), in case an edit didn't bump Zotero's clientDateModified."""
    if not fingerprint or not isinstance(state, dict) or state.get("fingerprint") != fingerprint:
        return None
    try:
        if datetime.now() - datetime.fromisoformat(state.get("reconciled_at", "")) > RECONCILE_EVERY:
            return None
    except ValueError:
        return None
    if (state.get("degraded") or state.get("model") != s.model or state.get("dims") != s.dims
            or state.get("chunker") != CHUNKER):
        return None
    manifest = load_json(search_dir / "manifest.json")
    if not isinstance(manifest, dict) or not manifest.get("zotero_storage") or manifest.get("missing_vectors"):
        return None
    if not all((search_dir / f).exists() for f in ("papers.json", "chunks.json", "vectors.f32")):
        return None
    papers = load_json(search_dir / "papers.json", []) or []
    no_text = [f"{p.get('citekey')}:{a.get('attachmentKey')}" for p in papers for a in p.get("pdfs", []) if not a.get("hasText")]
    return {
        "papers": manifest.get("papers", len(papers)), "chunks": manifest.get("chunks", 0), "elapsed": time.time() - t0,
        "no_text_pdfs": no_text, "changed": False, "content_hash": manifest.get("content_hash"), "missing_vectors": 0,
    }


@dataclass
class _Cache:
    """Vectors the previous build already computed, reusable when it used the same model, dims and chunker."""
    manifest: dict | None = None
    abstracts: dict = field(default_factory=dict)     # sha256(title + abstract) -> vector (list, or a view into vecs)
    attachments: dict = field(default_factory=dict)   # attachmentKey -> {mtime, size, pages, hasText, chunks}
    vecs: array.array | None = None                   # the previous vectors.f32; the views above point into it


def _previous_build(search_dir: Path, state, s: SearchSettings) -> _Cache:
    cache = _Cache(manifest=load_json(search_dir / "manifest.json"))
    if not (state and state.get("model") == s.model and state.get("dims") == s.dims and state.get("chunker") == CHUNKER):
        return cache
    vec_file = search_dir / "vectors.f32"
    if vec_file.exists():
        cache.vecs = array.array("f")
        with open(vec_file, "rb") as vf:
            cache.vecs.fromfile(vf, vec_file.stat().st_size // cache.vecs.itemsize)
    chunks_by_row = {c["row"]: c for c in load_json(search_dir / "chunks.json", []) if isinstance(c, dict) and "row" in c}

    # Zero-copy views into the previous vectors, not lists of Python floats (~32 bytes a number: a no-op build held
    # ~770 MB) or array slices (a second copy of the file).
    view = memoryview(cache.vecs) if cache.vecs is not None else None
    def row_vec(row: int):
        start, end = row * s.dims, (row + 1) * s.dims
        return view[start:end] if view is not None and end <= len(cache.vecs) else None

    for sha, val in state.get("abstracts", {}).items():
        if isinstance(val, list):
            cache.abstracts[sha] = val
        elif isinstance(val, int) and (v := row_vec(val)) is not None:
            cache.abstracts[sha] = v

    for att_key, att_info in state.get("attachments", {}).items():
        chunks: list[dict] = []
        for c_item in att_info.get("chunks", []):
            if isinstance(c_item, dict) and "vec" in c_item:
                chunks.append(c_item)
                continue
            v = row_vec(c_item) if isinstance(c_item, int) and c_item in chunks_by_row else None
            if v is None:
                break   # one unusable chunk: the attachment is extracted and embedded again
            chunks.append({"page": chunks_by_row[c_item]["page"], "text": chunks_by_row[c_item]["text"], "vec": v})
        else:
            cache.attachments[att_key] = {"mtime": att_info.get("mtime", 0), "size": att_info.get("size", 0),
                                          "pages": att_info.get("pages", 0), "hasText": att_info.get("hasText", True),
                                          "chunks": chunks}
    return cache


@dataclass
class _Scan:
    """The library against the cache: what each paper has, and the texts that still need a vector."""
    abstract_sha: list[str | None] = field(default_factory=list)     # per paper; None without title or abstract
    attachment_chunks: dict = field(default_factory=dict)            # attachmentKey -> [{"page", "text", "vec"}]
    pending_abstracts: list[tuple[str, str]] = field(default_factory=list)   # (sha, text)
    pending_chunks: list[tuple[str, int, str]] = field(default_factory=list)  # (attachmentKey, chunk index, text)

    @property
    def pending_texts(self) -> list[str]:
        return [t for _, t in self.pending_abstracts] + [t for _, _, t in self.pending_chunks]


def _scan(papers: list, cache: _Cache, s: SearchSettings) -> _Scan:
    scan = _Scan()
    pending_shas: set[str] = set()
    for p in papers:
        abstract_text = f"{p.title}\n\n{p.abstract}" if p.abstract else p.title
        sha = hashlib.sha256(abstract_text.encode("utf-8")).hexdigest() if abstract_text else None
        scan.abstract_sha.append(sha)
        if sha and sha not in cache.abstracts and sha not in pending_shas:
            pending_shas.add(sha)
            scan.pending_abstracts.append((sha, abstract_text))

        for att in p.attachments():
            if not att.path.exists():
                # Missing file: indexed with 0 chunks, not cached as no-text, retried on the next run
                att.hasText, att.pages = True, 0
                scan.attachment_chunks[att.attachmentKey] = []
                continue
            st = att.path.stat()
            cached = cache.attachments.get(att.attachmentKey)
            if cached and cached.get("mtime") == st.st_mtime_ns and cached.get("size") == st.st_size:
                att.pages, att.hasText = cached.get("pages", 0), cached.get("hasText", True)
                scan.attachment_chunks[att.attachmentKey] = cached.get("chunks", [])
                continue
            extractor = htmltext if isinstance(att, zotlib.SnapshotAttachment) else pdftext
            att.hasText, att.pages, extracted = extractor.extract_chunks(
                att.path, chunk_words=s.chunk_words, chunk_overlap_words=s.chunk_overlap_words,
                max_chunks=s.max_chunks_per_paper)
            chunks = [{"page": ch.page, "text": ch.text, "vec": None} for ch in extracted]
            scan.pending_chunks += [(att.attachmentKey, i, c["text"]) for i, c in enumerate(chunks)]
            scan.attachment_chunks[att.attachmentKey] = chunks
    return scan


def _layout(papers: list, scan: _Scan, abstracts: dict):
    """Compact rows: every vector that exists gets the next row, in paper order. Returns papers.json, chunks.json, the
    vectors and the state's row maps (an attachment is cached only once all its chunks have vectors)."""
    papers_data: list[dict] = []
    chunks_data: list[dict] = []
    vectors = array.array("f")
    state_abstracts: dict[str, int] = {}
    state_attachments: dict[str, dict] = {}
    for p in papers:
        for att in p.attachments():
            chunks = scan.attachment_chunks.get(att.attachmentKey, [])
            if not att.path.exists() or (att.hasText and chunks and any(c.get("vec") is None for c in chunks)):
                continue
            st = att.path.stat()
            state_attachments[att.attachmentKey] = {"mtime": st.st_mtime_ns, "size": st.st_size, "pages": att.pages,
                                                    "hasText": att.hasText, "chunks": []}

    row = 0
    for p_idx, p in enumerate(papers):
        sha = scan.abstract_sha[p_idx]
        abstract_row = None
        if sha is not None and abstracts.get(sha) is not None:
            abstract_row = row
            append_vector(vectors, abstracts[sha])
            state_abstracts[sha] = row
            row += 1
        papers_data.append(p.to_dict(abstract_row=abstract_row))

        for att in p.attachments():
            if not att.path.exists():
                continue
            for chunk in scan.attachment_chunks.get(att.attachmentKey, []):
                ch_row = None
                if chunk.get("vec") is not None:
                    ch_row = row
                    append_vector(vectors, chunk["vec"])
                    if att.attachmentKey in state_attachments:
                        state_attachments[att.attachmentKey]["chunks"].append(row)
                    row += 1
                chunks_data.append({"paper": p_idx, "attachmentKey": att.attachmentKey, "page": chunk["page"],
                                    "text": chunk["text"], "row": ch_row})
    return papers_data, chunks_data, vectors, state_abstracts, state_attachments


def build_index(
    cfg,
    full: bool = False,
    limit: int | None = None,
    embed_fn=None,
    lock_timeout: float = 60.0,
    allow_fallback: bool | None = None,
    keyword_only: bool = False,
) -> dict:
    """Build or incrementally update search index.

    If the embedding service is unreachable (and allow_fallback), texts without a cached vector are written with no
    row: keyword search still finds them, and the index is marked degraded until a later build embeds them.
    keyword_only skips embedding on purpose and writes that same degraded index: the watcher publishes one first so a
    new paper is citable within seconds, then runs a normal build for its vectors.
    """
    if allow_fallback is None:
        allow_fallback = (embed_fn is None)
    t0 = time.time()
    s = SearchSettings.of(cfg)

    with building(cfg, "search", "search.lock", timeout=lock_timeout) as dirs:
        # The watcher records its Zotero fingerprint in state.json; keep it across rebuilds.
        old_state = load_json(dirs.live / "state.json") if dirs.live.exists() else None
        watcher_fingerprint = old_state.get("fingerprint") if isinstance(old_state, dict) else None

        # Cheap no-op check (0.05 s, ~30 MB) before the full reconcile (~0.2 s, ~400 MB): the library fingerprint
        # covers items, edits and every attachment's path, size and mtime. Recorded after each successful build.
        fingerprint = zotlib.compute_fingerprint(s.zotero_dir) if limit is None else None
        if not full and limit is None:
            shortcut = _unchanged_result(dirs.live, old_state, fingerprint, s, t0)
            if shortcut is not None:
                print(f"search index: no changes ({shortcut['elapsed']:.1f}s, fingerprint)")
                return shortcut

        cache = _previous_build(dirs.live, old_state, s) if not full and dirs.live.exists() else _Cache()
        papers = zotlib.read_library(s.zotero_dir)
        if limit is not None:
            papers = papers[:limit]
        scan = _scan(papers, cache, s)

        pending_texts = scan.pending_texts
        embed_succeeded = True
        if pending_texts:
            new_vecs = None if keyword_only else embed_texts(
                pending_texts, s, embed_fn=embed_fn, allow_fallback=allow_fallback, label="search index")
            embed_succeeded = new_vecs is not None
            if embed_succeeded:
                vecs = iter(new_vecs)
                for sha, _ in scan.pending_abstracts:
                    cache.abstracts[sha] = next(vecs)
                for att_key, i, _ in scan.pending_chunks:
                    scan.attachment_chunks[att_key][i]["vec"] = next(vecs)

        papers_data, chunks_data, all_vectors, state_abstracts, state_attachments = _layout(papers, scan, cache.abstracts)
        # hashed in place: tobytes() was another copy of the whole file
        content_hash = compute_content_hash(papers_data, chunks_data, memoryview(all_vectors))
        no_text_pdfs = [
            f"{p['citekey']}:{pdf['attachmentKey']}"
            for p, orig_p in zip(papers_data, papers)
            for pdf, orig_pdf in zip(p["pdfs"], orig_p.pdfs)
            if orig_pdf.path.exists() and not pdf["hasText"]
        ]
        # Texts still without a vector: everything pending when embedding failed (cached ones are reused).
        missing_vectors = 0 if embed_succeeded else len(pending_texts)
        result = {"papers": len(papers_data), "chunks": len(chunks_data), "no_text_pdfs": no_text_pdfs,
                  "content_hash": content_hash, "missing_vectors": missing_vectors}

        # A no-op run (a failed retry that reproduces the same keyword-only index is one too) writes nothing new.
        prev = cache.manifest
        if (not full and (not pending_texts or not embed_succeeded) and prev and prev.get("zotero_storage")
                and prev.get("content_hash") is not None and content_hash == prev.get("content_hash")):
            if fingerprint is not None and not missing_vectors and isinstance(old_state, dict):
                # nothing changed: record the fingerprint and the reconcile, so the next runs can shortcut
                write_json(dirs.live / "state.json", {**old_state, "fingerprint": fingerprint,
                                                      "reconciled_at": datetime.now().isoformat(timespec="seconds")})
            elapsed = time.time() - t0
            print(f"search index: no changes ({elapsed:.1f}s)")
            return {**result, "elapsed": elapsed, "changed": False}

        manifest = index_manifest(s, chunker=CHUNKER, zotero_storage=str(s.zotero_dir / "storage"),
                                  papers=len(papers_data), chunks=len(chunks_data), content_hash=content_hash,
                                  missing_vectors=missing_vectors)
        # Compact state.json: row indices only, the vectors live in vectors.f32
        state = {"model": s.model, "dims": s.dims, "chunker": CHUNKER, "abstracts": state_abstracts,
                 "attachments": state_attachments}
        if fingerprint is not None or watcher_fingerprint is not None:
            state["fingerprint"] = fingerprint or watcher_fingerprint
        state["reconciled_at"] = datetime.now().isoformat(timespec="seconds")
        if missing_vectors:
            state["degraded"] = True   # the watcher retries once the embedding service is back, even with no change
        publish(dirs, manifest, papers_data, chunks_data, state, all_vectors)
        return {**result, "elapsed": time.time() - t0, "changed": True}
