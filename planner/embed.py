import json
import math
import time
import urllib.error
import urllib.request


def service(backend: str) -> tuple[str, str]:
    """(name, how to start it) for an embedding backend ([search] backend), for messages to the owner."""
    if backend == "pplx":
        return "the pplx service", "bash pplx/install-service.sh"
    return "Ollama", "brew services start ollama"


def embed(
    texts: list[str],
    model: str = "qwen3-embedding:0.6b",
    dims: int = 1024,
    batch_size: int = 32,
    keep_alive: str = "5m",
    ollama_url: str = "http://localhost:11434",
    max_retries: int = 3,
    timeout: float = 120.0,
    backend: str = "ollama",
    pplx_url: str = "http://127.0.0.1:11435",
) -> list[list[float]]:
    """Embed texts using Ollama /api/embed endpoint with batching, truncation, and L2 normalization.
    backend "pplx" (the pplx-embed-v2-late profile) sends them to planner/pplxd.py instead; see planner/pplx.py."""
    if not texts:
        return []
    if backend == "pplx":
        from . import pplx
        return pplx.embed_documents(texts, pplx_url, dims=dims, batch_size=batch_size)

    url = f"{ollama_url.rstrip('/')}/api/embed"
    results: list[list[float]] = []
    total = len(texts)
    total_batches = (total + batch_size - 1) // batch_size

    for i in range(0, total, batch_size):
        batch = texts[i : i + batch_size]
        batch_idx = (i // batch_size) + 1
        if total_batches > 1:
            print(f"  [embed] batch {batch_idx}/{total_batches} ({min(i + batch_size, total)}/{total} texts)...", flush=True)

        payload = {
            "model": model,
            "input": batch,
            "keep_alive": keep_alive,
            "truncate": True,
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        attempts = 0
        raw_resp = None
        while True:
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw_resp = resp.read().decode("utf-8")
                break
            except urllib.error.HTTPError as e:
                # If 404 or model not found, don't retry, raise with helpful message
                err_body = ""
                try:
                    err_body = e.read().decode("utf-8")
                except Exception:
                    pass
                if e.code == 404 or "not found" in err_body.lower() or "not found" in str(e).lower():
                    raise RuntimeError(f"Ollama model '{model}' not found. Run: ollama pull {model}") from e
                raise
            except (urllib.error.URLError, TimeoutError, OSError):
                attempts += 1
                if attempts > max_retries:
                    raise
                time.sleep(0.1 * (2 ** (attempts - 1)))

        parsed = json.loads(raw_resp)
        embeddings = parsed.get("embeddings", [])
        for vec in embeddings:
            if len(vec) < dims:
                raise ValueError(
                    f"Model returned {len(vec)} dimensions, which is less than configured dims={dims}"
                )
            # Truncate to dims (Matryoshka)
            if len(vec) > dims:
                vec = vec[:dims]
            # L2 normalise
            norm = math.sqrt(sum(x * x for x in vec))
            if norm > 0:
                vec = [x / norm for x in vec]
            results.append(vec)

    return results
