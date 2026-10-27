"""Thread corrections from the weekly review, layered over raw extractions.

Sidecars keep the extractor's output untouched; fixes are applied when sidecars are read,
so they survive re-extraction and feed cleaned thread ids back to the nightly model.
"""
from pathlib import Path

from . import store
from .vault import sha

FILE = "thread_fixes.json"


def item_key(day: str, text: str) -> str:
    return f"{day}|{sha(text)}"


def load(data_dir: Path) -> dict:
    p = data_dir / FILE
    data = store.load_json(p, {})
    return {"aliases": data.get("aliases", {}), "items": data.get("items", {}), "log": data.get("log", [])}


def save(data_dir: Path, fixes: dict) -> None:
    store.write_json(data_dir / FILE, fixes)


def resolve(tid: str, aliases: dict) -> str:
    seen = set()
    while tid in aliases and tid not in seen:  # follow merge chains, stop on cycles
        seen.add(tid)
        tid = aliases[tid]
    return tid


def apply(side: dict, fixes: dict) -> dict:
    if not fixes["aliases"] and not fixes["items"]:
        return side
    items = []
    for it in side["items"]:
        tid = fixes["items"].get(item_key(side["date"], it["text"]), it["thread"])
        items.append({**it, "thread": resolve(tid, fixes["aliases"]) if tid else tid})
    return {**side, "items": items}
