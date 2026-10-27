import time
import traceback
import urllib.request
from datetime import datetime
from pathlib import Path

from . import searchindex
from .store import load_json, search_lock, write_json
from .zotlib import compute_fingerprint, db_files


# Seconds zotero.sqlite must sit unmodified before a build. Zotero writes a new item, its attachment and any
# retrieved metadata within a few seconds of each other; the post-build fingerprint recheck catches a late write.
QUIET_S = 8.0


def log(msg: str) -> None:
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} zotero watch: {msg}", flush=True)


def ollama_up(ollama_url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(f"{ollama_url.rstrip('/')}/api/tags", timeout=timeout):
            return True
    except Exception:
        return False


def embedder_up(cfg) -> tuple[str, bool]:
    """(name, answering) for the configured embedding service: pplxd for the pplx profile, else Ollama."""
    if cfg.search.get("backend", "ollama") == "pplx":
        from . import pplx
        return "pplx", pplx.health(cfg.search.get("pplx_url", "http://127.0.0.1:11435")) is not None
    return "Ollama", ollama_up(cfg.search.get("ollama_url", "http://localhost:11434"))


def wait_for_quiet(
    db_path: Path,
    quiet_s: float = QUIET_S,
    check_interval_s: float = 5.0,
    max_wait_s: float = 600.0,
    time_fn=time.time,
    sleep_fn=time.sleep,
) -> bool:
    start_time = time_fn()
    while True:
        if not db_path.exists():
            return False
        # Zotero writes to the write-ahead log; zotero.sqlite itself changes only at a checkpoint.
        mtime = max(f.stat().st_mtime for f in db_files(db_path.parent) if f.exists())
        now = time_fn()
        age = now - mtime
        if age >= quiet_s:
            return True
        if (now - start_time) >= max_wait_s:
            return False
        wait_step = min(check_interval_s, max(0.01, quiet_s - age))
        sleep_fn(wait_step)


def watch_run(
    cfg,
    quiet_s: float = QUIET_S,
    check_interval_s: float = 5.0,
    max_wait_s: float = 600.0,
    time_fn=time.time,
    sleep_fn=time.sleep,
) -> int:
    zotero_dir = Path(cfg.search.get("zotero_dir", "~/Zotero")).expanduser()
    db_path = zotero_dir / "zotero.sqlite"

    if not db_path.exists():
        log(f"{db_path} does not exist")
        return 0

    # 1. Non-blocking lock
    try:
        with search_lock(cfg, blocking=False):
            round_count = 0
            while round_count < 3:
                round_count += 1

                # 2. Wait for Zotero to go quiet
                quiet = wait_for_quiet(
                    db_path,
                    quiet_s=quiet_s,
                    check_interval_s=check_interval_s,
                    max_wait_s=max_wait_s,
                    time_fn=time_fn,
                    sleep_fn=sleep_fn,
                )
                if not quiet:
                    log("gave up waiting")
                    return 0

                # 3. Fingerprint
                fp = compute_fingerprint(zotero_dir)
                if fp is None:
                    return 0

                state_file = cfg.data_dir / "search" / "state.json"
                state = load_json(state_file, {})
                old_fp = state.get("fingerprint")

                retry = fp == old_fp
                if retry:
                    if not state.get("degraded"):
                        log("no changes")
                        return 0
                    # Keyword-only index: retry embedding, but only once the embedder answers, so an hourly
                    # check with it still down costs one HTTP probe, not a pdftotext pass.
                    name, up = embedder_up(cfg)
                    if not up:
                        log(f"keyword-only index, {name} still unavailable")
                        return 0
                    log(f"{name} is back, embedding the keyword-only texts")

                # 4. Build index: a library change is published keyword-only first (citable in a second or two),
                # then embedded (~0.4 s a chunk on pplx). A retry has nothing new to publish, so it embeds directly.
                t0 = time.time()
                try:
                    if not retry:
                        res = searchindex.build_index(cfg, full=False, keyword_only=True)
                        if res.get("missing_vectors"):
                            log(f"keyword index published in {time.time() - t0:.1f}s ({res['papers']} papers); "
                                f"embedding {res['missing_vectors']} texts")
                    if retry or res.get("missing_vectors"):
                        res = searchindex.build_index(cfg, full=False)
                    log(f"build completed in {time.time() - t0:.1f}s ({res['papers']} papers, {res['chunks']} chunks)")
                    if res.get("missing_vectors"):
                        log(f"{res['missing_vectors']} texts keyword-only (embedder unavailable); retrying hourly")
                except Exception as e:
                    log(f"build failed ({e})")
                    traceback.print_exc()
                    return 0

                # 5. Record fingerprint on success
                state = load_json(state_file, {})
                state["fingerprint"] = fp
                write_json(state_file, state)

                # 6. Recheck fingerprint before releasing lock
                fp_after = compute_fingerprint(zotero_dir)
                if fp_after == fp:
                    break
                # changed during build: continue to next round (up to 3)

            return 0
    except BlockingIOError:
        log("busy")
        return 0
    except Exception as e:
        log(f"error ({e})")
        traceback.print_exc()
        return 0
