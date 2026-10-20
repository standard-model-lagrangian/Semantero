import array
import fcntl
import hashlib
import json
import os
import shutil
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from . import embed, htmltext, pdftext, zotlib


def load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return default
    return default


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def compute_content_hash(papers_data: list[dict], chunks_data: list[dict], vector_bytes: bytes) -> str:
    hasher = hashlib.sha256()
    hasher.update(json.dumps(papers_data, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    hasher.update(json.dumps(chunks_data, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    hasher.update(hashlib.sha256(vector_bytes).digest())
    return hasher.hexdigest()


# Locks this process already holds, by path, with their nesting depth. flock locks belong to the
# open file, so a second open() of the same lock in this process would block on the first one
# (watch-run holds the lock and then calls build_index, which takes it again).
_held_locks: dict[str, int] = {}


@contextmanager
def search_lock(cfg, timeout: float = 60.0, blocking: bool = True):
    lock_path = cfg.data_dir / "search.lock"
    key = str(lock_path.resolve())
    if _held_locks.get(key):
        _held_locks[key] += 1
        try:
            yield None
        finally:
            _held_locks[key] -= 1
        return

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    f = open(lock_path, "a")
    start_time = time.time()
    acquired = False
    try:
        while True:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except (BlockingIOError, OSError):
                if not blocking:
                    raise BlockingIOError("busy: lock held by another process")
                if (time.time() - start_time) >= timeout:
                    raise TimeoutError(f"Could not acquire search.lock after {timeout}s: held by another process")
                time.sleep(0.05)
        _held_locks[key] = 1
        yield f
    finally:
        if acquired:
            _held_locks.pop(key, None)
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        f.close()


def get_stats(cfg) -> dict:
    search_dir = cfg.data_dir / "search"
    manifest_path = search_dir / "manifest.json"
    papers_path = search_dir / "papers.json"
    chunks_path = search_dir / "chunks.json"

    zotero_dir = Path(cfg.search.get("zotero_dir", "~/Zotero")).expanduser()
    model = cfg.search.get("model", "qwen3-embedding:0.6b")

    if manifest_path.exists():
        manifest = load_json(manifest_path, {})
        papers = load_json(papers_path, [])
        chunks = load_json(chunks_path, [])

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
            "model": manifest.get("model", model),
            "dims": manifest.get("dims", cfg.search.get("dims", 1024)),
            "age": age_str,
            "built_at": built_at_str,
            "content_hash": manifest.get("content_hash"),
        }
    else:
        try:
            raw_papers = zotlib.read_library(zotero_dir)
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
            "model": model,
            "dims": cfg.search.get("dims", 1024),
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


def build_index(
    cfg,
    full: bool = False,
    limit: int | None = None,
    embed_fn=None,
    lock_timeout: float = 60.0,
    allow_fallback: bool | None = None,
) -> dict:
    """Build or incrementally update search index.

    If Ollama is unreachable (and allow_fallback), texts without a cached vector are written with no
    row: keyword search still finds them, and the index is marked degraded until a later build embeds them.
    """
    if allow_fallback is None:
        allow_fallback = (embed_fn is None)
    t0 = time.time()

    search_dir = cfg.data_dir / "search"
    tmp_dir = cfg.data_dir / "search.tmp"
    old_dir = cfg.data_dir / "search.old"

    model = cfg.search.get("model", "qwen3-embedding:0.6b")
    dims = int(cfg.search.get("dims", 1024))
    query_instruction = cfg.search.get(
        "query_instruction",
        "Given a description of what a paper found or showed, retrieve that paper",
    )
    # v2: web snapshots (text/html attachments) are chunked too, with page 0
    chunker = "pages-v2"
    chunk_words = int(cfg.search.get("chunk_words", 300))
    chunk_overlap_words = int(cfg.search.get("chunk_overlap_words", 50))
    max_chunks_per_paper = int(cfg.search.get("max_chunks_per_paper", 150))
    batch_size = int(cfg.search.get("batch_size", 32))
    keep_alive = cfg.search.get("keep_alive", "30m")
    ollama_url = cfg.search.get("ollama_url", "http://localhost:11434")
    zotero_dir = Path(cfg.search.get("zotero_dir", "~/Zotero")).expanduser()

    with search_lock(cfg, timeout=lock_timeout, blocking=True):
        # Clean tmp dir before starting
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)

        try:
            prev_manifest = None
            prev_state = None
            prev_vecs: array.array | None = None
            prev_chunks_by_row: dict[int, dict] = {}

            # The watcher records its Zotero fingerprint in state.json; keep it across rebuilds.
            old_state = load_json(search_dir / "state.json") if search_dir.exists() else None
            watcher_fingerprint = old_state.get("fingerprint") if isinstance(old_state, dict) else None

            if not full and search_dir.exists():
                prev_manifest = load_json(search_dir / "manifest.json")
                state_data = old_state
                if (
                    state_data
                    and state_data.get("model") == model
                    and state_data.get("dims") == dims
                    and state_data.get("chunker") == chunker
                ):
                    prev_state = state_data
                    vec_file = search_dir / "vectors.f32"
                    if vec_file.exists():
                        arr = array.array("f")
                        arr.frombytes(vec_file.read_bytes())
                        prev_vecs = arr
                    for c in load_json(search_dir / "chunks.json", []):
                        if isinstance(c, dict) and "row" in c:
                            prev_chunks_by_row[c["row"]] = c

            cached_abstracts: dict[str, list[float]] = {}
            cached_attachments: dict[str, dict] = {}
            if prev_state:
                for sha, val in prev_state.get("abstracts", {}).items():
                    if isinstance(val, list):
                        cached_abstracts[sha] = val
                    elif isinstance(val, int) and prev_vecs is not None:
                        start = val * dims
                        end = start + dims
                        if end <= len(prev_vecs):
                            cached_abstracts[sha] = list(prev_vecs[start:end])

                for att_key, att_info in prev_state.get("attachments", {}).items():
                    resolved_chunks: list[dict] = []
                    valid_att = True
                    for c_item in att_info.get("chunks", []):
                        if isinstance(c_item, dict) and "vec" in c_item:
                            resolved_chunks.append(c_item)
                        elif isinstance(c_item, int) and prev_vecs is not None and c_item in prev_chunks_by_row:
                            start = c_item * dims
                            end = start + dims
                            if end <= len(prev_vecs):
                                c_meta = prev_chunks_by_row[c_item]
                                resolved_chunks.append({
                                    "page": c_meta["page"],
                                    "text": c_meta["text"],
                                    "vec": list(prev_vecs[start:end]),
                                })
                            else:
                                valid_att = False
                                break
                        else:
                            valid_att = False
                            break
                    if valid_att:
                        cached_attachments[att_key] = {
                            "mtime": att_info.get("mtime", 0),
                            "size": att_info.get("size", 0),
                            "pages": att_info.get("pages", 0),
                            "hasText": att_info.get("hasText", True),
                            "chunks": resolved_chunks,
                        }

            # Read library
            papers = zotlib.read_library(zotero_dir)
            if limit is not None:
                papers = papers[:limit]

            # Scan what needs embedding
            pending_abs_texts: list[str] = []
            pending_abstract_shas: list[str] = []
            pending_chunk_texts: list[str] = []
            pending_chunk_keys: list[tuple[str, int]] = []  # (attachmentKey, chunk_index)

            paper_abstract_info: list[tuple[str, str, str | None]] = []  # (paper_key, title, sha or None)
            paper_attachment_chunks: dict[str, list[dict]] = {}  # att_key -> list of {"page": ..., "text": ..., "vec": ...}

            for p in papers:
                abstract_text = f"{p.title}\n\n{p.abstract}" if p.abstract else p.title
                if abstract_text:
                    sha = hashlib.sha256(abstract_text.encode("utf-8")).hexdigest()
                    paper_abstract_info.append((p.key, p.title, sha))
                    if sha not in cached_abstracts and sha not in pending_abstract_shas:
                        pending_abs_texts.append(abstract_text)
                        pending_abstract_shas.append(sha)
                else:
                    paper_abstract_info.append((p.key, p.title, None))

                for pdf in p.attachments():
                    if not pdf.path.exists():
                        # Missing PDF: indexed with 0 chunks, not cached as no-text
                        pdf.hasText = True
                        pdf.pages = 0
                        paper_attachment_chunks[pdf.attachmentKey] = []
                        continue

                    stat = pdf.path.stat()
                    mtime = stat.st_mtime_ns
                    size = stat.st_size

                    cached_att = cached_attachments.get(pdf.attachmentKey)
                    if cached_att and cached_att.get("mtime") == mtime and cached_att.get("size") == size:
                        pdf.pages = cached_att.get("pages", 0)
                        pdf.hasText = cached_att.get("hasText", True)
                        paper_attachment_chunks[pdf.attachmentKey] = cached_att.get("chunks", [])
                    else:
                        extractor = htmltext if isinstance(pdf, zotlib.SnapshotAttachment) else pdftext
                        has_text, num_pages, extracted = extractor.extract_chunks(
                            pdf.path,
                            chunk_words=chunk_words,
                            chunk_overlap_words=chunk_overlap_words,
                            max_chunks=max_chunks_per_paper,
                        )
                        pdf.pages = num_pages
                        pdf.hasText = has_text
                        chunks_list: list[dict] = []
                        for ch in extracted:
                            chunk_idx = len(chunks_list)
                            chunks_list.append({"page": ch.page, "text": ch.text, "vec": None})
                            pending_chunk_texts.append(ch.text)
                            pending_chunk_keys.append((pdf.attachmentKey, chunk_idx))
                        paper_attachment_chunks[pdf.attachmentKey] = chunks_list

            pending_texts = pending_abs_texts + pending_chunk_texts
            embed_succeeded = True
            if pending_texts:
                if allow_fallback:
                    try:
                        if embed_fn:
                            new_vecs = embed_fn(pending_texts, dims=dims)
                        else:
                            new_vecs = embed.embed(
                                pending_texts,
                                model=model,
                                dims=dims,
                                batch_size=batch_size,
                                keep_alive=keep_alive,
                                ollama_url=ollama_url,
                            )
                    except Exception as e:
                        print(f"search index: Ollama embedding unavailable ({e}); falling back to keyword-only index", flush=True)
                        embed_succeeded = False
                        new_vecs = None
                else:
                    if embed_fn:
                        new_vecs = embed_fn(pending_texts, dims=dims)
                    else:
                        new_vecs = embed.embed(
                            pending_texts,
                            model=model,
                            dims=dims,
                            batch_size=batch_size,
                            keep_alive=keep_alive,
                            ollama_url=ollama_url,
                        )

                if embed_succeeded and new_vecs is not None:
                    vec_idx = 0
                    for sha in pending_abstract_shas:
                        cached_abstracts[sha] = new_vecs[vec_idx]
                        vec_idx += 1
                    for att_key, chunk_idx in pending_chunk_keys:
                        paper_attachment_chunks[att_key][chunk_idx]["vec"] = new_vecs[vec_idx]
                        vec_idx += 1

            # Now assign compact rows and build papers_data, chunks_data, all_vectors
            papers_data: list[dict] = []
            chunks_data: list[dict] = []
            all_vectors = array.array("f")
            current_row = 0

            state_abstracts: dict[str, int] = {}
            state_attachments: dict[str, dict] = {}
            for p in papers:
                for pdf in p.attachments():
                    if not pdf.path.exists():
                        # Do not cache missing PDFs in state_attachments so next run retries
                        continue
                    chunks = paper_attachment_chunks.get(pdf.attachmentKey, [])
                    # If this PDF has text, only cache in state_attachments if all chunks were embedded
                    if pdf.hasText and chunks and not all(c.get("vec") is not None for c in chunks):
                        continue
                    stat = pdf.path.stat()
                    state_attachments[pdf.attachmentKey] = {
                        "mtime": stat.st_mtime_ns,
                        "size": stat.st_size,
                        "pages": pdf.pages,
                        "hasText": pdf.hasText,
                        "chunks": [],
                    }

            for p_idx, p in enumerate(papers):
                _, _, sha = paper_abstract_info[p_idx]
                if sha is not None and sha in cached_abstracts and cached_abstracts[sha] is not None:
                    abstract_row = current_row
                    abstract_vec = cached_abstracts[sha]
                    all_vectors.extend(abstract_vec)
                    state_abstracts[sha] = abstract_row
                    current_row += 1
                else:
                    abstract_row = None

                papers_data.append(p.to_dict(abstract_row=abstract_row))

                for pdf in p.attachments():
                    if not pdf.path.exists():
                        continue
                    for chunk in paper_attachment_chunks.get(pdf.attachmentKey, []):
                        if chunk.get("vec") is not None:
                            ch_row = current_row
                            all_vectors.extend(chunk["vec"])
                            if pdf.attachmentKey in state_attachments:
                                state_attachments[pdf.attachmentKey]["chunks"].append(ch_row)
                            current_row += 1
                        else:
                            ch_row = None
                        chunks_data.append({
                            "paper": p_idx,
                            "attachmentKey": pdf.attachmentKey,
                            "page": chunk["page"],
                            "text": chunk["text"],
                            "row": ch_row,
                        })

            # Compute content_hash
            vec_bytes = all_vectors.tobytes()
            content_hash = compute_content_hash(papers_data, chunks_data, vec_bytes)

            no_text_pdfs = [
                f"{p['citekey']}:{pdf['attachmentKey']}"
                for p, orig_p in zip(papers_data, papers)
                for pdf, orig_pdf in zip(p["pdfs"], orig_p.pdfs)
                if orig_pdf.path.exists() and not pdf["hasText"]
            ]

            # Texts still without a vector: everything pending when embedding failed (cached ones are reused).
            missing_vectors = 0 if embed_succeeded else len(pending_texts)

            # 0.2: Check if this is a no-op run (a failed retry that reproduces the same keyword-only index is one too)
            old_content_hash = prev_manifest.get("content_hash") if prev_manifest else None
            nothing_new = len(pending_texts) == 0 or not embed_succeeded
            if not full and nothing_new and old_content_hash is not None and content_hash == old_content_hash:
                elapsed = time.time() - t0
                print(f"search index: no changes ({elapsed:.1f}s)")
                return {
                    "papers": len(papers_data),
                    "chunks": len(chunks_data),
                    "elapsed": elapsed,
                    "no_text_pdfs": no_text_pdfs,
                    "changed": False,
                    "content_hash": content_hash,
                    "missing_vectors": missing_vectors,
                }

            # Build manifest
            manifest_data = {
                "format": 1,
                "built_at": datetime.now().strftime("%Y-%m-%dT%H:%M"),
                "model": model,
                "dims": dims,
                "query_instruction": query_instruction,
                "chunker": chunker,
                "papers": len(papers_data),
                "chunks": len(chunks_data),
                "content_hash": content_hash,
                "missing_vectors": missing_vectors,
            }

            # Build compact state.json (row indices only, vectors live in vectors.f32)
            state_data = {
                "model": model,
                "dims": dims,
                "chunker": chunker,
                "abstracts": state_abstracts,
                "attachments": state_attachments,
            }
            if watcher_fingerprint is not None:
                state_data["fingerprint"] = watcher_fingerprint
            if missing_vectors:
                # Tells the watcher to retry once Ollama is back, even if Zotero hasn't changed.
                state_data["degraded"] = True

            # Write files to search.tmp
            tmp_dir.mkdir(parents=True, exist_ok=True)
            write_json(tmp_dir / "manifest.json", manifest_data)
            write_json(tmp_dir / "papers.json", papers_data)
            write_json(tmp_dir / "chunks.json", chunks_data)
            write_json(tmp_dir / "state.json", state_data)

            vec_path = tmp_dir / "vectors.f32"
            with open(vec_path, "wb") as f:
                all_vectors.tofile(f)
                f.flush()
                os.fsync(f.fileno())

            # Fsync json files
            for fn in ["manifest.json", "papers.json", "chunks.json", "state.json"]:
                with open(tmp_dir / fn, "rb") as f:
                    os.fsync(f.fileno())

            # Atomic directory swap
            if old_dir.exists():
                shutil.rmtree(old_dir)
            if search_dir.exists():
                search_dir.rename(old_dir)
            tmp_dir.rename(search_dir)
            if old_dir.exists():
                shutil.rmtree(old_dir)

            elapsed = time.time() - t0
            return {
                "papers": len(papers_data),
                "chunks": len(chunks_data),
                "elapsed": elapsed,
                "no_text_pdfs": no_text_pdfs,
                "changed": True,
                "content_hash": content_hash,
                "missing_vectors": missing_vectors,
            }

        except Exception:
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir)
            raise
