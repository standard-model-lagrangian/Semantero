from datetime import date, timedelta

MAX_TEXTS = 2


def active(registry: dict, as_of: date, window_days: int) -> list[dict]:
    """Threads seen within the window before as_of, most recent first."""
    cutoff = (as_of - timedelta(days=window_days)).isoformat()
    out = [
        {"id": tid, **t}
        for tid, t in registry.items()
        if cutoff <= t["last_seen"] < as_of.isoformat()
    ]
    return sorted(out, key=lambda t: t["last_seen"], reverse=True)


def merge(registry: dict, sidecar: dict) -> None:
    day = sidecar["date"]
    for it in sidecar["items"]:
        tid = it["thread"]
        if not tid:
            continue
        t = registry.setdefault(tid, {"first_seen": day, "last_seen": day, "type": it["type"], "recent_texts": []})
        t["last_seen"] = max(t["last_seen"], day)
        if it["kind"] == "task":
            t["type"] = it["type"]
        t["recent_texts"] = ([it["text"]] + [x for x in t["recent_texts"] if x != it["text"]])[:MAX_TEXTS]
