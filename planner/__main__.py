import argparse
import json
import socket
import subprocess
import sys
import time
import urllib.parse
from collections import Counter
from datetime import date, datetime, timedelta

from . import brief, config, fixes, health, searchindex, stats, threads, vault, weekly
from .extract import PROMPT, PROMPT_VERSION, extract, user_message
from .llm import OPENAI_COMPAT, LLMError, chat_json, list_models

MARK = {"done": "✓", "partial": "~", "skipped": "✗", "unknown": "·"}


def load_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def cmd_backfill(cfg, args):
    """Walk notes chronologically, extracting stale ones and rebuilding the thread registry."""
    days_dir = cfg.data_dir / "days"
    window = cfg.extract.get("thread_window_days", 21)
    registry = {}
    fx = fixes.load(cfg.data_dir)
    template = vault.template_text(cfg.daily_template)
    notes = vault.daily_notes(cfg.daily_dir)
    if args.limit:
        notes = notes[-args.limit:]
    if args.think:
        cfg.models["ollama_think"] = True
    for d, path in notes:
        # Check if this note has y: lines whose previous day note does not exist
        _, y_lines = vault.split_yesterday(path.read_text())
        if y_lines:
            prev_d = d - timedelta(days=1)
            prev_p = path.with_name(f"{prev_d.isoformat()}.md")
            if not prev_p.exists():
                print(f"y: lines in {d.isoformat()} have no note for {prev_d.isoformat()}; ignored", flush=True)

        note = vault.note_text(path).lstrip("\n")
        if vault.is_blank(note, template):
            continue  # just the brief and/or empty template: a day you didn't write

        side_path = days_dir / f"{d.isoformat()}.json"
        side = load_json(side_path, None)
        fresh = (side and side["source_hash"] == vault.sha(note) and side["prompt_version"] == PROMPT_VERSION
                 and side["model"] == cfg.models["extract"])
        wanted = not args.only or d.isoformat() in args.only
        if (fresh and not args.force) or not wanted:
            if not side:
                continue
            print(f"{d}  cached", flush=True)
        else:
            t0 = time.time()
            try:
                side = extract(d, note, threads.active(registry, d, window), cfg.models)
            except LLMError as e:
                sys.exit(f"{d}  failed: {e}")
            write_json(side_path, side)
            tasks = sum(1 for it in side["items"] if it["kind"] == "task")
            print(f"{d}  extracted {tasks} tasks, {len(side['items']) - tasks} notes  ({time.time() - t0:.1f}s)", flush=True)
        threads.merge(registry, fixes.apply(side, fx))
    write_json(cfg.data_dir / "threads.json", registry)
    print(f"\n{len(registry)} threads → {cfg.data_dir / 'threads.json'}")


def load_sides(data_dir):
    """Sidecars with the weekly review's thread fixes applied."""
    fx = fixes.load(data_dir)
    return [fixes.apply(load_json(p, None), fx) for p in sorted((data_dir / "days").glob("*.json"))]


def cmd_show(cfg, args):
    sides = load_sides(cfg.data_dir)
    if args.threads:
        registry = load_json(cfg.data_dir / "threads.json", {})
        status = {tid: Counter() for tid in registry}
        for s in sides:
            for it in s["items"]:
                if it["kind"] == "task" and it["thread"] in status:
                    status[it["thread"]][it["status"]] += 1
        for tid, t in sorted(registry.items(), key=lambda kv: kv[1]["last_seen"], reverse=True):
            counts = " ".join(f"{MARK[k]}{v}" for k, v in status[tid].items())
            print(f"[{t['type']:>4}] {tid:<40} {t['first_seen']} → {t['last_seen']}  {counts}")
        return
    for s in sides:
        if args.date and s["date"] != args.date:
            continue
        print(f"\n── {s['date']}" + (f"   flow: {'; '.join(s['flow'])}" if s["flow"] else ""))
        for it in s["items"]:
            if it["kind"] == "note":
                print(f"   note    {it['text']}  → {it['thread'] or '-'}")
                continue
            head = "" if it["type_from_heading"] else "?"
            extras = [x for x in [
                f"{it['est_min']}m" if it["est_min"] else "",
                it["priority"] if it["priority"] != "normal" else "",
                "unplanned" if not it["planned"] else "",
                f"({it['evidence']})" if it["evidence"] else "",
            ] if x]
            print(f"   {MARK[it['status']]} {it['type']+head:<5} {it['text']}  → {it['thread']}  {' '.join(extras)}")


