"""Parity check: the frozen llama.cpp runtime against the official sentence-transformers reference.

Starts the pinned llama-server on a GGUF, encodes the parity set the way planner/pplx.py does (prefix token id + the
text's tokens, per-token hidden states -> proj.f32 -> skiplist for documents -> L2 normalise), and compares with
reference.json. Appends a table to PARITY.md in the model folder and exits 1 if any check fails.

usage: python -I parity.py <llama-server> <model.gguf> <model_dir> <reference.json> <parity_texts.json>
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def post(url: str, body: dict, timeout: float = 600) -> object:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def kendall_tau(a: np.ndarray, b: np.ndarray) -> float:
    n, s = len(a), 0
    for i in range(n):
        for j in range(i + 1, n):
            s += np.sign(a[i] - a[j]) * np.sign(b[i] - b[j])
    return 2 * s / (n * (n - 1))


def maxsim(q: np.ndarray, d: np.ndarray) -> float:
    return float((q @ d.T).max(axis=1).sum()) if len(d) else 0.0


def main() -> int:
    server, gguf, model_dir, ref_path, texts_path = sys.argv[1:6]
    model_dir = Path(model_dir)
    head = json.loads((model_dir / "head.json").read_text())
    proj = np.frombuffer((model_dir / "proj.f32").read_bytes(), dtype="<f4").reshape(head["dims"], head["hidden"])
    skip = set(head["skiplist_ids"])
    ref = json.loads(Path(ref_path).read_text())
    texts = json.loads(Path(texts_path).read_text())

    port = free_port()
    proc = subprocess.Popen(
        [server, "-m", gguf, "--embedding", "--pooling", "none", "--host", "127.0.0.1", "--port", str(port),
         "-c", "8192", "-b", "8192", "-ub", "8192", "-np", "1", "--log-disable"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(600):
            try:
                with urllib.request.urlopen(base + "/health", timeout=1) as r:
                    if r.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise SystemExit("llama-server did not start")

        def encode(text: str, kind: str):
            prefix = head["document_prefix_id"] if kind == "document" else head["query_prefix_id"]
            ids = post(base + "/tokenize", {"content": text, "add_special": False, "parse_special": True})["tokens"] if text else []
            ids = [prefix] + ids
            out = post(base + "/embeddings", {"content": ids})
            hidden = np.asarray(out[0]["embedding"], dtype=np.float32)
            v = hidden @ proj.T
            keep = np.array([not (kind == "document" and i in skip) for i in ids])
            v = v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)
            return ids, keep, v

        rows, cos_all = [], []
        mism = 0
        enc = {"documents": [], "queries": []}
        t0 = time.time()
        n_tok = 0
        for kind_key, kind in (("documents", "document"), ("queries", "query")):
            for text, r in zip(texts[kind_key], ref[kind_key]):
                ids, keep, v = encode(text, kind)
                n_tok += len(ids)
                if ids != r["ids"]:
                    mism += 1
                    rows.append(f"token mismatch ({kind}): {text[:60]!r}: {len(ids)} vs {len(r['ids'])} tokens")
                    enc[kind_key].append(None)
                    continue
                rv = np.asarray(r["vecs"], dtype=np.float32)
                rv = rv / np.maximum(np.linalg.norm(rv, axis=1, keepdims=True), 1e-12)
                c = (v * rv).sum(axis=1)
                cos_all.extend(c.tolist())
                assert list(keep) == r["mask"], "mask differs"
                enc[kind_key].append((v[keep], rv[np.asarray(r["mask"])]))
        elapsed = time.time() - t0

        cos = np.asarray(cos_all)
        taus, top1 = [], 0
        docs = [d for d in enc["documents"] if d is not None]
        for q in enc["queries"]:
            if q is None:
                continue
            ours = np.array([maxsim(q[0], d[0]) for d in docs])
            theirs = np.array([maxsim(q[1], d[1]) for d in docs])
            taus.append(kendall_tau(ours, theirs))
            top1 += int(ours.argmax() == theirs.argmax())
        nq = len(taus)
        q8 = "q8" in Path(gguf).name
        med_min, min_min = (0.995, 0.98) if q8 else (0.999, 0.99)
        checks = [
            ("token ids identical", f"{len(ref['documents']) + len(ref['queries']) - mism}/{len(ref['documents']) + len(ref['queries'])}", mism == 0),
            (f"per-token cosine median (>= {med_min})", f"{np.median(cos):.5f}", np.median(cos) >= med_min),
            (f"per-token cosine min (>= {min_min})", f"{cos.min():.5f}", cos.min() >= min_min),
            ("MaxSim Kendall tau, worst query (>= 0.95)", f"{min(taus):.4f}", min(taus) >= 0.95),
            ("same top-1 document (>= 19/20)", f"{top1}/{nq}", top1 >= nq - 1),
        ]
        ok = all(c[2] for c in checks)
        lines = [
            f"\n## {Path(gguf).name} ({time.strftime('%Y-%m-%d %H:%M')})\n",
            f"llama-server: `{server}`  \n{len(cos)} token vectors compared, {n_tok} tokens in {elapsed:.1f}s "
            f"({n_tok / elapsed:.0f} tok/s, one input per request, JSON)\n",
            "| Check | Result | Pass |", "|---|---|---|",
            *[f"| {name} | {val} | {'yes' if passed else '**no**'} |" for name, val, passed in checks],
            *[f"- {r}" for r in rows[:10]],
            f"\n**{'PASS' if ok else 'FAIL'}**\n",
        ]
        with open(model_dir / "PARITY.md", "a") as f:
            f.write("\n".join(lines) + "\n")
        print("\n".join(lines))
        return 0 if ok else 1
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    sys.exit(main())
