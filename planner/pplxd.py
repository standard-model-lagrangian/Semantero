"""pplxd: the local service behind the pplx-embed-v2-late profile. Needs numpy; runs from its own small venv
(`make pplx-setup`, launchd job com.planner.pplxd). See planner/pplx.py for how late interaction fits the index.

  POST /encode     {"texts": [...]}                       documents, from the index builders: stores every text's token
                                                          vectors in the cache, returns {"vectors": [mean vector, ...]}
  POST /rowscores  {"text": "...", "corpora": ["search", "notes"]}
                   -> {"corpora": {"search": {"content_hash": ..., "rows": n, "scores": base64 float32[n]}, ...}}
                   one MaxSim score per row of each live index, divided by the number of query tokens (the mean best
                   cosine, so scores sit on a cosine-like scale; ranking is unchanged); rows without token vectors score 0
  POST /warm       starts llama-server and loads the model (the plugin and the app call it when their search opens)
  GET  /health

Encoding runs the frozen GGUF on the pinned llama-server (pplx/convert/convert.sh made both and checked them against the
official sentence-transformers output: PARITY.md). llama.cpp returns the final hidden state of every token; this file
applies the rest of the model's pipeline: the Dense projection (proj.f32), the punctuation skiplist for documents and
L2 normalisation. llama-server is started on demand and unloads the model after 5 idle minutes by itself.
"""
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

from . import config
from .pplx import cache_dir, model_dir, row_key

DIMS = 128
UBATCH = 2048          # longest input in one pass (non-causal attention needs the whole input in one micro-batch); our
                       # chunks are ~300-500 tokens, so this cap (the model allows 4096 for documents) never bites
IDLE_SECONDS = 300     # llama-server unloads the model after this long without a request
BLOCK_TOKENS = 1 << 16  # MaxSim block: fp16 -> fp32 conversion and matmul stay in cache
WORKERS = 4


def log(msg: str) -> None:
    print(f"{time.strftime('%F %T')} pplxd: {msg}", flush=True)


def verify(mdir: Path) -> dict:
    """runtime.json, after checking every file listed in SHA256SUMS. Refuses to run on anything else."""
    runtime = json.loads((mdir / "runtime.json").read_text())
    for line in (mdir / "SHA256SUMS").read_text().splitlines():
        want, name = line.split(None, 1)
        path = Path(runtime["llama_server"]) if name == "llama-server" else mdir / name
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 22), b""):
                h.update(block)
        if h.hexdigest() != want:
            raise SystemExit(f"{path} does not match SHA256SUMS: re-run pplx/fetch.sh")
    return runtime