def cmd_compare(cfg, args):
    """Day by day, which thread each task got in each run, then summary metrics per run."""
    dirs = [cfg.vault / d for d in args.dirs]
    runs = [{s["date"]: s for s in load_sides(d)} for d in dirs]
    common = sorted(set.intersection(*(set(r) for r in runs)))
    if not args.summary:
        for day in common:
            if args.date and day != args.date:
                continue
            print(f"\n── {day}")
            for d, run in zip(dirs, runs):
                print(f"   [{d.name}]")
                for it in run[day]["items"]:
                    if it["kind"] == "task":
                        print(f"     {it['type']:<4} {it['text'][:60]:<60}  → {it['thread'] or '-'}")
    print(f"\n{'run':<22} {'tasks':>5} {'notes':>5} {'ABC linked':>10} {'threads':>7} {'multi-day':>9} {'biggest thread':>24}")
    for d, run in zip(dirs, runs):
        items = [it for day in common for it in run[day]["items"]]
        tasks = [it for it in items if it["kind"] == "task"]
        work = [it for it in tasks if it["type"] in "ABC"]
        linked = sum(1 for it in work if it["thread"])
        sizes = Counter(it["thread"] for it in tasks if it["thread"])
        days = {}
        for day in common:
            for it in run[day]["items"]:
                if it["thread"]:
                    days.setdefault(it["thread"], set()).add(day)
        multi = sum(1 for v in days.values() if len(v) > 1)
        big, n = sizes.most_common(1)[0] if sizes else ("-", 0)
        print(f"{d.name:<22} {len(tasks):>5} {len(items) - len(tasks):>5} {linked:>4}/{len(work):<4}"
              f"{100 * linked // max(len(work), 1):>3}% {len(days):>5} {multi:>9}   {big[:18]:>18} ({n})")


def cmd_models(cfg, args):
    for m in list_models(args.provider):
        print(m)


def cmd_brief(cfg, args):
    """Dry run by default: print the brief and where it would go. --write puts it in the note."""
    day = date.fromisoformat(args.date) if args.date else vault.logical_today(cfg.schedule.get("day_starts_hour", 4))
    st = stats.compute(day, load_sides(cfg.data_dir), cfg.daily_dir,
                       cfg.brief.get("slip_window_notes", 6), cfg.brief.get("slip_min", 3))
    block = brief.render(st, brief.week_focus(cfg.reviews_dir), cfg.brief.get("collapsed", True),
                         getattr(args, "warnings", None))
    note_path = cfg.daily_dir / f"{day.isoformat()}.md"
    state_path = cfg.data_dir / "state.json"
    state = load_json(state_path, {"brief_inserted": []})
    already = day.isoformat() in state["brief_inserted"]
    current = note_path.read_text() if note_path.exists() else None
    new = brief.upsert(current, block, already, vault.template_text(cfg.daily_template))

    if new is None:
        action = "skip: you deleted the brief from this note, leaving it alone"
    elif current is None:
        action = f"create {note_path.name} with the brief"
    elif brief.START in current:
        action = "unchanged" if new == current else f"replace the brief in {note_path.name}"
    else:
        action = f"insert the brief at the top of {note_path.name}"

    if not args.write:
        print(block)
        print(f"[dry run] would {action}")
        if new and new != current:
            print("\n--- top of note after writing ---")
            print("\n".join(new.splitlines()[:block.count(chr(10)) + 6]))
        return
    if new is not None and new != current:
        brief.write_atomic(note_path, new)
    if new is not None and not already:
        state["brief_inserted"].append(day.isoformat())
        write_json(state_path, state)
    print(action)


