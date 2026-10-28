import time
import traceback
import urllib.request
from datetime import datetime
from pathlib import Path

from . import searchindex
from .config import SearchSettings
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
    s = SearchSettings.of(cfg)
    if s.backend == "pplx":
        from . import pplx
        return "pplx", pplx.health(s.pplx_url) is not None
    return "Ollama", ollama_up(s.ollama_url)


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


STATUS_FILE = "zotero-watch.json"   # in <data_dir>: consecutive failures and the last error, read by `doctor`


def _record(cfg, error: Exception | None) -> None:
    """Note the round's outcome for `doctor`. Writes only when it changes something (a failure, or the first success
    after failures), so a watcher with nothing to do writes nothing."""
    path = cfg.data_dir / STATUS_FILE
    status = load_json(path, {})
    if error is None:
        if not status.get("consecutive_failures"):
            return
        status = {"consecutive_failures": 0, "last_ok": datetime.now().isoformat(timespec="seconds")}
    else:
        status["consecutive_failures"] = status.get("consecutive_failures", 0) + 1
        status["last_error"] = f"{type(error).__name__}: {error}"[:300]
        status["last_failure"] = datetime.now().isoformat(timespec="seconds")
    write_json(path, status)


def watch_run(
    cfg,
    quiet_s: float = QUIET_S,
    check_interval_s: float = 5.0,
    max_wait_s: float = 600.0,
    lock_timeout_s: float = 120.0,
    time_fn=time.time,
    sleep_fn=time.sleep,
) -> None:
    """One launchd run: wait for Zotero to go quiet, and if the library changed, publish it (keyword-only first, then
    with vectors). Up to three rounds while Zotero keeps writing. Never raises."""
    zotero_dir = SearchSettings.of(cfg).zotero_dir
    db_path = zotero_dir / "zotero.sqlite"
    if not db_path.exists():
        log(f"{db_path} does not exist")
        return
    state_file = cfg.data_dir / "search" / "state.json"
    try:
        for _ in range(3):
            # Waiting takes no lock: a build started meanwhile (by hand, or a profile switch) must not time out on us.
            if not wait_for_quiet(db_path, quiet_s=quiet_s, check_interval_s=check_interval_s, max_wait_s=max_wait_s,
                                  time_fn=time_fn, sleep_fn=sleep_fn):
                log("gave up waiting")
                return
            fp = compute_fingerprint(zotero_dir)
            if fp is None:
                return
            with search_lock(cfg, timeout=lock_timeout_s):
                state = load_json(state_file, {})
                retry = fp == state.get("fingerprint")
                if retry:
                    if not state.get("degraded"):
                        log("no changes")
                        _record(cfg, None)
                        return
                    # Keyword-only index: retry embedding, but only once the embedder answers, so an hourly
                    # check with it still down costs one HTTP probe, not a pdftotext pass.
                    name, up = embedder_up(cfg)
                    if not up:
                        log(f"keyword-only index, {name} still unavailable")
                        return
                    log(f"{name} is back, embedding the keyword-only texts")

                # A library change is published keyword-only first (citable in a second or two), then embedded
                # (~0.4 s a chunk on pplx). A retry has nothing new to publish, so it embeds directly. Both builds
                # record `fp`, the library they were built from.
                t0 = time.time()
                try:
                    res = None
                    if not retry:
                        res = searchindex.build_index(cfg, full=False, keyword_only=True, fingerprint=fp)
                        if res.get("missing_vectors"):
                            log(f"keyword index published in {time.time() - t0:.1f}s ({res['papers']} papers); "
                                f"embedding {res['missing_vectors']} texts")
                    if res is None or res.get("missing_vectors"):
                        res = searchindex.build_index(cfg, full=False, fingerprint=fp)
                    log(f"build completed in {time.time() - t0:.1f}s ({res['papers']} papers, {res['chunks']} chunks)")
                    if res.get("missing_vectors"):
                        log(f"{res['missing_vectors']} texts keyword-only (embedder unavailable); retrying hourly")
                except Exception as e:
                    log(f"build failed ({e})")
                    traceback.print_exc()
                    _record(cfg, e)
                    return
                _record(cfg, None)
            # Zotero wrote during the build: go round again.
            if compute_fingerprint(zotero_dir) == fp:
                return
    except TimeoutError:
        log(f"busy: another build held the index for {lock_timeout_s:.0f}s; the next run catches up")
    except Exception as e:
        log(f"error ({e})")
        traceback.print_exc()
        _record(cfg, e)
