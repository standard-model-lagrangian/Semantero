"""Embedding profiles: one search + notes index per embedding model, so models can be tried in the real plugin and app.

The live index is always `<data_dir>/search` and `<data_dir>/notes`; that is what Obsidian, Daito Search, the watcher
and the 5-minute tick read and update. Other profiles wait in `<data_dir>/profiles/<name>/{search,notes}`.
`use` swaps folders (two renames per corpus, under both index locks) and records the name in `<data_dir>/profile.json`,
which `config.load` turns into [search] overrides from profiles.toml. Nothing is re-embedded by a switch.
"""
import copy
import json
from pathlib import Path

from . import config
from .searchindex import named_lock

CORPORA = ("search", "notes")
LOCKS = {"search": "search.lock", "notes": "notes.lock"}


class ProfileError(Exception):
    pass


def _profiles(cfg) -> dict[str, dict]:
    return config.load_profiles(cfg.profiles_path)


def settings_of(entry: dict) -> dict:
    return {k: v for k, v in entry.items() if k not in config.PROFILE_META}


def active_name(cfg) -> str:
    try:
        name = json.loads((cfg.data_dir / "profile.json").read_text())["name"]
        if name in _profiles(cfg):
            return name
    except (OSError, ValueError, KeyError, TypeError):
        pass
    for name, entry in _profiles(cfg).items():
        if entry.get("model") == cfg.search.get("model") and int(entry.get("dims", 0)) == int(cfg.search.get("dims", 0)):
            return name
    return "custom"


def profile_cfg(cfg, name: str):
    """A Config whose [search] is the profile's and whose data_dir is where that profile's index lives."""
    entries = _profiles(cfg)
    if name not in entries:
        raise KeyError(f"no profile {name!r} in profiles.toml (have: {', '.join(entries)})")
    pc = copy.copy(cfg)
    pc.search = {**cfg.search, **settings_of(entries[name])}
    if name != active_name(cfg):
        pc.data_dir = cfg.data_dir / "profiles" / name
    return pc


def _manifest(d: Path) -> dict | None:
    try:
        return json.loads((d / "manifest.json").read_text())
    except (OSError, ValueError):
        return None


def use(cfg, name: str) -> str:
    entries = _profiles(cfg)
    if name not in entries:
        raise ProfileError(f"no profile {name!r} in profiles.toml (have: {', '.join(entries)})")
    current = active_name(cfg)
    if current == name:
        return f"{name} is already the live index"
    live = cfg.data_dir
    stash_new = live / "profiles" / name
    want = settings_of(entries[name])
    m = _manifest(stash_new / "search")
    if m is None:
        raise ProfileError(f"{name} has no index yet. Run: planner profile build {name}")
    if m.get("model") != want.get("model") or int(m.get("dims", 0)) != int(want.get("dims", 0)):
        raise ProfileError(f"{stash_new / 'search'} was built with {m.get('model')}/{m.get('dims')}, not "
                           f"{want.get('model')}/{want.get('dims')}. Run: planner profile build {name} --full")
    stash_old = live / "profiles" / current
    with named_lock(cfg, LOCKS["search"], timeout=300), named_lock(cfg, LOCKS["notes"], timeout=300):
        for corpus in CORPORA:
            if (stash_old / corpus).exists():
                raise ProfileError(f"{stash_old / corpus} already exists; move it aside first")
        stash_old.mkdir(parents=True, exist_ok=True)
        for corpus in CORPORA:
            if (live / corpus).exists():
                (live / corpus).rename(stash_old / corpus)
            if (stash_new / corpus).exists():
                (stash_new / corpus).rename(live / corpus)
        tmp = live / "profile.json.tmp"
        tmp.write_text(json.dumps({"name": name}) + "\n")
        tmp.replace(live / "profile.json")
        try:
            stash_new.rmdir()
        except OSError:
            pass
    return f"live index is now {name} ({want.get('model')}, {want.get('dims')} dims); {current} kept in {stash_old}"


def status(cfg) -> list[dict]:
    active = active_name(cfg)
    rows = []
    for name, entry in _profiles(cfg).items():
        base = cfg.data_dir if name == active else cfg.data_dir / "profiles" / name
        built, info = {}, {}
        for corpus in CORPORA:
            m = _manifest(base / corpus)
            built[corpus] = bool(m and m.get("model") == entry.get("model"))
            if m:
                size = sum(f.stat().st_size for f in (base / corpus).iterdir() if f.is_file())
                info[corpus] = {"built_at": m.get("built_at"), "rows": m.get("papers") or m.get("notes"),
                                "missing_vectors": m.get("missing_vectors", 0), "mb": round(size / 1e6)}
        rows.append({"name": name, "label": entry.get("label", name), "active": name == active, "dir": str(base),
                     "built": built, "info": info, **settings_of(entry)})
    return rows