def cmd_nightly(cfg, args):
    """Extract any new or edited notes, then write today's brief."""
    print(f"=== nightly {datetime.now():%Y-%m-%d %H:%M}", flush=True)
    args.force, args.limit, args.only, args.think = False, None, None, False
    cmd_backfill(cfg, args)
    args.date, args.write = None, True
    cmd_brief(cfg, args)


def cmd_weekly(cfg, args):
    """Review the week ending last Sunday. Never overwrites an existing review (it holds your answers)."""
    print(f"=== weekly {datetime.now():%Y-%m-%d %H:%M}", flush=True)
    end = date.fromisoformat(args.week_ending) if args.week_ending else weekly.week_ending(vault.logical_today(cfg.schedule.get("day_starts_hour", 4)))
    path = weekly.review_path(cfg.reviews_dir, end)
    if path.exists() and not args.force:
        print(f"{path.name} already exists; leaving it (and your answers) alone. Use --force to redo it.")
        return
    # Make sure the week's notes, including tonight's done sections, are extracted first.
    bf = argparse.Namespace(force=False, limit=None, only=None, think=False)
    cmd_backfill(cfg, bf)

    text, index = weekly.digest(end, load_sides(cfg.data_dir), cfg.daily_dir, cfg.reviews_dir)
    if args.show_input:
        print(f"# system\n{weekly.PROMPT}\n# user\n{text}")
        return
    print(f"asking {cfg.models['weekly']} ({len(text):,} chars of input)…", flush=True)
    result = chat_json(cfg.models["weekly"], weekly.PROMPT, text, weekly.SCHEMA, cfg.models)

    fx = fixes.load(cfg.data_dir)
    known = set(load_json(cfg.data_dir / "threads.json", {}))
    applied = weekly.cleanup(result, index, known, fx)
    model = cfg.models["weekly"].partition(":")[2]
    note = weekly.render(end, result, applied, model, f"{datetime.now():%Y-%m-%d %H:%M}")
    if args.dry_run:
        print(note)
        print(f"[dry run] would write {path} and apply {len(applied)} thread fixes")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    brief.write_atomic(path, note)
    if applied:
        fx["log"].append({"review": path.stem, "applied": applied})
        fixes.save(cfg.data_dir, fx)
        cmd_backfill(cfg, bf)  # rebuild the thread registry with the fixes
    print(f"wrote {path} ({len(applied)} thread fixes)")


def online(model_spec: str) -> bool:
    """Can we reach the extraction model's host? (Ollama counts as always reachable.)"""
    provider = model_spec.partition(":")[0]
    if provider not in OPENAI_COMPAT and provider != "anthropic":
        return True
    host = "api.anthropic.com" if provider == "anthropic" else OPENAI_COMPAT[provider][0].split("/")[2]
    try:
        socket.create_connection((host, 443), timeout=4).close()
        return True
    except OSError:
        return False


def show_reminder(cfg, day: date) -> None:
    vault_name = urllib.parse.quote(cfg.vault.name)
    file_name = urllib.parse.quote(day.isoformat())
    obsidian_uri = f"obsidian://open?vault={vault_name}&file={file_name}"
    msg = "One line on what got done today, even 'nothing'."
    osa = (
        f'display dialog "{msg}" '
        f'buttons {{"Later", "Open note"}} default button "Open note" giving up after 300'
    )
    res = subprocess.run(["osascript", "-e", osa], capture_output=True, text=True)
    if res.returncode != 0:
        health.notify("Planner", msg)
        print(f"osascript dialog failed ({res.stderr.strip()}); sent notification instead", flush=True)
    elif "button returned:Open note" in res.stdout:
        subprocess.run(["open", obsidian_uri])


