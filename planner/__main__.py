"""`python -m planner …`: Semantero's indexers (Zotero papers, vault notes), embedding profiles and health checks."""
import argparse
import sys
from datetime import datetime, timedelta

from . import config, embed, health, notesindex, profiles, searchindex


def notes_tick_warning(cfg, err: Exception) -> str | None:
    """A setup warning for a failed notes-index run, only when the index is missing or over a day old."""
    st = notesindex.get_stats(cfg)
    if st.get("indexed"):
        try:
            age = datetime.now() - datetime.fromisoformat(st["built_at"])
            if age <= timedelta(days=1):
                return None
        except (KeyError, TypeError, ValueError):
            pass
    return f"Notes index couldn't be updated ({str(err)[:140]}). Run: planner notes index"


def notes_tick(cfg) -> None:
    """The 5-minute launchd job (com.planner.notes): keep the notes index fresh. Never raises; a busy lock skips."""
    if not notesindex.notes_enabled(cfg) or not getattr(cfg, "search", None):
        return
    try:
        res = notesindex.build_index(cfg, blocking=False)
        if res.get("changed"):
            print(f"updated notes index ({res['notes']} notes)", flush=True)
    except BlockingIOError:
        return
    except Exception as e:  # includes notesindex.VaultUnreadable: the old index is kept
        print(f"notes index failed: {e}", flush=True)
        warning = notes_tick_warning(cfg, e)
        if warning:
            print(f"warning: {warning}", flush=True)


def cmd_search(cfg, args):
    if args.search_cmd == "stats":
        searchindex.print_stats(cfg)
    elif args.search_cmd == "index":
        try:
            res = searchindex.build_index(cfg, full=args.full, limit=args.limit)
            if res.get("changed", True):
                print(f"Indexed {res['papers']} papers ({res['chunks']} chunks) in {res['elapsed']:.1f}s")
            if res.get("missing_vectors"):
                name, _ = embed.service(config.SearchSettings.of(cfg).backend)
                print(f"Keyword-only for {res['missing_vectors']} texts: {name} was unavailable. "
                      "The watcher embeds them within the hour once it is running.")
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


def cmd_notes(cfg, args):
    if args.notes_cmd == "tick":
        notes_tick(cfg)
    elif args.notes_cmd == "stats":
        notesindex.print_stats(cfg)
    elif args.notes_cmd == "index":
        if not notesindex.notes_enabled(cfg):
            sys.exit("notes index is not enabled: add a [notes] section to config.toml")
        try:
            res = notesindex.build_index(cfg, full=args.full)
        except (TimeoutError, BlockingIOError) as e:
            print(f"notes index: {e}", file=sys.stderr)
            sys.exit(1)
        if res["changed"]:
            print(f"Indexed {res['notes']} notes ({res['chunks']} chunks, {res['embedded']} texts embedded) "
                  f"in {res['elapsed']:.1f}s; {res['excluded']} excluded")
        else:
            print(f"notes index: no changes ({res['elapsed']:.1f}s)")
        if res["missing_vectors"]:
            name, _ = embed.service(config.SearchSettings.of(cfg).backend)
            print(f"Keyword-only for {res['missing_vectors']} texts: {name} was unavailable. "
                  "The next tick embeds them once it is running.")
        for item in res["skipped"]:
            print(f"  skipped {item}")


def _build_profile(pc, full: bool) -> None:
    res = searchindex.build_index(pc, full=full)
    if res.get("changed", True):
        print(f"  papers: {res['papers']} ({res['chunks']} chunks) in {res['elapsed']:.0f}s", flush=True)
    if res.get("missing_vectors"):
        raise SystemExit(f"  {res['missing_vectors']} texts were not embedded: is the embedding service running?")
    if notesindex.notes_enabled(pc):
        res = notesindex.build_index(pc, full=full)
        print(f"  notes: {res['notes']} ({res['chunks']} chunks, {res['embedded']} embedded) in {res['elapsed']:.0f}s",
              flush=True)
        if res["missing_vectors"]:
            raise SystemExit(f"  {res['missing_vectors']} note texts were not embedded")