class Llama:
    """The pinned llama-server, started on first use and restarted if it died."""

    def __init__(self, server: str, gguf: Path):
        self.server, self.gguf = server, gguf
        self.proc: subprocess.Popen | None = None
        self.base = ""
        self.lock = threading.Lock()

    def ensure(self) -> None:
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                port = s.getsockname()[1]
            self.proc = subprocess.Popen(
                [self.server, "-m", str(self.gguf), "--embedding", "--pooling", "none", "--host", "127.0.0.1",
                 "--port", str(port), "-c", str(UBATCH), "-b", str(UBATCH), "-ub", str(UBATCH), "-np", "1",
                 "--sleep-idle-seconds", str(IDLE_SECONDS), "--log-disable"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.base = f"http://127.0.0.1:{port}"
            for _ in range(600):
                try:
                    with urllib.request.urlopen(self.base + "/health", timeout=1) as r:
                        if r.status == 200:
                            log(f"llama-server ready on {port} (pid {self.proc.pid})")
                            return
                except OSError:
                    if self.proc.poll() is not None:
                        break
                    time.sleep(0.1)
            raise RuntimeError("llama-server did not start")

    def _post(self, path: str, body: dict):
        self.ensure()
        req = urllib.request.Request(self.base + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read())

    def tokenize(self, text: str) -> list[int]:
        if not text:
            return []
        return self._post("/tokenize", {"content": text, "add_special": False, "parse_special": True})["tokens"]

    def hidden(self, id_lists: list[list[int]]) -> list[np.ndarray]:
        out = self._post("/embeddings", {"content": id_lists})
        out.sort(key=lambda r: r["index"])
        return [np.asarray(r["embedding"], dtype=np.float32) for r in out]

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=10)


class Encoder:
    """Token ids -> llama.cpp hidden states -> Dense -> skiplist (documents) -> L2 normalise; as in modules.json."""

    def __init__(self, head: dict, proj: np.ndarray, llama):
        self.head, self.proj, self.llama = head, proj, llama
        self.skip = np.asarray(head["skiplist_ids"], dtype=np.int64)

    def encode(self, texts: list[str], kind: str) -> list[np.ndarray]:
        doc = kind == "document"
        prefix = self.head["document_prefix_id" if doc else "query_prefix_id"]
        limit = min(self.head["document_length" if doc else "query_length"], UBATCH) - 1
        ids = [[prefix] + self.llama.tokenize(t)[:limit] for t in texts]
        out = []
        for i, h in zip(ids, self.llama.hidden(ids)):
            v = h @ self.proj.T
            if doc and "document" in self.head["skiplist_tasks"]:
                v = v[~np.isin(np.asarray(i), self.skip)]
            v /= np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)
            out.append(v.astype(np.float32))
        return out


def mean_vector(tokens: np.ndarray) -> np.ndarray:
    m = tokens.mean(axis=0, dtype=np.float32)
    return (m / max(float(np.linalg.norm(m)), 1e-12)).astype(np.float32)


REC = struct.Struct("<32sQI4x")  # key, first token, token count


class TokenCache:
    """Append-only store of every encoded text's token vectors (fp16). One segment per text, in the order added; keys.bin
    maps each segment's key (planner.pplx.row_key of its mean vector) to its tokens. Tokens are written and synced before
    their key, so a crash leaves at most unreferenced tokens, which the next open trims."""

    def __init__(self, d: Path, dims: int | None = None):
        d.mkdir(parents=True, exist_ok=True)
        dims = dims or DIMS
        self.dims, self.tok_path, self.key_path = dims, d / "tokens.f16", d / "keys.bin"
        self.lock = threading.Lock()
        self.index: dict[bytes, int] = {}
        self.starts: list[int] = []
        self.counts: list[int] = []
        raw = self.key_path.read_bytes() if self.key_path.exists() else b""
        whole = len(raw) // REC.size * REC.size
        if whole != len(raw):
            with open(self.key_path, "r+b") as f:
                f.truncate(whole)
        for key, start, count in REC.iter_unpack(raw[:whole]):
            self.index[key] = len(self.starts)
            self.starts.append(start)
            self.counts.append(count)
        self.end = self.starts[-1] + self.counts[-1] if self.starts else 0
        nbytes = self.end * dims * 2
        self.tok_path.touch()
        if self.tok_path.stat().st_size < nbytes:
            raise SystemExit(f"{self.tok_path} is shorter than keys.bin says: delete {d} and rebuild the pplx profile")
        if self.tok_path.stat().st_size > nbytes:
            with open(self.tok_path, "r+b") as f:
                f.truncate(nbytes)
        self._view = None

    def __len__(self) -> int:
        return len(self.starts)

    def add(self, key: bytes, tokens: np.ndarray) -> None:
        with self.lock:
            if key in self.index:
                return
            with open(self.tok_path, "ab") as f:
                f.write(tokens.astype("<f2").tobytes())
                f.flush()
                os.fsync(f.fileno())
            with open(self.key_path, "ab") as f:
                f.write(REC.pack(key, self.end, len(tokens)))
                f.flush()
                os.fsync(f.fileno())
            self.index[key] = len(self.starts)
            self.starts.append(self.end)
            self.counts.append(len(tokens))
            self.end += len(tokens)
            self._view = None

    def view(self):
        """(tokens memmap, starts, counts, blocks) for scoring; blocks are segment ranges of ~BLOCK_TOKENS tokens."""
        with self.lock:
            if self._view is None:
                starts = np.asarray(self.starts, dtype=np.int64)
                counts = np.asarray(self.counts, dtype=np.int64)
                toks = (np.memmap(self.tok_path, dtype="<f2", mode="r", shape=(self.end, self.dims))
                        if self.end else np.zeros((0, self.dims), "<f2"))
                blocks, lo = [], 0
                while lo < len(starts):
                    hi = int(np.searchsorted(starts, starts[lo] + BLOCK_TOKENS, side="left"))
                    hi = max(hi, lo + 1)
                    blocks.append((lo, hi))
                    lo = hi
                self._view = (toks, starts, counts, blocks)
            return self._view