def cmd_remind(cfg, args):
    """Show the evening reminder now, for testing."""
    day = date.fromisoformat(args.date) if args.date else vault.logical_today(cfg.schedule.get("day_starts_hour", 4))
    state_path = cfg.data_dir / "state.json"
    state = load_json(state_path, {"brief_inserted": []})
    today_note = cfg.daily_dir / f"{day.isoformat()}.md"
    if not args.force:
        if not today_note.exists() or stats.has_done_section(today_note):
            print(f"{today_note.name} already has a done record (or doesn't exist); no reminder needed. Use --force to show anyway.")
            return
    state["last_reminded"] = day.isoformat()
    write_json(state_path, state)
    show_reminder(cfg, day)


def _daytime_tick(cfg, state: dict, day: date, now: datetime) -> None:
    sched = cfg.schedule
    state_path = cfg.data_dir / "state.json"
    state_dirty = False
    today_note = cfg.daily_dir / f"{day.isoformat()}.md"

    # 1. Daytime y: refresh
    if today_note.exists():
        _, y_lines = vault.split_yesterday(today_note.read_text())
        if y_lines:
            y_key = vault.sha("\n".join(y_lines))
            refreshed = state.get("y_refreshed", {})
            if refreshed.get("day") != day.isoformat() or refreshed.get("key") != y_key:
                mtime = datetime.fromtimestamp(today_note.stat().st_mtime)
                if now - mtime >= timedelta(minutes=3):
                    if online(cfg.models["extract"]):
                        print(f"refreshing brief with y: lines from {today_note.name}", flush=True)
                        bf = argparse.Namespace(force=False, limit=None, only=None, think=False)
                        try:
                            cmd_backfill(cfg, bf)
                        except SystemExit as e:
                            # Recorded below, so it isn't retried every 5 minutes; new y: lines try again.
                            print(f"refresh extraction failed: {e}; retrying when the y: lines change", flush=True)
                            state["y_refreshed"] = {"day": day.isoformat(), "key": y_key, "failed": True}
                        else:
                            # Keep this morning's ⚠ Setup lines; the refresh doesn't rerun the checks.
                            saved = load_json(cfg.data_dir / "health.json", {})
                            warnings = saved.get("warnings",
                                                 [r["message"] for r in saved.get("results", []) if not r["ok"]])
                            cmd_brief(cfg, argparse.Namespace(date=day.isoformat(), write=True, warnings=warnings))
                            state["y_refreshed"] = {"day": day.isoformat(), "key": y_key}
                        state_dirty = True

    # 2. Evening reminder
    remind_on = sched.get("remind", True)
    remind_hour = sched.get("remind_hour", 21)
    day_starts = sched.get("day_starts_hour", 4)
    in_window = (now.hour >= remind_hour) or (now.hour < day_starts)
    if remind_on and in_window and state.get("last_reminded") != day.isoformat():
        if today_note.exists() and not stats.has_done_section(today_note):
            state["last_reminded"] = day.isoformat()
            write_json(state_path, state)
            state_dirty = False
            show_reminder(cfg, day)

    if state_dirty:
        write_json(state_path, state)


def cmd_threads(cfg, args):
    """Dry run by default: print Threads.md content. --write puts it in the vault."""
    day = date.fromisoformat(args.date) if args.date else vault.logical_today(cfg.schedule.get("day_starts_hour", 4))
    block = threads.render_dashboard(load_sides(cfg.data_dir), day, cfg)
    threads_path = cfg.vault / cfg.threads.get("file", "Threads.md")
    curr_threads = threads_path.read_text() if threads_path.exists() else None
    new_threads = threads.upsert_threads(curr_threads, block)
    if not args.write:
        print(block)
        if new_threads is None:
            print(f"[dry run] would skip {threads_path.name}: markers removed")
        else:
            action = "create" if curr_threads is None else "replace"
            print(f"[dry run] would {action} {threads_path.name}")
        return
    if new_threads is None:
        print(f"skip {threads_path.name}: markers removed, leaving it alone")
    elif new_threads != curr_threads:
        brief.write_atomic(threads_path, new_threads)
        print(f"wrote {threads_path.name}")
    else:
        print(f"{threads_path.name} unchanged")


