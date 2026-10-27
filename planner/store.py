"""Durable files shared by the planner and the index builders: JSON state, atomic writes, index folder swaps, locks.

Everything here is written so that a crash or power loss leaves either the old file (folder) or the new one, never a
torn one: a reader of `state.json` or an index never has to cope with half a write.
"""
import fcntl
import json
import os
import shutil
import sys
import time
from contextlib import contextmanager
from pathlib import Path


def load_json(path: Path, default=None):
    """The parsed file, or `default` if it is missing or not valid JSON (said on stderr, naming the file)."""
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default
    except ValueError as e:
        print(f"{path}: not valid JSON ({e}); treating it as missing", file=sys.stderr)
        return default


def write_text(path: Path, text: str) -> None:
    """Write via a hidden temp file in the same folder, fsync, then rename over `path`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.planner-tmp")
    try:
        with open(tmp, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def write_json(path: Path, data) -> None:
    write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def atomic_swap(tmp_dir: Path, final_dir: Path, old_dir: Path) -> None:
    """Move a fully written tmp_dir into place: old aside, new in, old deleted. Between the two renames no live folder
    exists; `recover_swap` undoes a crash in that gap."""
    if old_dir.exists():
        shutil.rmtree(old_dir)
    if final_dir.exists():
        final_dir.rename(old_dir)
    tmp_dir.rename(final_dir)
    if old_dir.exists():
        shutil.rmtree(old_dir)


def recover_swap(final_dir: Path, old_dir: Path) -> None:
    """Put back the folder an interrupted `atomic_swap` left aside, so the next build updates it instead of starting
    from nothing. Call with the folder's lock held."""
    if not final_dir.exists() and old_dir.exists():
        old_dir.rename(final_dir)


# Locks this process already holds, by path, with their nesting depth. flock locks belong to the
# open file, so a second open() of the same lock in this process would block on the first one
# (watch-run holds the lock and then calls build_index, which takes it again).
_held_locks: dict[str, int] = {}


@contextmanager
def named_lock(cfg, filename: str, timeout: float = 60.0, blocking: bool = True):
    """Advisory lock on <data_dir>/<filename>; re-entrant within one process. Non-blocking: BlockingIOError if busy.
    Blocking: polls (flock itself has no timeout) and raises TimeoutError after `timeout` seconds."""
    lock_path = cfg.data_dir / filename
    key = str(lock_path.resolve())
    if _held_locks.get(key):
        _held_locks[key] += 1
        try:
            yield None
        finally:
            _held_locks[key] -= 1
        return

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    f = open(lock_path, "a")
    start_time = time.time()
    acquired = False
    try:
        while True:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                if not blocking:
                    raise BlockingIOError("busy: lock held by another process")
                if (time.time() - start_time) >= timeout:
                    raise TimeoutError(f"Could not acquire {filename} after {timeout}s: held by another process")
                time.sleep(0.05)
        _held_locks[key] = 1
        yield f
    finally:
        if acquired:
            _held_locks.pop(key, None)
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        f.close()


@contextmanager
def search_lock(cfg, timeout: float = 60.0, blocking: bool = True):
    """The paper index's lock, taken by every build: the watcher's and `planner search index`."""
    with named_lock(cfg, "search.lock", timeout, blocking) as f:
        yield f