def maxsim_segments(view, q: np.ndarray, pool: ThreadPoolExecutor | None = None) -> np.ndarray:
    """MaxSim of query tokens q (n_q x 128) against every segment of the cache: for each query token its best dot
    product with the segment's tokens, summed over query tokens."""
    toks, starts, counts, blocks = view
    out = np.zeros(len(starts), dtype=np.float32)
    qt = np.ascontiguousarray(q.T, dtype=np.float32)

    def run(lo_hi):
        lo, hi = lo_hi
        a, b = int(starts[lo]), int(starts[hi - 1] + counts[hi - 1])
        s = np.asarray(toks[a:b], dtype=np.float32) @ qt
        out[lo:hi] = np.maximum.reduceat(s, starts[lo:hi] - a, axis=0).sum(axis=1)

    if pool is None:
        for blk in blocks:
            run(blk)
    else:
        list(pool.map(run, blocks))
    return out


class Corpus:
    """Row -> cache segment for one live index folder, rebuilt when its manifest or vectors change."""

    def __init__(self, d: Path, model: str):
        self.dir, self.model = d, model
        self.sig = None
        self.seg: np.ndarray | None = None
        self.content_hash: str | None = None
        self.missing = 0
        self.reason = "not loaded"

    def refresh(self, cache: TokenCache) -> None:
        mf, vf = self.dir / "manifest.json", self.dir / "vectors.f32"
        try:
            sig = (mf.stat().st_mtime_ns, vf.stat().st_mtime_ns, vf.stat().st_size, len(cache))
        except OSError:
            self.sig, self.seg, self.reason = None, None, "no index"
            return
        if sig == self.sig:
            return
        manifest = json.loads(mf.read_text())
        self.sig = sig
        if manifest.get("model") != self.model or int(manifest.get("dims", 0)) != DIMS:
            self.seg, self.reason = None, f"the live index is {manifest.get('model')}, not {self.model}"
            return
        vecs = np.fromfile(vf, dtype="<f4").reshape(-1, DIMS)
        seg = np.full(len(vecs), -1, dtype=np.int64)
        for r in range(len(vecs)):
            seg[r] = cache.index.get(row_key(vecs[r].tobytes()), -1)
        self.seg, self.content_hash, self.missing, self.reason = seg, manifest.get("content_hash"), int((seg < 0).sum()), ""
        if self.missing:
            log(f"{self.dir.name}: {self.missing} of {len(seg)} rows have no token vectors (they score 0); "
                f"rebuild: planner profile build pplx-v2-late --full")