def cmd_morning(cfg, args):
    """Run once per day, on the first check after you open the laptop and are online.

    launchd calls this every few minutes; it exits silently once today's run is done.
    A day starts at day_starts_hour (default 4am), so a 1am session still counts as yesterday.
    """
    sched = cfg.schedule
    now = datetime.now()
    day = vault.logical_today(sched.get("day_starts_hour", 4), now)
    state_path = cfg.data_dir / "state.json"
    state = load_json(state_path, {"brief_inserted": []})
    if state.get("last_morning") == day.isoformat() and not args.force:
        _daytime_tick(cfg, state, day, now)
        return

    is_online = online(cfg.models["extract"])
    if not is_online:
        since = state.get("offline_since")
        if not since or since[:10] != day.isoformat():
            state["offline_since"] = now.isoformat(timespec="minutes")
            write_json(state_path, state)
            print(f"{now:%Y-%m-%d %H:%M} offline; waiting for a connection", flush=True)
            return
        if now - datetime.fromisoformat(since) < timedelta(minutes=sched.get("offline_grace_min", 60)):
            return
        print(f"still offline after {sched.get('offline_grace_min', 60)} min; running with the local fallback", flush=True)

    print(f"=== morning {now:%Y-%m-%d %H:%M} (for {day})", flush=True)
    warnings = []
    try:
        next(iter(cfg.daily_dir.iterdir()), None)
    except PermissionError:
        msg = "macOS is blocking access to your vault, so there's no brief today. Run `planner doctor` for the fix."
        print(msg, flush=True)
        health.notify("Planner", msg)
        return
    # If last Sunday's review never got written (laptop closed, offline), write it before the brief.
    last_sunday = day - timedelta(days=day.weekday() + 1)
    target = weekly.review_path(cfg.reviews_dir, last_sunday)
    existing = sorted(cfg.reviews_dir.glob("*-W*.md")) if cfg.reviews_dir.is_dir() else []
    # Only catch up weeks since reviews began, never backfill history before the first one.
    started = not existing or target.name >= existing[0].name
    if is_online and started and not target.exists():
        print(f"catching up the weekly review for the week ending {last_sunday}", flush=True)
        try:
            cmd_weekly(cfg, argparse.Namespace(week_ending=last_sunday.isoformat(), dry_run=False,
                                               show_input=False, force=False))
        except (LLMError, SystemExit) as e:
            print(f"weekly review failed ({e}); the brief still runs, review retries tomorrow", flush=True)
            warnings.append(f"Last week's review couldn't be written ({str(e)[:140]}); it retries tomorrow.")

    try:
        cmd_backfill(cfg, argparse.Namespace(force=False, limit=None, only=None, think=False))
    except SystemExit as e:
        # Both the hosted model and the local fallback failed; still write a brief from earlier notes.
        print(f"extraction failed: {e}", flush=True)
        warnings.append(f"Couldn't extract your latest notes ({str(e)[:140]}); this brief uses older data.")

    results = health.run(cfg, load_sides(cfg.data_dir), is_online, today=day)
    warnings += [r.message for r in results if not r.ok]
    # Daytime brief refreshes reuse these warnings.
    write_json(cfg.data_dir / "health.json", {"checked": now.isoformat(timespec="minutes"),
                                              "results": [r.__dict__ for r in results], "warnings": warnings})
    for w in warnings:
        print(f"warning: {w}", flush=True)
    try:
        cmd_brief(cfg, argparse.Namespace(date=day.isoformat(), write=True, warnings=warnings))
    except PermissionError as e:
        health.notify("Planner", f"Couldn't write today's brief: {e}")
        raise

    # Write Threads.md
    threads_path = cfg.vault / cfg.threads.get("file", "Threads.md")
    threads_block = threads.render_dashboard(load_sides(cfg.data_dir), day, cfg)
    curr_threads = threads_path.read_text() if threads_path.exists() else None
    new_threads = threads.upsert_threads(curr_threads, threads_block)
    if new_threads is None:
        print(f"skip {threads_path.name}: markers removed, leaving it alone", flush=True)
    elif new_threads != curr_threads:
        brief.write_atomic(threads_path, new_threads)
        print(f"wrote {threads_path.name}", flush=True)

    # Update search index; failure becomes a warning and never blocks the brief
    if getattr(cfg, "search", None):
        try:
            searchindex.build_index(cfg)
            print("updated search index", flush=True)
        except Exception as e:
            print(f"search index failed: {e}", flush=True)
            search_warning = f"Search index couldn't be updated ({str(e)[:140]})."
            warnings.append(search_warning)
            write_json(cfg.data_dir / "health.json", {
                "checked": now.isoformat(timespec="minutes"),
                "results": [r.__dict__ for r in results],
                "warnings": warnings,
            })
            try:
                cmd_brief(cfg, argparse.Namespace(date=day.isoformat(), write=True, warnings=warnings))
            except Exception:
                pass

    state = load_json(state_path, {"brief_inserted": []})  # cmd_brief updated it
    state["last_morning"] = day.isoformat()
    state.pop("offline_since", None)
    write_json(state_path, state)


