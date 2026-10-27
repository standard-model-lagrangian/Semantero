"""What the paper index (searchindex.py) and the notes index (notesindex.py) share: the build folder and its lock,
embedding with a keyword-only fallback, the manifest, the content hash, and publishing a finished build.

An index lives in <data_dir>/<name>/ as manifest.json, papers.json, chunks.json, state.json and vectors.f32 (format:
docs/SEARCH_SPEC.md and docs/LAUNCHER_SPEC.md). A build writes all five into <name>.tmp/ and swaps that folder in
(store.atomic_swap), so readers only ever see a complete index.
"""
import array
import hashlib
import json
import os
import shutil
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterator

from . import embed
from .config import SearchSettings
from .store import atomic_swap, named_lock, recover_swap, write_json


@dataclass(frozen=True)
class IndexDirs:
    live: Path   # what readers use
    tmp: Path    # the build in progress
    old: Path    # the previous build, only during a swap

    @classmethod
    def of(cls, data_dir: Path, name: str) -> "IndexDirs":
        return cls(data_dir / name, data_dir / f"{name}.tmp", data_dir / f"{name}.old")


@contextmanager
def building(cfg, name: str, lock: str, timeout: float, blocking: bool = True) -> Iterator[IndexDirs]:
    """Holds the index's lock for one build: puts back a folder an interrupted swap left aside, clears a stale build
    folder, and removes this build's folder if it fails (the live index is untouched)."""
    dirs = IndexDirs.of(cfg.data_dir, name)
    with named_lock(cfg, lock, timeout=timeout, blocking=blocking):
        recover_swap(dirs.live, dirs.old)
        if dirs.tmp.exists():
            shutil.rmtree(dirs.tmp)
        try:
            yield dirs
        except BaseException:
            if dirs.tmp.exists():
                shutil.rmtree(dirs.tmp)
            raise


def embed_texts(texts: list[str], s: SearchSettings, *, embed_fn=None, allow_fallback: bool, label: str,
                max_retries: int = 3):
    """Vectors for `texts`. When the embedding service fails and `allow_fallback` is set, None: the caller writes those
    texts without vectors (a keyword-only, "degraded" index that a later build embeds). Otherwise the error propagates."""
    try:
        if embed_fn:
            return embed_fn(texts, dims=s.dims)
        return embed.embed(texts, **s.embed_kwargs(), max_retries=max_retries)
    except Exception as e:
        if not allow_fallback:
            raise
        print(f"{label}: embedding unavailable ({e}); falling back to keyword-only index", flush=True)
        return None


def manifest(s: SearchSettings, **fields) -> dict:
    """manifest.json: what the index was built with, then the corpus's own fields."""
    m = {"format": 1, "built_at": datetime.now().strftime("%Y-%m-%dT%H:%M"), "model": s.model, "dims": s.dims,
         "query_instruction": s.query_instruction, **fields}
    if s.backend != "ollama":
        m["backend"] = s.backend   # readers score rows through that backend's service, at backend_url
        m["backend_url"] = s.pplx_url
    return m


def append_vector(out: array.array, vec) -> None:
    """Append one vector: a memoryview of float32s (reused from the previous index) is copied as raw bytes."""
    if isinstance(vec, memoryview):
        out.frombytes(vec.cast("B"))
    else:
        out.extend(vec)


def compute_content_hash(papers_data: list[dict], chunks_data: list[dict], vector_bytes) -> str:
    """What readers compare to decide whether to reload: entries, chunks and vectors (not the manifest's timestamps)."""
    hasher = hashlib.sha256()
    hasher.update(json.dumps(papers_data, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    hasher.update(json.dumps(chunks_data, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    hasher.update(hashlib.sha256(vector_bytes).digest())
    return hasher.hexdigest()


def publish(dirs: IndexDirs, manifest: dict, papers: list[dict], chunks: list[dict], state: dict,
            vectors: array.array) -> None:
    """Write a complete index into the build folder (every file fsynced) and swap it in."""
    dirs.tmp.mkdir(parents=True, exist_ok=True)
    for name, data in (("manifest.json", manifest), ("papers.json", papers), ("chunks.json", chunks),
                       ("state.json", state)):
        write_json(dirs.tmp / name, data)
    with open(dirs.tmp / "vectors.f32", "wb") as f:
        vectors.tofile(f)
        f.flush()
        os.fsync(f.fileno())
    atomic_swap(dirs.tmp, dirs.live, dirs.old)
