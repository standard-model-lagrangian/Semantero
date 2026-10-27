"""Setup checks (`planner doctor`): vault access, the Python environment, the indexes, the embedding service, the
background jobs and the launcher app. Network checks only ask a service for its health or model list."""
import json
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from . import embed
from .config import ROOT, SearchSettings

REBUILD = 'cd "{root}" && rm -rf .venv && python3 -m venv .venv'
NOTES_JOB = "com.planner.notes"
APP_PATHS = [Path("/Applications/Semantero.app"), Path.home() / "Applications" / "Semantero.app"]


@dataclass
class Result:
    name: str
    ok: bool
    message: str = ""   # one line when not ok; includes the fix


def _check(name, fn) -> Result:
    try:
        return fn() or Result(name, True)
    except Exception as e:  # a crashing check is reported as a failure, never takes doctor down
        return Result(name, False, f"{name} check crashed: {type(e).__name__}: {e}")


# ── permissions ────────────────────────────────────────────────────────────────

def check_vault_access(cfg) -> Result | None:
    try:
        next(iter(cfg.daily_dir.iterdir()), None)
        probe = cfg.data_dir / ".healthcheck"
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        probe.write_text("ok")
        probe.unlink()
    except PermissionError:
        return Result("vault access", False,
                      "macOS is blocking the indexer from your vault. In System Settings → Privacy & Security → "
                      "Files and Folders (or Full Disk Access), allow python3 / zsh, then run `planner doctor`.")
    return None








# ── rebuild issues ─────────────────────────────────────────────────────────────

def check_python(cfg) -> Result | None:
    degraded = os.environ.get("PLANNER_DEGRADED")
    if degraded:
        return Result("python env", False, f"{degraded} Fix: {REBUILD.format(root=ROOT)}")
    venv_py = ROOT / ".venv" / "bin" / "python"
    if not venv_py.exists():
        return Result("python env", False, f"The project .venv is missing. Fix: {REBUILD.format(root=ROOT)}")
    return None




# ── endpoint staleness ─────────────────────────────────────────────────────────









def check_search_index(cfg) -> Result | None:
    if not getattr(cfg, "search", None):
        return None
    search_dir = cfg.data_dir / "search"
    manifest_path = search_dir / "manifest.json"
    if not manifest_path.exists():
        return Result("search index", False, "No search index found. Run: planner search index")

    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception as e:
        return Result("search index", False, f"Failed to read search manifest: {e}. Run: planner search index --full")

    # Check model & dims
    s = SearchSettings.of(cfg)
    cfg_model, cfg_dims = s.model, s.dims
    idx_model = manifest.get("model")
    idx_dims = manifest.get("dims")

    if idx_model != cfg_model or idx_dims != cfg_dims:
        return Result(
            "search index",
            False,
            f"Search index model/dims ({idx_model}/{idx_dims}) differs from config.toml ({cfg_model}/{cfg_dims}). Run: planner search index --full",
        )

    missing = manifest.get("missing_vectors", 0)
    if missing:
        name, start = embed.service(SearchSettings.of(cfg).backend)
        return Result(
            "search index",
            False,
            f"Semantic search is off for {missing} texts ({name} was unavailable when they were indexed); "
            f"keyword search still works. Start it ({start}): the watcher retries hourly, or run: planner search index",
        )

    # Check age (< 3 days old)
    built_at_str = manifest.get("built_at")
    if built_at_str:
        try:
            built_dt = datetime.fromisoformat(built_at_str)
            diff = datetime.now() - built_dt
            if diff > timedelta(days=3):
                return Result(
                    "search index",
                    False,
                    f"Search index is {diff.days} days old (> 3 days). Run: planner search index",
                )
        except (TypeError, ValueError):
            pass

    return None


def check_notes_index(cfg) -> Result | None:
    from . import notesindex
    if not notesindex.notes_enabled(cfg) or not getattr(cfg, "search", None):
        return None
    for g in notesindex.settings(cfg)["exclude"]:
        try:
            notesindex.glob_to_regex(g)
        except ValueError as e:
            return Result("notes index", False, f"Bad [notes] exclude pattern {g!r}: {e}")
    manifest_path = cfg.data_dir / "notes" / "manifest.json"
    if not manifest_path.exists():
        return Result("notes index", False, "No notes index found. Run: planner notes index")
    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception as e:
        return Result("notes index", False, f"Failed to read notes manifest: {e}. Run: planner notes index --full")
    s = SearchSettings.of(cfg)
    cfg_model, cfg_dims = s.model, s.dims
    if manifest.get("model") != cfg_model or manifest.get("dims") != cfg_dims:
        return Result(
            "notes index", False,
            f"Notes index model/dims ({manifest.get('model')}/{manifest.get('dims')}) differs from config.toml "
            f"({cfg_model}/{cfg_dims}). Run: planner notes index --full")
    try:
        age = datetime.now() - datetime.fromisoformat(manifest.get("built_at", ""))
    except (TypeError, ValueError):
        age = None
    if age is not None and age > timedelta(days=1) and manifest.get("degraded"):
        name, start = embed.service(SearchSettings.of(cfg).backend)
        return Result(
            "notes index", False,
            f"Notes index has been degraded for over a day: semantic search is off for "
            f"{manifest.get('missing_vectors', 0)} texts. Start {name} ({start}); the next tick embeds them")
    if age is not None and age > timedelta(days=1):
        return Result("notes index", False, f"Notes index is {age.days} days old (> 1 day). Run: planner notes index")
    return None


