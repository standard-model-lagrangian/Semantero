"""Parity check: the pplx service's own encoder (planner/pplxd.py) on the frozen llama.cpp runtime, against the
official sentence-transformers reference.

Starts the pinned llama-server exactly as the service does (`pplxd.Llama`), encodes the parity set with the service's
`pplxd.Encoder` (prefix token + the text's tokens, cut to the model's length, per-token hidden states -> proj.f32 ->
skiplist for documents -> L2 normalise), and compares with reference.json. Appends a table to PARITY.md in the model
folder and exits 1 if any check fails.

usage: python -I parity.py <llama-server> <model.gguf> <model_dir> <reference.json> <parity_texts.json>
"""
import json
import sys
import time
from pathlib import Path

import numpy as np

# Run with -I (no script folder on sys.path): the encoder under test is the service's, imported from this checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from planner.pplxd import Encoder, Llama  # noqa: E402


def kendall_tau(a: np.ndarray, b: np.ndarray) -> float:
    n, s = len(a), 0
    for i in range(n):
        for j in range(i + 1, n):
            s += np.sign(a[i] - a[j]) * np.sign(b[i] - b[j])
    return 2 * s / (n * (n - 1))


def maxsim(q: np.ndarray, d: np.ndarray) -> float:
    return float((q @ d.T).max(axis=1).sum()) if len(d) else 0.0


def compare(encoder: Encoder, texts: dict, ref: dict, q8: bool) -> tuple[list[tuple[str, str, bool]], list[str], int]:
    """(checks as (name, value, passed), problems found, tokens encoded). Compares only the token vectors the service
    keeps (documents drop skiplist tokens), which are the ones search uses."""
    problems: list[str] = []
    cos_all: list[float] = []
    pairs: dict[str, list] = {"documents": [], "queries": []}
    n_tok = 0
    for key, kind in (("documents", "document"), ("queries", "query")):
        ids_all = encoder.token_ids(texts[key], kind)
        for text, ids, v, r in zip(texts[key], ids_all, encoder.encode_ids(ids_all, kind), ref[key]):
            n_tok += len(ids)
            if ids != r["ids"]:
                problems.append(f"token mismatch ({kind}): {text[:60]!r}: {len(ids)} vs {len(r['ids'])} tokens")
                pairs[key].append(None)
                continue
            rv = np.asarray(r["vecs"], dtype=np.float32)[np.asarray(r["mask"])]
            rv = rv / np.maximum(np.linalg.norm(rv, axis=1, keepdims=True), 1e-12)
            if v.shape != rv.shape:
                problems.append(f"kept tokens differ ({kind}): {text[:60]!r}: {len(v)} vs {len(rv)}")
                pairs[key].append(None)
                continue
            cos_all.extend((v * rv).sum(axis=1).tolist())
            pairs[key].append((v, rv))

    cos = np.asarray(cos_all) if cos_all else np.zeros(1)
    docs = [d for d in pairs["documents"] if d is not None]
    taus, top1 = [], 0
    for q in pairs["queries"]:
        if q is None:
            continue
        ours = np.array([maxsim(q[0], d[0]) for d in docs])
        theirs = np.array([maxsim(q[1], d[1]) for d in docs])
        taus.append(kendall_tau(ours, theirs))
        top1 += int(ours.argmax() == theirs.argmax())
    nq, total = len(taus), len(ref["documents"]) + len(ref["queries"])
    mism = sum(p.startswith(("token mismatch", "kept tokens")) for p in problems)
    med_min, min_min = (0.995, 0.98) if q8 else (0.999, 0.99)
    worst_tau = min(taus) if taus else 0.0
    checks = [
        ("token ids identical", f"{total - mism}/{total}", mism == 0),
        (f"per-token cosine median (>= {med_min})", f"{np.median(cos):.5f}", bool(np.median(cos) >= med_min)),
        (f"per-token cosine min (>= {min_min})", f"{cos.min():.5f}", bool(cos.min() >= min_min)),
        ("MaxSim Kendall tau, worst query (>= 0.95)", f"{worst_tau:.4f}", worst_tau >= 0.95),
        ("same top-1 document (all but one query)", f"{top1}/{nq}", nq > 0 and top1 >= nq - 1),
    ]
    return checks, problems, n_tok


def main() -> int:
    server, gguf, model_dir, ref_path, texts_path = sys.argv[1:6]
    model_dir = Path(model_dir)
    head = json.loads((model_dir / "head.json").read_text())
    proj = np.frombuffer((model_dir / "proj.f32").read_bytes(), dtype="<f4").reshape(head["dims"], head["hidden"])
    llama = Llama(server, Path(gguf))
    try:
        t0 = time.time()
        checks, problems, n_tok = compare(Encoder(head, proj, llama), json.loads(Path(texts_path).read_text()),
                                          json.loads(Path(ref_path).read_text()), q8="q8" in Path(gguf).name)
        elapsed = time.time() - t0
    finally:
        llama.stop()
    ok = all(c[2] for c in checks)
    lines = [
        f"\n## {Path(gguf).name} ({time.strftime('%Y-%m-%d %H:%M')})\n",
        f"llama-server: `{server}`, started and driven by `planner.pplxd` (the service's settings)  \n"
        f"{n_tok} tokens in {elapsed:.1f}s\n",
        "| Check | Result | Pass |", "|---|---|---|",
        *[f"| {name} | {val} | {'yes' if passed else '**no**'} |" for name, val, passed in checks],
        *[f"- {p}" for p in problems[:10]],
        f"\n**{'PASS' if ok else 'FAIL'}**\n",
    ]
    with open(model_dir / "PARITY.md", "a") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
