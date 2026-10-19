import array
import hashlib
import json
import os
import shutil
from datetime import datetime
from pathlib import Path

from . import embed, pdftext, zotlib


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


def build_index(cfg, full: bool = False, limit: int | None = None, embed_fn=None) -> dict:
    """Build or incrementally update search index."""
    import time
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
    chunker = "pages-v1"
    chunk_words = int(cfg.search.get("chunk_words", 300))
    chunk_overlap_words = int(cfg.search.get("chunk_overlap_words", 50))
    max_chunks_per_paper = int(cfg.search.get("max_chunks_per_paper", 150))
    batch_size = int(cfg.search.get("batch_size", 32))
    keep_alive = cfg.search.get("keep_alive", "30m")
    ollama_url = cfg.search.get("ollama_url", "http://localhost:11434")
    zotero_dir = Path(cfg.search.get("zotero_dir", "~/Zotero")).expanduser()

    # Clean tmp dir before starting
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)

    try:
        # Load previous state if not full rebuild
        prev_state = None
        if not full and search_dir.exists():
            state_data = load_json(search_dir / "state.json")
            if (
                state_data
                and state_data.get("model") == model
                and state_data.get("dims") == dims
                and state_data.get("chunker") == chunker
            ):
                prev_state = state_data

        cached_abstracts: dict[str, list[float]] = {}
        cached_attachments: dict[str, dict] = {}
        if prev_state:
            cached_abstracts = prev_state.get("abstracts", {})
            cached_attachments = prev_state.get("attachments", {})

        # Read library
        papers = zotlib.read_library(zotero_dir)
        if limit is not None:
            papers = papers[:limit]

        # Scan what needs embedding
        pending_embed_texts: list[str] = []
        pending_abstract_shas: list[str] = []
        pending_chunk_keys: list[tuple[str, int]] = []  # (attachmentKey, chunk_index)

        paper_abstract_info: list[tuple[str, str, str | None]] = []  # (paper_key, title, sha or None)
        paper_attachment_chunks: dict[str, list[dict]] = {}  # att_key -> list of {"page": ..., "text": ..., "vec": ...}

        for p in papers:
            if p.abstract:
                abstract_text = f"{p.title}\n\n{p.abstract}"
                sha = hashlib.sha256(abstract_text.encode("utf-8")).hexdigest()
                paper_abstract_info.append((p.key, p.title, sha))
                if sha not in cached_abstracts and sha not in pending_abstract_shas:
                    pending_embed_texts.append(abstract_text)
                    pending_abstract_shas.append(sha)
            else:
                paper_abstract_info.append((p.key, p.title, None))

            for pdf in p.pdfs:
                if not pdf.path.exists():
                    pdf.hasText = False
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
                    has_text, num_pages, extracted = pdftext.extract_chunks(
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
                        pending_embed_texts.append(ch.text)
                        pending_chunk_keys.append((pdf.attachmentKey, chunk_idx))
                    paper_attachment_chunks[pdf.attachmentKey] = chunks_list

        # Run embeddings for any pending texts
        if pending_embed_texts:
            if embed_fn:
                new_vecs = embed_fn(pending_embed_texts, dims=dims)
            else:
                new_vecs = embed.embed(
                    pending_embed_texts,
                    model=model,
                    dims=dims,
                    batch_size=batch_size,
                    keep_alive=keep_alive,
                    ollama_url=ollama_url,
                )

            # Assign new vectors
            vec_idx = 0
            for sha in pending_abstract_shas:
                cached_abstracts[sha] = new_vecs[vec_idx]
                vec_idx += 1

            for att_key, chunk_idx in pending_chunk_keys:
                paper_attachment_chunks[att_key][chunk_idx]["vec"] = new_vecs[vec_idx]
                vec_idx += 1

        # Now assign compact rows and build papers.json, chunks.json, vectors.f32
        papers_data: list[dict] = []
        chunks_data: list[dict] = []
        all_vectors = array.array("f")
        current_row = 0

        # Update cached_attachments with latest mtime/size
        new_cached_attachments: dict[str, dict] = {}
        for p in papers:
            for pdf in p.pdfs:
                stat = pdf.path.stat() if pdf.path.exists() else None
                new_cached_attachments[pdf.attachmentKey] = {
                    "mtime": stat.st_mtime_ns if stat else 0,
                    "size": stat.st_size if stat else 0,
                    "pages": pdf.pages,
                    "hasText": pdf.hasText,
                    "chunks": paper_attachment_chunks.get(pdf.attachmentKey, []),
                }

        for p_idx, p in enumerate(papers):
            _, _, sha = paper_abstract_info[p_idx]
            if sha is not None:
                abstract_row = current_row
                abstract_vec = cached_abstracts[sha]
                all_vectors.extend(abstract_vec)
                current_row += 1
            else:
                abstract_row = None

            papers_data.append(p.to_dict(abstract_row=abstract_row))

            for pdf in p.pdfs:
                for chunk in paper_attachment_chunks.get(pdf.attachmentKey, []):
                    ch_row = current_row
                    all_vectors.extend(chunk["vec"])
                    chunks_data.append({
                        "paper": p_idx,
                        "attachmentKey": pdf.attachmentKey,
                        "page": chunk["page"],
                        "text": chunk["text"],
                        "row": ch_row,
                    })
                    current_row += 1

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
        }

        # Build new state.json
        state_data = {
            "model": model,
            "dims": dims,
            "chunker": chunker,
            "abstracts": cached_abstracts,
            "attachments": new_cached_attachments,
        }

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
        no_text_pdfs = [
            f"{p['citekey']}:{pdf['attachmentKey']}"
            for p in papers_data
            for pdf in p["pdfs"]
            if not pdf["hasText"]
        ]
        return {
            "papers": len(papers_data),
            "chunks": len(chunks_data),
            "elapsed": elapsed,
            "no_text_pdfs": no_text_pdfs,
        }

    except Exception:
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        raise
