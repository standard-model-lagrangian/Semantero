import sys
import tomllib
from dataclasses import dataclass, field
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
    return Config(
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
    )
