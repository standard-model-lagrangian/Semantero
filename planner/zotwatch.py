import hashlib
import sqlite3
import time
import urllib.request
from pathlib import Path

from . import searchindex
from .searchindex import search_lock, load_json, write_json


def compute_fingerprint(zotero_dir: Path | str) -> str | None:
    zotero_dir = Path(zotero_dir).expanduser()
    db_path = zotero_dir / "zotero.sqlite"
    if not db_path.exists():
        return None

    try:
        # read-only URI via ?immutable=1
        conn = sqlite3.connect(f"file:{db_path.resolve().as_posix()}?immutable=1", uri=True)
        cur = conn.cursor()

        # 1. number of regular items not in the trash
        cur.execute("""
            SELECT COUNT(*) FROM items
            WHERE itemID NOT IN (SELECT itemID FROM deletedItems)
              AND itemTypeID NOT IN (
                  SELECT itemTypeID FROM itemTypes
                  WHERE typeName IN ('attachment', 'note', 'annotation')
              )
        """)
        regular_count = cur.fetchone()[0]

        # 2. max(clientDateModified) over items
        cur.execute("""
            SELECT MAX(clientDateModified) FROM items
            WHERE itemID NOT IN (SELECT itemID FROM deletedItems)
        """)
        max_client_date = cur.fetchone()[0] or ""

        # 3. number of attachments
        cur.execute("""
            SELECT COUNT(*) FROM itemAttachments
            WHERE itemID NOT IN (SELECT itemID FROM deletedItems)
              AND contentType = 'application/pdf'
        """)
        att_count = cur.fetchone()[0]

        # 4. sorted list of (PDF path, mtime, size) for each PDF attachment
        cur.execute("""
            SELECT i.key, a.path
            FROM itemAttachments a
            JOIN items i ON a.itemID = i.itemID
            WHERE a.contentType = 'application/pdf'
              AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
        """)
        pdf_rows = cur.fetchall()
        conn.close()

        pdf_stats: list[tuple[str, int, int]] = []
        for att_key, path_str in pdf_rows:
            if path_str and path_str.startswith("storage:"):
                fname = path_str[len("storage:"):]
                full_path = zotero_dir / "storage" / att_key / fname
            elif path_str:
                full_path = Path(path_str)
            else:
                continue

            if full_path.exists():
                stat = full_path.stat()
                pdf_stats.append((str(full_path), stat.st_mtime_ns, stat.st_size))
            else:
                pdf_stats.append((str(full_path), 0, 0))

        pdf_stats.sort(key=lambda x: x[0])

        hasher = hashlib.sha256()
        hasher.update(f"reg:{regular_count}".encode())
        hasher.update(f"max_date:{max_client_date}".encode())
        hasher.update(f"att:{att_count}".encode())
        for p, m, s in pdf_stats:
            hasher.update(f"{p}:{m}:{s}".encode())

        return hasher.hexdigest()
    except Exception as e:
        print(f"zotero watch: sqlite unreadable ({e})", flush=True)
        return None


def ollama_up(ollama_url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(f"{ollama_url.rstrip('/')}/api/tags", timeout=timeout):
            return True
    except Exception:
        return False


def wait_for_quiet(
    db_path: Path,
    quiet_s: float = 20.0,
    check_interval_s: float = 5.0,
    max_wait_s: float = 600.0,
    time_fn=time.time,
    sleep_fn=time.sleep,
) -> bool:
    start_time = time_fn()
    while True:
        if not db_path.exists():
            return False
        stat = db_path.stat()
        mtime = stat.st_mtime
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
    quiet_s: float = 20.0,
    check_interval_s: float = 5.0,
    max_wait_s: float = 600.0,
    time_fn=time.time,
    sleep_fn=time.sleep,
) -> int:
    zotero_dir = Path(cfg.search.get("zotero_dir", "~/Zotero")).expanduser()
    db_path = zotero_dir / "zotero.sqlite"

    if not db_path.exists():
        print(f"zotero watch: {db_path} does not exist", flush=True)
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
                    print("zotero watch: gave up waiting", flush=True)
                    return 0

                # 3. Fingerprint
                fp = compute_fingerprint(zotero_dir)
                if fp is None:
                    return 0

                state_file = cfg.data_dir / "search" / "state.json"
                state = load_json(state_file, {})
                old_fp = state.get("fingerprint")

                if fp == old_fp:
                    if not state.get("degraded"):
                        print("zotero watch: no changes", flush=True)
                        return 0
                    # Keyword-only index: retry embedding, but only once Ollama answers, so an hourly
                    # check with Ollama still down costs one HTTP probe, not a pdftotext pass.
                    if not ollama_up(cfg.search.get("ollama_url", "http://localhost:11434")):
                        print("zotero watch: keyword-only index, Ollama still unavailable", flush=True)
                        return 0
                    print("zotero watch: Ollama is back, embedding the keyword-only texts", flush=True)

                # 4. Build index
                try:
                    res = searchindex.build_index(cfg, full=False)
                    print(
                        f"zotero watch: build completed ({res['papers']} papers, {res['chunks']} chunks)",
                        flush=True,
                    )
                    if res.get("missing_vectors"):
                        print(f"zotero watch: {res['missing_vectors']} texts keyword-only (Ollama unavailable); "
                              "retrying hourly", flush=True)
                except Exception as e:
                    print(f"zotero watch: build failed ({e})", flush=True)
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
        print("zotero watch: busy", flush=True)
        return 0
    except Exception as e:
        print(f"zotero watch: error ({e})", flush=True)
        return 0
