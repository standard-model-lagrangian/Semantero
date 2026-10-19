import json
from datetime import datetime, timezone
from pathlib import Path

from . import zotlib


def load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return default
    return default


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
        # Read from live Zotero database
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
