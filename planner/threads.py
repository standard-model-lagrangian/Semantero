from datetime import date, timedelta
import re
from collections import Counter, defaultdict

MAX_TEXTS = 2
START = "%% planner:threads:start %%"
END = "%% planner:threads:end %%"
BLOCK_RE = re.compile(re.escape(START) + r".*?" + re.escape(END) + r"\n?", re.S)
MARK = {"done": "✓", "partial": "~", "skipped": "✗", "unknown": "·"}


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


def _day(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d:%a} {d.day} {d:%b}"


def render_dashboard(sides: list[dict], today: date, cfg) -> str:
    sched_threads = getattr(cfg, "threads", {}) if hasattr(cfg, "threads") else {}
    active_days = sched_threads.get("active_days", 14)
    quiet_days = sched_threads.get("quiet_days", 60)
    lines_per_thread = sched_threads.get("lines_per_thread", 6)

    active_cutoff = (today - timedelta(days=active_days)).isoformat()
    quiet_cutoff = (today - timedelta(days=quiet_days)).isoformat()

    thread_days = defaultdict(set)
    thread_items = defaultdict(list)
    thread_type = {}
    thread_status = defaultdict(Counter)

    for s in sides:
        d = s["date"]
        for it in s["items"]:
            tid = it.get("thread")
            if not tid or it.get("type") not in ("A", "B", "C"):
                continue
            thread_days[tid].add(d)
            thread_items[tid].append((d, it))
            thread_type[tid] = it.get("type")
            if it.get("kind") == "task":
                thread_status[tid][it.get("status", "unknown")] += 1

    multi_threads = []
    single_threads = []

    for tid, days in thread_days.items():
        last_seen = max(days)
        if len(days) >= 2:
            if last_seen >= quiet_cutoff:
                multi_threads.append((tid, last_seen, days))
        else:
            if last_seen >= quiet_cutoff:
                single_threads.append((tid, last_seen, list(days)[0]))

    multi_threads.sort(key=lambda t: (t[1], t[0]), reverse=True)
    single_threads.sort(key=lambda t: (t[1], t[0]), reverse=True)

    active_list = [t for t in multi_threads if t[1] >= active_cutoff]
    quiet_list = [t for t in multi_threads if t[1] < active_cutoff]

    lines = [
        START,
        f"*Regenerated each morning by planner ({_day(today.isoformat())}). Write anything you like outside the markers.*",
        "",
        f"## Active (seen in the last {active_days} days)",
    ]

    def _render_thread_block(tid: str, last_seen: str, days: set[str]) -> list[str]:
        t_type = thread_type.get(tid, "A")
        st = thread_status[tid]
        counts = f"✓{st['done']} ~{st['partial']} ·{st['unknown'] + st['skipped']}"
        t_lines = [f"### {tid} · {t_type} · {len(days)} notes · last {_day(last_seen)} · {counts}"]
        
        by_date = defaultdict(list)
        for d, it in thread_items[tid]:
            by_date[d].append(it)
            
        count_lines = 0
        for d in sorted(by_date.keys(), reverse=True):
            if count_lines >= lines_per_thread:
                break
            day_items = by_date[d]
            tasks = [it for it in day_items if it.get("kind") == "task"]
            if tasks:
                first = tasks[0]
                mark = MARK.get(first.get("status"), "·")
                extra = len(day_items) - 1
                suffix = f" (+{extra})" if extra > 0 else ""
                t_lines.append(f"- [[{d}]] {mark} {first['text']}{suffix}")
            else:
                first = day_items[0]
                extra = len(day_items) - 1
                suffix = f" (+{extra})" if extra > 0 else ""
                t_lines.append(f"- [[{d}]] note: {first['text']}{suffix}")
            count_lines += 1
        t_lines.append("")
        return t_lines

    if active_list:
        for tid, last_seen, days in active_list:
            lines.extend(_render_thread_block(tid, last_seen, days))
    else:
        lines.append("(none)\n")

    lines.append(f"## Quiet ({active_days + 1}–{quiet_days} days)")
    if quiet_list:
        for tid, last_seen, days in quiet_list:
            lines.extend(_render_thread_block(tid, last_seen, days))
    else:
        lines.append("(none)\n")

    lines.append(f"> [!info]- Mentioned once ({len(single_threads)})")
    for tid, _, d in single_threads:
        first_it = thread_items[tid][0][1]
        lines.append(f"> - [[{d}]] {tid} · {first_it['text']}")

    lines.append(END)
    return "\n".join(lines) + "\n"


def upsert_threads(current_text: str | None, block: str) -> str | None:
    if current_text is None:
        return block
    if BLOCK_RE.search(current_text):
        return BLOCK_RE.sub(lambda _: block, current_text, count=1)
    return None
