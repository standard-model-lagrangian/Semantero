"""Rebuild launcher-core/test/fixtures/notes_small/ (and a copy of the papers fixture) deterministically.

Runs notesindex over tests/fixtures/notes/vault_small with the hash-based fake embedder, dims 8, matching
tests/fixtures/search/index_small. Run from the repo root:  .venv/bin/python -m tests.fixtures.notes.make_notes_index
"""
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from planner import notesindex  # noqa: E402
from planner.config import Config  # noqa: E402

VAULT = ROOT / "tests/fixtures/notes/vault_small"
PAPERS = ROOT / "tests/fixtures/search/index_small"
OUT = ROOT / "launcher-core/test/fixtures/notes_small"
BASE_MTIME = 1792400000  # 2026-10-19; each file gets BASE + 3600 * its rank in sorted order
FAKE_VAULT = "/Users/test/Obsidian Vault"


def fake_embed(texts, **kwargs):
    dims = kwargs.get("dims", 8)
    out = []
    for text in texts:
        vec = [0.0] * dims
        for w in text.lower().split():
            vec[int(hashlib.md5(w.encode()).hexdigest(), 16) % dims] += 1.0
        if not any(vec):
            vec[0] = 1.0
        norm = math.sqrt(sum(x * x for x in vec))
        out.append([x / norm for x in vec])
    return out


def main():
    with tempfile.TemporaryDirectory() as tmp:
        vault = Path(tmp) / "Vault"
        shutil.copytree(VAULT, vault)
        for i, p in enumerate(sorted(p for p in vault.rglob("*.md"))):
            t = BASE_MTIME + 3600 * i
            os.utime(p, (t, t))
        data = vault / ".planner"
        (data / "search").mkdir(parents=True)
        for name in ("papers.json", "manifest.json"):
            shutil.copy(PAPERS / name, data / "search" / name)
        cfg = Config(
            vault=vault, daily_dir=vault, data_dir=data, models={}, extract={}, brief={},
            reviews_dir=vault / "Reviews", daily_template=vault / "Templates/Daily.md", schedule={}, threads={},
            search={"model": "qwen3-embedding:0.6b", "dims": 8,
                    "query_instruction": "Given a description of what a paper found or showed, retrieve that paper"},
            notes={"exclude": [*notesindex.DEFAULTS["exclude"], "Private/**"]},
        )
        notesindex.build_index(cfg, full=True, embed_fn=fake_embed)
        if OUT.exists():
            shutil.rmtree(OUT)
        shutil.copytree(data / "notes", OUT)
        (OUT / "state.json").unlink()
        m = json.loads((OUT / "manifest.json").read_text())
        m.update({"vault": FAKE_VAULT, "vault_name": "Obsidian Vault", "built_at": "2026-10-21T11:05"})
        (OUT / "manifest.json").write_text(json.dumps(m, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
