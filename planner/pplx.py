"""Client side of the pplx-embed-v2-late profile; stdlib only. The service is planner/pplxd.py.

pplx-embed-v2-late is a late-interaction model: one 128-dim vector per token, scored with MaxSim. The index format
keeps one vector per row, so for this profile:
  - the service keeps every row's token vectors in a token cache outside the vault (~1 GB; the vault may sync), and
  - vectors.f32 holds the row's mean token vector (128 dims, L2-normalised). That vector is also the row's cache key:
    the SHA-256 of its float32 bytes finds the row's tokens.
So the builders, their incremental reuse (cached rows keep their vector and so their key) and atomic swaps work unchanged,
and the service maps rows to tokens from vectors.f32 alone. Query scoring happens in the service, which returns one
MaxSim score per row; the plugin and the app feed those into the same ranking code as any other model's row scores.
"""
import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

DAITO_SUPPORT = Path.home() / "Library" / "Application Support" / "daito"


def model_dir(model: str) -> Path:
    return DAITO_SUPPORT / "models" / model


def cache_dir(model: str, vault: Path) -> Path:
    """Token cache of one model for one vault (outside the vault: it is large and Documents may sync to iCloud)."""
    tag = hashlib.sha256(str(Path(vault).expanduser().resolve()).encode()).hexdigest()[:12]
    return DAITO_SUPPORT / "cache" / model / tag


def row_key(vec_f32: bytes) -> bytes:
    """Cache key of a row: SHA-256 of its stored mean vector (128 float32, little-endian)."""
    return hashlib.sha256(vec_f32).digest()


def _post(url: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def embed_documents(texts: list[str], url: str, dims: int = 128, batch_size: int = 32, timeout: float = 600.0,
                    max_retries: int = 3) -> list[list[float]]:
    """Each text's mean token vector, after the service has stored its token vectors. Raises when the service is down,
    which the index builders turn into a keyword-only index (retried on the next run), as with Ollama."""
    out: list[list[float]] = []
    total = len(texts)
    batches = (total + batch_size - 1) // batch_size
    for i in range(0, total, batch_size):
        if batches > 1:
            print(f"  [pplx] batch {i // batch_size + 1}/{batches} ({min(i + batch_size, total)}/{total} texts)...",
                  flush=True)
        for attempt in range(max_retries + 1):
            try:
                res = _post(url.rstrip("/") + "/encode", {"texts": texts[i:i + batch_size]}, timeout)
                break
            except urllib.error.HTTPError:
                raise
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == max_retries:
                    raise
                time.sleep(0.5 * 2 ** attempt)
        vecs = res["vectors"]
        if len(vecs) != len(texts[i:i + batch_size]) or any(len(v) != dims for v in vecs):
            raise ValueError(f"pplx service returned {len(vecs)} vectors of {len(vecs[0]) if vecs else 0} dims; "
                             f"expected {len(texts[i:i + batch_size])} of {dims}")
        out.extend(vecs)
    return out


def health(url: str, timeout: float = 2.0) -> dict | None:
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/health", timeout=timeout) as r:
            return json.loads(r.read())
    except (OSError, ValueError):
        return None