class Service:
    def __init__(self, cfg, model: str, llama=None, encoder=None):
        mdir = model_dir(model)
        self.model = model
        if encoder is None:
            runtime = verify(mdir)
            head = json.loads((mdir / "head.json").read_text())
            proj = np.frombuffer((mdir / "proj.f32").read_bytes(), dtype="<f4").reshape(head["dims"], head["hidden"])
            llama = Llama(runtime["llama_server"], mdir / runtime["gguf"])
            encoder = Encoder(head, proj, llama)
        self.llama, self.encoder = llama, encoder
        self.cache = TokenCache(cache_dir(model, cfg.vault))
        self.corpora = {c: Corpus(cfg.data_dir / c, model) for c in ("search", "notes")}
        self.pool = ThreadPoolExecutor(WORKERS)
        self.refresh_lock = threading.Lock()

    def encode_documents(self, texts: list[str]) -> list[list[float]]:
        out = []
        for toks in self.encoder.encode(texts, "document"):
            m = mean_vector(toks)
            self.cache.add(row_key(m.tobytes()), toks)
            out.append(m.tolist())
        return out

    def rowscores(self, text: str, corpora: list[str]) -> dict:
        t0 = time.perf_counter()
        q = self.encoder.encode([text], "query")[0]
        t1 = time.perf_counter()
        with self.refresh_lock:
            for c in corpora:
                if c in self.corpora:
                    self.corpora[c].refresh(self.cache)
        seg_scores = maxsim_segments(self.cache.view(), q, self.pool) / len(q)
        res = {}
        for c in corpora:
            corp = self.corpora.get(c)
            if corp is None or corp.seg is None:
                res[c] = {"error": corp.reason if corp else "unknown corpus"}
                continue
            s = np.where(corp.seg >= 0, seg_scores[np.maximum(corp.seg, 0)], 0).astype("<f4")
            res[c] = {"content_hash": corp.content_hash, "rows": len(s), "missing": corp.missing,
                      "scores": base64.b64encode(s.tobytes()).decode()}
        t2 = time.perf_counter()
        return {"model": self.model, "query_tokens": len(q), "corpora": res,
                "timings_ms": {"encode": round((t1 - t0) * 1000, 1), "maxsim": round((t2 - t1) * 1000, 1)}}

    def health(self) -> dict:
        return {"ok": True, "model": self.model, "segments": len(self.cache), "tokens": self.cache.end,
                "llama": bool(self.llama and getattr(self.llama, "proc", None) and self.llama.proc.poll() is None),
                "corpora": {c: {"content_hash": k.content_hash, "missing": k.missing, "reason": k.reason}
                            for c, k in self.corpora.items()}}


def make_handler(svc: Service):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code: int, obj: dict) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, svc.health())
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            try:
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path == "/encode":
                    self._send(200, {"vectors": svc.encode_documents([str(t) for t in body["texts"]])})
                elif self.path == "/rowscores":
                    self._send(200, svc.rowscores(str(body["text"]), list(body.get("corpora", ["search", "notes"]))))
                elif self.path == "/warm":
                    svc.encoder.encode(["warm"], "query")
                    self._send(200, {"ok": True})
                else:
                    self._send(404, {"error": "not found"})
            except Exception as e:  # noqa: BLE001 - the client gets the reason; the service keeps running
                log(f"{self.path}: {type(e).__name__}: {e}")
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def pplx_profile(cfg) -> dict:
    if cfg.search.get("backend") == "pplx":
        return cfg.search
    for entry in config.load_profiles(cfg.profiles_path).values():
        if entry.get("backend") == "pplx":
            return entry
    raise SystemExit("no pplx profile in profiles.toml")


def main() -> None:
    cfg = config.load()
    prof = pplx_profile(cfg)
    url = urlparse(prof.get("pplx_url", "http://127.0.0.1:11435"))
    svc = Service(cfg, prof["model"])
    server = ThreadingHTTPServer((url.hostname or "127.0.0.1", url.port or 11435), make_handler(svc))
    log(f"serving {prof['model']} on {url.hostname}:{url.port}; cache {len(svc.cache)} texts, {svc.cache.end} tokens")
    try:
        server.serve_forever()
    finally:
        svc.llama.stop()


if __name__ == "__main__":
    sys.exit(main())
