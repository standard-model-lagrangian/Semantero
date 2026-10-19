"""Setup checks with no model calls: permissions, the Python environment, and endpoint staleness.

Each check returns a Result; failed ones become warning lines at the top of the daily brief.
Network checks only list models or tags, they never generate anything.
"""
import json
import os
import stat
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

from .config import ROOT
from .llm import OPENAI_COMPAT, SECRETS, LLMError, list_models

from .vault import future_notes, logical_today

REBUILD = 'cd "{root}" && rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install anthropic'
JOBS = ["com.planner.morning", "com.planner.weekly"]


@dataclass
class Result:
    name: str
    ok: bool
    message: str = ""   # one line, shown in the brief when not ok; includes the fix


def _check(name, fn) -> Result:
    try:
        return fn() or Result(name, True)
    except Exception as e:  # a crashing check must never take the brief down with it
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
                      "macOS is blocking the planner from your vault. In System Settings → Privacy & Security → "
                      "Files and Folders (or Full Disk Access), allow python3 / zsh, then run `planner doctor`.")
    return None


def check_future_notes(cfg, today: date) -> Result | None:
    bad = future_notes(cfg.daily_dir, today)
    if bad:
        names = ", ".join(p.name for p in bad)
        return Result("future notes", False,
                      f"{names} is dated in the future, so it's skipped. Rename it to the day it belongs to.")
    return None


def check_secrets_mode(cfg) -> Result | None:
    if SECRETS.exists() and SECRETS.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        return Result("secrets.toml", False, f"secrets.toml is readable by other users; run: chmod 600 \"{SECRETS}\"")
    return None