def check_launcher_app(cfg) -> Result | None:
    """Informational: the launcher app is optional, so a missing app is a note, never a failure."""
    from . import notesindex
    if not notesindex.notes_enabled(cfg):
        return None
    if any(p.exists() for p in APP_PATHS):
        return Result("launcher app", True)
    return Result("launcher app", True, "Semantero.app is not installed (optional). Build it with: make install-app")


def check_search_tools(cfg) -> Result | None:
    if not getattr(cfg, "search", None):
        return None
    import shutil
    if not shutil.which("pdftotext"):
        return Result("search tools", False, "pdftotext is not on PATH. Fix: brew install poppler")

    s = SearchSettings.of(cfg)
    model = s.model
    if s.backend == "pplx":
        from . import pplx
        h = pplx.health(s.pplx_url)
        if h is None:
            return Result("search tools", False, "The pplx service (com.planner.pplxd) is not running. Fix: bash pplx/install-service.sh")
        if h.get("model") != model:
            return Result("search tools", False, f"The pplx service runs {h.get('model')}, but the index needs {model}. "
                          "Fix: launchctl kickstart -k gui/$(id -u)/com.planner.pplxd")
        return None
    try:
        res = subprocess.run(["ollama", "list"], capture_output=True, text=True, timeout=5)
        if res.returncode == 0:
            lines = res.stdout.splitlines()[1:]  # skip header
            names = [line.split()[0] for line in lines if line.strip()]
            model_base = model.split(":")[0]
            has_model = any(m == model or m.startswith(f"{model_base}:") or m == model_base for m in names)
            if not has_model:
                return Result("search tools", False, f"Ollama list does not include `{model}`. Run: ollama pull {model}")
        else:
            return Result("search tools", False, "Ollama command failed. Fix: brew services start ollama")
    except (OSError, subprocess.SubprocessError) as e:
        return Result("search tools", False, f"Ollama didn't answer `ollama list` ({e}). Fix: brew services start ollama")

    return None


def check_zotero_watch(cfg) -> Result | None:
    if not getattr(cfg, "search", None):
        return None

    # 1. Check com.planner.zotero-watch loaded in launchctl
    proc = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/com.planner.zotero-watch"], capture_output=True)
    if proc.returncode != 0:
        return Result(
            "zotero watch",
            False,
            "Not scheduled: com.planner.zotero-watch. Install with: ./setup-search.sh start"
        )

    # 2. Check 3 consecutive failed builds in logs/zotero-watch.log
    log_file = ROOT / "logs" / "zotero-watch.log"
    if log_file.exists():
        try:
            lines = log_file.read_text().splitlines()
            consecutive_fails = 0
            for line in lines:
                if "build failed" in line:
                    consecutive_fails += 1
                    if consecutive_fails >= 3:
                        return Result(
                            "zotero watch",
                            False,
                            "Zotero watch log has 3 consecutive failed builds. Check logs/zotero-watch.log"
                        )
                elif "build completed" in line or "no changes" in line:
                    consecutive_fails = 0
        except OSError:
            pass

    return None


def check_notes_job(cfg) -> Result | None:
    from . import notesindex
    if not notesindex.notes_enabled(cfg):
        return None
    if subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{NOTES_JOB}"], capture_output=True).returncode:
        return Result("notes job", False,
                      f"Not scheduled: {NOTES_JOB}, which keeps the notes index fresh. Install with: "
                      f"bin/install-launchd.sh {NOTES_JOB}")
    return None


def run(cfg) -> list[Result]:
    checks = [
        ("vault access", lambda: check_vault_access(cfg)),
        ("python env", lambda: check_python(cfg)),
        ("search index", lambda: check_search_index(cfg)),
        ("notes index", lambda: check_notes_index(cfg)),
        ("notes job", lambda: check_notes_job(cfg)),
        ("search tools", lambda: check_search_tools(cfg)),
        ("zotero watch", lambda: check_zotero_watch(cfg)),
        ("launcher app", lambda: check_launcher_app(cfg)),
    ]
    return [_check(name, fn) for name, fn in checks]
