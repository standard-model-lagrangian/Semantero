import tomllib
from dataclasses import dataclass
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


def load(path: Path = ROOT / "config.toml") -> Config:
    raw = tomllib.loads(path.read_text())
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
    )
