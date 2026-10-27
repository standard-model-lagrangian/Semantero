import json
import sys
import tomllib
from dataclasses import dataclass, field, fields, replace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Config:
    vault: Path
    daily_dir: Path
    data_dir: Path
    models: dict
    extract: dict
    brief: dict
    reviews_dir: Path
    daily_template: Path
    schedule: dict
    threads: dict
    search: dict = field(default_factory=dict)
    notes: dict = field(default_factory=dict)
    profiles_path: Path = ROOT / "profiles.toml"   # embedding profiles (planner/profiles.py), next to config.toml


@dataclass(frozen=True)
class SearchSettings:
    """[search] with its defaults filled in: what the index builders, the watcher and the health checks read. The one
    place the defaults live (config.toml ships the same values; a profile in profiles.toml overrides them)."""
    zotero_dir: Path = Path("~/Zotero")
    model: str = "qwen3-embedding:0.6b"
    dims: int = 1024                  # Matryoshka-style truncation, then re-normalise
    query_instruction: str = "Given a description of what a paper found or showed, retrieve that paper"
    chunk_words: int = 300
    chunk_overlap_words: int = 50
    max_chunks_per_paper: int = 150
    batch_size: int = 32
    keep_alive: str = "5m"            # Ollama unloads the model this long after the last embedding
    backend: str = "ollama"           # "pplx": the pplx-embed-v2-late profile (planner/pplx.py, planner/pplxd.py)
    ollama_url: str = "http://localhost:11434"
    pplx_url: str = "http://127.0.0.1:11435"

    @classmethod
    def of(cls, cfg: "Config") -> "SearchSettings":
        given = {f.name: cfg.search[f.name] for f in fields(cls) if f.name in cfg.search}
        s = cls(**given)
        ints = {n: int(getattr(s, n)) for n in ("dims", "chunk_words", "chunk_overlap_words", "max_chunks_per_paper",
                                                 "batch_size")}
        return replace(s, **ints, zotero_dir=Path(s.zotero_dir).expanduser())

    def embed_kwargs(self) -> dict:
        """The keyword arguments embed.embed needs to reach this profile's model."""
        return {"model": self.model, "dims": self.dims, "batch_size": self.batch_size, "keep_alive": self.keep_alive,
                "ollama_url": self.ollama_url, "backend": self.backend, "pplx_url": self.pplx_url}


def load(path: Path = ROOT / "config.toml") -> Config:
    raw = tomllib.loads(path.read_text())
    local_path = path.parent / "config.local.toml"
    if local_path.exists():
        try:
            local_raw = tomllib.loads(local_path.read_text())
            for k, v in local_raw.items():
                if isinstance(v, dict) and isinstance(raw.get(k), dict):
                    raw[k].update(v)
                else:
                    raw[k] = v
        except Exception as e:
            print(f"config.local.toml ignored ({e}); using config.toml paths", file=sys.stderr)
    vault = Path(raw["vault"]).expanduser()
    cfg = Config(
        vault=vault,
        daily_dir=vault / raw.get("daily_folder", ""),
        data_dir=vault / raw.get("data_dir", ".planner"),
        models=raw["models"],
        extract=raw.get("extract", {}),
        brief=raw.get("brief", {}),
        reviews_dir=vault / raw.get("reviews_folder", "Reviews"),
        daily_template=vault / raw.get("daily_template", "Templates/Daily.md"),
        schedule=raw.get("schedule", {}),
        threads=raw.get("threads", {}),
        search=raw.get("search", {}),
        notes=raw.get("notes", {}),
        profiles_path=path.parent / "profiles.toml",
    )
    cfg.search.update(active_profile_overrides(cfg.data_dir, cfg.profiles_path))
    return cfg


# Keys of a profiles.toml entry that describe it rather than configure [search].
PROFILE_META = ("label", "notes")


def load_profiles(path: Path = ROOT / "profiles.toml") -> dict[str, dict]:
    return tomllib.loads(path.read_text()) if path.exists() else {}


def active_profile_overrides(data_dir: Path, profiles_path: Path) -> dict:
    """[search] settings of the embedding profile recorded in <data_dir>/profile.json (`planner profile use`), if any.
    The live index in <data_dir>/search and /notes was built with them, so every reader and writer must use them."""
    try:
        name = json.loads((data_dir / "profile.json").read_text())["name"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    entry = load_profiles(profiles_path).get(name)
    if not isinstance(entry, dict):
        print(f"profile {name!r} is not in {profiles_path.name}; using config.toml [search]", file=sys.stderr)
        return {}
    return {k: v for k, v in entry.items() if k not in PROFILE_META}
