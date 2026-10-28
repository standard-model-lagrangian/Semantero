"""What several test files need: a Config for a temp vault, and a deterministic fake embedder."""
import hashlib
import math
from pathlib import Path

from planner.config import Config


def make_cfg(vault: Path, data_dir: Path | None = None, notes: dict | None = None, **search) -> Config:
    """A Config whose vault (and daily folder) is `vault`; keyword arguments become [search] settings, everything else
    keeps its default (config.SearchSettings)."""
    return Config(vault=vault, daily_dir=vault, data_dir=data_dir or vault / ".planner", search=dict(search),
                  notes=notes or {})


def fake_embed(texts: list[str], dims: int = 8, **_) -> list[list[float]]:
    """One unit vector per text: each word adds 1 at md5(word) mod dims, so texts sharing words score high together."""
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
