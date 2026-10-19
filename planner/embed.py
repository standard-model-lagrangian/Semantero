import json
import math
import time
import urllib.error
import urllib.request


def embed(
    texts: list[str],
    model: str = "qwen3-embedding:0.6b",
    dims: int = 1024,
    batch_size: int = 32,
    keep_alive: str = "30m",
    ollama_url: str = "http://localhost:11434",
    max_retries: int = 3,
) -> list[list[float]]:
    """Embed texts using Ollama /api/embed endpoint with batching, truncation, and L2 normalization."""
    if not texts:
        return []

    url = f"{ollama_url.rstrip('/')}/api/embed"
    results: list[list[float]] = []

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
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
                with urllib.request.urlopen(req) as resp:
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
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                attempts += 1
                if attempts > max_retries:
                    raise
                time.sleep(0.1 * (2 ** (attempts - 1)))

        parsed = json.loads(raw_resp)
        embeddings = parsed.get("embeddings", [])
        for vec in embeddings:
            # Truncate to dims (Matryoshka)
            if len(vec) > dims:
                vec = vec[:dims]
            # L2 normalise
            norm = math.sqrt(sum(x * x for x in vec))
            if norm > 0:
                vec = [x / norm for x in vec]
            results.append(vec)

    return results