def cmd_doctor(cfg, args):
    """Run every setup check now and print the result with its fix. No model calls."""
    search_only = getattr(args, "search", False)
    is_online = online(cfg.models["extract"])
    if not search_only:
        print(f"online: {'yes' if is_online else 'no (endpoint checks skipped)'}")
    results = health.run(cfg, load_sides(cfg.data_dir), is_online, search_only=search_only)
    for r in results:
        print(f"{'✓' if r.ok else '✗'} {r.name}" + ("" if r.ok else f"\n    {r.message}"))
    bad = sum(not r.ok for r in results)
    print(f"\n{len(results) - bad}/{len(results)} checks passed")
    if bad:
        sys.exit(1)


def cmd_prompt(cfg, args):
    d = date.fromisoformat(args.date)
    path = cfg.daily_dir / f"{args.date}.md"
    print(f"# system ({PROMPT_VERSION})\n{PROMPT}\n# user\n{user_message(d, vault.note_text(path), [])}")


def cmd_search(cfg, args):
    if args.search_cmd == "stats":
        searchindex.print_stats(cfg)
    elif args.search_cmd == "index":
        try:
            res = searchindex.build_index(cfg, full=args.full, limit=args.limit)
            if res.get("changed", True):
                print(f"Indexed {res['papers']} papers ({res['chunks']} chunks) in {res['elapsed']:.1f}s")
                if res["no_text_pdfs"]:
                    print(f"PDFs with no text ({len(res['no_text_pdfs'])}):")
                    for item in res["no_text_pdfs"]:
                        print(f"  - {item}")
        except TimeoutError as e:
            print(f"search index: {e}", file=sys.stderr)
            sys.exit(1)
    elif args.search_cmd == "watch-run":
        from . import zotwatch
        zotwatch.watch_run(cfg)