def cmd_profile(cfg, args):
    if args.profile_cmd == "list":
        for r in profiles.status(cfg):
            mark = "*" if r["active"] else " "
            built = ", ".join(f"{c} {i['mb']} MB ({i['built_at']})" for c, i in r["info"].items()
                              if r["built"].get(c)) or "not built"
            print(f"{mark} {r['name']:<14} {r['model']:<34} {r['dims']:>5}d  {built}")
        print("* = live. Switch with: planner profile use NAME")
    elif args.profile_cmd == "build":
        pc = profiles.profile_cfg(cfg, args.name)
        print(f"building {args.name} ({pc.search['model']}, {pc.search['dims']} dims) in {pc.data_dir}", flush=True)
        _build_profile(pc, args.full)
    elif args.profile_cmd == "use":
        try:
            print(profiles.use(cfg, args.name))
        except profiles.ProfileError as e:
            sys.exit(str(e))
        cfg = config.load()
        if args.data:
            cfg.data_dir = cfg.vault / args.data
        print("catching up with changes since it was built…", flush=True)
        _build_profile(cfg, False)


def cmd_doctor(cfg, args):
    """Run every setup check now and print the result with its fix."""
    results = health.run(cfg)
    for r in results:
        note = f"\n    note: {r.message}" if r.ok and r.message else ""
        print(f"{'✓' if r.ok else '✗'} {r.name}" + (note if r.ok else f"\n    {r.message}"))
    bad = sum(not r.ok for r in results)
    print(f"\n{len(results) - bad}/{len(results)} checks passed")
    if bad:
        sys.exit(1)


def main():
    p = argparse.ArgumentParser(prog="planner", description="Semantero's indexers: Zotero papers and vault notes")
    p.add_argument("--data", help="data folder inside the vault (default from config), e.g. .planner-test")
    sub = p.add_subparsers(dest="cmd", required=True)
    sc = sub.add_parser("search", help="paper search: stats, index, or watch-run")
    sc_sub = sc.add_subparsers(dest="search_cmd", required=True)
    sc_sub.add_parser("stats", help="papers, chunks, PDFs with no text, papers with no abstract, model, age")
    sc_idx = sc_sub.add_parser("index", help="build or update search index")
    sc_idx.add_argument("--full", action="store_true", help="force full rebuild")
    sc_idx.add_argument("--limit", type=int, help="limit number of papers to index")
    sc_sub.add_parser("watch-run", help="run watcher incremental sync on Zotero changes")
    nc = sub.add_parser("notes", help="vault notes search index: stats, index or tick")
    nc_sub = nc.add_subparsers(dest="notes_cmd", required=True)
    nc_sub.add_parser("stats", help="notes per kind, chunks, literature notes, excluded, model, age")
    nc_idx = nc_sub.add_parser("index", help="build or update the notes index")
    nc_idx.add_argument("--full", action="store_true", help="force full rebuild")
    nc_sub.add_parser("tick", help="the 5-minute launchd job: update the notes index if it is on; never fails")
    pf = sub.add_parser("profile", help="embedding profiles: list, build or switch the live search index (profiles.toml)")
    pf_sub = pf.add_subparsers(dest="profile_cmd", required=True)
    pf_sub.add_parser("list", help="every profile: model, dims, built or not, size, age; * marks the live one")
    pf_b = pf_sub.add_parser("build", help="build or update a profile's papers + notes index (the live one is untouched)")
    pf_b.add_argument("name")
    pf_b.add_argument("--full", action="store_true", help="force a full rebuild")
    pf_u = pf_sub.add_parser("use", help="make a built profile the live index, then catch it up")
    pf_u.add_argument("name")
    dr = sub.add_parser("doctor", help="check the vault, the Python env, the indexes, the embedder and the watcher")
    dr.add_argument("--search", action="store_true", help=argparse.SUPPRESS)   # older docs and scripts pass it
    args = p.parse_args()
    cfg = config.load()
    if args.data:
        cfg.data_dir = cfg.vault / args.data
    cmds = {"doctor": cmd_doctor, "search": cmd_search, "notes": cmd_notes, "profile": cmd_profile}
    cmds[args.cmd](cfg, args)


if __name__ == "__main__":
    main()