def check_jobs(cfg) -> Result | None:
    missing = [j for j in JOBS
               if subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{j}"], capture_output=True).returncode]
    if missing:
        return Result("launchd jobs", False,
                      f"Not scheduled: {', '.join(missing)}. Reload with: launchctl bootstrap gui/$(id -u) "
                      f"~/Library/LaunchAgents/<job>.plist")
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


def check_sdk(cfg) -> Result | None:
    if not cfg.models.get("weekly", "").startswith("anthropic:"):
        return None
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return Result("anthropic SDK", False,
                      f"The anthropic package is missing, so the weekly review will fail. Fix: {REBUILD.format(root=ROOT)}")
    return None


# ── endpoint staleness ─────────────────────────────────────────────────────────

def check_hosted_extract(cfg) -> Result | None:
    provider, _, model = cfg.models["extract"].partition(":")
    if provider not in OPENAI_COMPAT:
        return None
    try:
        available = list_models(provider)
    except LLMError as e:
        return Result("extract model", False, f"{provider} key problem: {e}. Update it in secrets.toml.")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return Result("extract model", False, f"{provider} rejected the API key (HTTP {e.code}); replace it in secrets.toml.")
        return Result("extract model", False, f"{provider} model list failed (HTTP {e.code}); extraction may fall back to local.")
    except (urllib.error.URLError, TimeoutError, OSError):
        return None  # offline; the online gate handles this
    if model not in available:
        return Result("extract model", False,
                      f"{provider} no longer lists `{model}`, so extraction is using the local fallback. "
                      f"Pick a replacement with `planner models {provider}` and update `extract` in config.toml.")
    return None


def check_weekly_model(cfg) -> Result | None:
    provider, _, model = cfg.models.get("weekly", "").partition(":")
    if provider != "anthropic":
        return None
    try:
        import anthropic
    except ImportError:
        return None  # reported by check_sdk
    from .llm import api_key
    try:
        info = anthropic.Anthropic(api_key=api_key("ANTHROPIC_API_KEY"), max_retries=1).models.retrieve(model)
    except LLMError as e:
        return Result("weekly model", False, f"{e}")
    except anthropic.AuthenticationError:
        return Result("weekly model", False, "Anthropic rejected the API key; replace ANTHROPIC_API_KEY in secrets.toml.")
    except anthropic.NotFoundError:
        return Result("weekly model", False,
                      f"Anthropic no longer serves `{model}`; set `weekly` in config.toml to a current model.")
    except anthropic.APIConnectionError:
        return None  # offline; the online gate handles this
    if info.deprecated_at or getattr(info, "lifecycle", "active") not in (None, "active"):
        when = f" (deprecated {info.deprecated_at:%d %b %Y})" if info.deprecated_at else ""
        return Result("weekly model", False,
                      f"`{model}` is marked {info.lifecycle}{when}; switch `weekly` in config.toml before it's retired.")
    return None


def check_local_fallback(cfg) -> Result | None:
    provider, _, model = cfg.models.get("extract_fallback", "").partition(":")
    if provider != "ollama":
        return None
    url = cfg.models.get("ollama_url", "http://localhost:11434").rstrip("/") + "/api/tags"
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            names = {m["name"] for m in json.load(r)["models"]}
    except (urllib.error.URLError, TimeoutError, OSError):
        return Result("local fallback", False,
                      "Ollama isn't running, so there's no offline fallback. Fix: brew services start ollama")
    if model not in names and f"{model}:latest" not in names:
        return Result("local fallback", False, f"Ollama doesn't have `{model}`. Fix: ollama pull {model}")
    return None


def check_recent_fallbacks(cfg, sides: list[dict], today: date) -> Result | None:
    """Notes from the last week that the primary model failed on (they were extracted by the fallback)."""
    cutoff = (today - timedelta(days=7)).isoformat()
    fell_back = [s["date"] for s in sides if s["date"] >= cutoff and s.get("model") not in (None, cfg.models["extract"])]
    if fell_back:
        return Result("recent extractions", False,
                      f"{len(fell_back)} note(s) this week were extracted by the local fallback "
                      f"({', '.join(d[5:] for d in fell_back)}), so `{cfg.models['extract']}` has been failing.")
    return None


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
    cfg_model = cfg.search.get("model", "qwen3-embedding:0.6b")
    cfg_dims = int(cfg.search.get("dims", 1024))
    idx_model = manifest.get("model")
    idx_dims = manifest.get("dims")

    if idx_model != cfg_model or idx_dims != cfg_dims:
        return Result(
            "search index",
            False,
            f"Search index model/dims ({idx_model}/{idx_dims}) differs from config.toml ({cfg_model}/{cfg_dims}). Run: planner search index --full",
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
        except Exception:
            pass

    return None


def check_search_tools(cfg) -> Result | None:
    if not getattr(cfg, "search", None):
        return None
    import shutil
    if not shutil.which("pdftotext"):
        return Result("search tools", False, "pdftotext is not on PATH. Fix: brew install poppler")

    model = cfg.search.get("model", "qwen3-embedding:0.6b")
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
    except Exception:
        return Result("search tools", False, "Ollama check failed. Fix: brew services start ollama")

    return None


def run(cfg, sides: list[dict], online: bool, today: date | None = None) -> list[Result]:
    today = today or logical_today()
    checks = [
        ("vault access", lambda: check_vault_access(cfg)),
        ("future notes", lambda: check_future_notes(cfg, today)),
        ("secrets.toml", lambda: check_secrets_mode(cfg)),
        ("launchd jobs", lambda: check_jobs(cfg)),
        ("python env", lambda: check_python(cfg)),
        ("anthropic SDK", lambda: check_sdk(cfg)),
        ("local fallback", lambda: check_local_fallback(cfg)),
        ("recent extractions", lambda: check_recent_fallbacks(cfg, sides, today)),
    ]
    if getattr(cfg, "search", None):
        checks += [
            ("search index", lambda: check_search_index(cfg)),
            ("search tools", lambda: check_search_tools(cfg)),
        ]
    if online:
        checks += [("extract model", lambda: check_hosted_extract(cfg)),
                   ("weekly model", lambda: check_weekly_model(cfg))]
    return [_check(name, fn) for name, fn in checks]


def notify(title: str, message: str) -> None:
    """macOS notification, for failures the brief can't show (e.g. the vault itself is unreadable)."""
    msg = message.replace('"', "'")[:220]
    subprocess.run(["osascript", "-e", f'display notification "{msg}" with title "{title}"'], capture_output=True)