def main():
    p = argparse.ArgumentParser(prog="planner")
    p.add_argument("--model", help='override the extraction model, e.g. "groq:qwen/qwen3-32b"')
    p.add_argument("--data", help="data folder inside the vault (default from config), e.g. .planner-groq")
    sub = p.add_subparsers(dest="cmd", required=True)
    sc = sub.add_parser("search", help="paper search: stats, index, or watch-run")
    sc_sub = sc.add_subparsers(dest="search_cmd", required=True)
    sc_sub.add_parser("stats", help="papers, chunks, PDFs with no text, papers with no abstract, model, age")
    sc_idx = sc_sub.add_parser("index", help="build or update search index")
    sc_idx.add_argument("--full", action="store_true", help="force full rebuild")
    sc_idx.add_argument("--limit", type=int, help="limit number of papers to index")
    sc_sub.add_parser("watch-run", help="run watcher incremental sync on Zotero changes")
    b = sub.add_parser("backfill", help="extract all daily notes into .planner/")
    b.add_argument("--force", action="store_true", help="re-extract even cached notes")
    b.add_argument("--limit", type=int, help="only the most recent N notes")
    b.add_argument("--only", nargs="+", metavar="DATE", help="re-extract just these dates (others use cache)")
    b.add_argument("--think", action="store_true", help="let the model reason first (slower, better threads)")
    s = sub.add_parser("show", help="print extracted data for inspection")
    s.add_argument("--threads", action="store_true", help="summarise threads instead of days")
    s.add_argument("--date", help="only this date (YYYY-MM-DD)")
    pr = sub.add_parser("prompt", help="print the extraction prompt for one note (no model call)")
    pr.add_argument("date")
    br = sub.add_parser("brief", help="show today's brief (dry run); --write inserts it into the note")
    br.add_argument("--date", help="brief for this date instead of today (YYYY-MM-DD)")
    br.add_argument("--write", action="store_true", help="actually write it into the daily note")
    sub.add_parser("nightly", help="extract new/edited notes, then write today's brief")
    dr = sub.add_parser("doctor", help="check permissions, the Python env and model endpoints (no model calls)")
    dr.add_argument("--search", action="store_true", help="run only search & watcher checks (no LLM keys needed)")
    mo = sub.add_parser("morning", help="once a day, on first wake while online: extract, catch up review, write brief")
    mo.add_argument("--force", action="store_true", help="run even if today's run already happened")
    wk = sub.add_parser("weekly", help="write the weekly review for the week ending last Sunday")
    wk.add_argument("--week-ending", help="a Sunday (YYYY-MM-DD); default: the most recent one")
    wk.add_argument("--dry-run", action="store_true", help="call the model and print the review; write nothing")
    wk.add_argument("--show-input", action="store_true", help="print what the model would read; no model call")
    wk.add_argument("--force", action="store_true", help="overwrite an existing review (loses your answers)")
    th = sub.add_parser("threads", help="show Threads.md (dry run); --write updates the file")
    th.add_argument("--date", help="dashboard as of this date (YYYY-MM-DD)")
    th.add_argument("--write", action="store_true", help="write to Threads.md in the vault")
    rm = sub.add_parser("remind", help="show evening reminder dialog (for testing)")
    rm.add_argument("--date", help="date for reminder (YYYY-MM-DD)")
    rm.add_argument("--force", action="store_true", help="show even if note has done section or already reminded")
    c = sub.add_parser("compare", help="compare thread assignments between two data folders")
    c.add_argument("dirs", nargs="+", help="data folders, e.g. .planner .planner-groq")
    c.add_argument("--summary", action="store_true", help="metrics only")
    c.add_argument("--date", help="only this date")
    m = sub.add_parser("models", help="list a hosted provider's models")
    m.add_argument("provider", choices=sorted(OPENAI_COMPAT))
    args = p.parse_args()
    cfg = config.load()
    if args.model:
        cfg.models["extract"] = args.model
    if args.data:
        cfg.data_dir = cfg.vault / args.data
    cmds = {"backfill": cmd_backfill, "show": cmd_show, "prompt": cmd_prompt, "compare": cmd_compare, "models": cmd_models,
            "brief": cmd_brief, "nightly": cmd_nightly, "weekly": cmd_weekly,
            "morning": cmd_morning, "doctor": cmd_doctor, "threads": cmd_threads, "remind": cmd_remind,
            "search": cmd_search}
    try:
        cmds[args.cmd](cfg, args)
    except LLMError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
