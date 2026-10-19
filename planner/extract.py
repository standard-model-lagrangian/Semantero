import re
from datetime import date

from .config import ROOT
from .llm import LLMError, chat_json
from .vault import sha

PROMPT = (ROOT / "prompts" / "extract.md").read_text()
# Bumped automatically when the prompt changes, so stale sidecars get re-extracted.
PROMPT_VERSION = sha(PROMPT)

TYPES = ["A", "B", "C", "life"]
STATUSES = ["done", "partial", "skipped", "unknown"]

SCHEMA = {
    "type": "object",
    "properties": {
        "flow": {"type": "array", "items": {"type": "string"}},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "kind": {"type": "string", "enum": ["task", "note"]},
                    "type": {"type": "string", "enum": TYPES},
                    "type_from_heading": {"type": "boolean"},
                    "thread": {"type": "string"},
                    "planned": {"type": "boolean"},
                    "status": {"type": "string", "enum": STATUSES},
                    "evidence": {"type": "string"},
                    "est_min": {"type": ["integer", "null"]},
                    "priority": {"type": "string", "enum": ["low", "normal", "high"]},
                },
                "required": ["text", "kind", "type", "type_from_heading", "thread", "planned",
                             "status", "evidence", "est_min", "priority"],
            },
        },
    },
    "required": ["flow", "items"],
}


def user_message(day: date, note: str, threads: list[dict]) -> str:
    if threads:
        lines = "\n".join(f"- {t['id']}: {' | '.join(t['recent_texts'])}" for t in threads)
    else:
        lines = "(none yet)"
    return f"Existing threads (id: recent wording):\n{lines}\n\nDaily note for {day.isoformat()}:\n```\n{note}\n```"


# Category-style ids the small model likes to invent; they merge unrelated work.
GENERIC_THREAD = re.compile(
    r"^(life|misc|other|general|errands?|chores?|admin|lab|coding|todo|tasks?|personal|work)$"
    r"|(^|-)(stuff|misc|to-do|todo|org)(-|$)"
)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def thread_id(s: str) -> str:
    tid = slug(s)
    return "" if GENERIC_THREAD.match(tid) else tid


def normalize(raw: dict) -> dict:
    """Clamp model output to the schema so downstream code can trust it."""
    items = []
    for it in raw.get("items", []):
        text = str(it.get("text", "")).strip()
        if not text:
            continue
        est = it.get("est_min")
        items.append({
            "text": text,
            "kind": it.get("kind") if it.get("kind") in ("task", "note") else "task",
            "type": it.get("type") if it.get("type") in TYPES else "life",
            "type_from_heading": bool(it.get("type_from_heading")),
            "thread": thread_id(str(it.get("thread", ""))),
            "planned": it.get("planned", True) is not False,
            "status": it.get("status") if it.get("status") in STATUSES else "unknown",
            "evidence": str(it.get("evidence", "")),
            "est_min": est if isinstance(est, int) and est > 0 else None,
            "priority": it.get("priority") if it.get("priority") in ("low", "normal", "high") else "normal",
        })
    return {"flow": [str(f) for f in raw.get("flow", [])], "items": items}


def _call(msg: str, models_cfg: dict) -> tuple[dict, bool]:
    try:
        return chat_json(models_cfg["extract"], PROMPT, msg, SCHEMA, models_cfg), models_cfg.get("ollama_think", False)
    except LLMError:
        if not models_cfg.get("ollama_think") or not models_cfg["extract"].startswith("ollama:"):
            raise
        # Reasoning ran away or hit the token cap; a plain answer beats no answer.
        return chat_json(models_cfg["extract"], PROMPT, msg, SCHEMA, {**models_cfg, "ollama_think": False}), False


def extract(day: date, note: str, threads: list[dict], models_cfg: dict) -> dict:
    try:
        return _extract(day, note, threads, models_cfg)
    except LLMError as e:
        fallback = models_cfg.get("extract_fallback")
        if not fallback or fallback == models_cfg["extract"]:
            raise
        print(f"   {models_cfg['extract']} failed ({str(e)[:120]}); using {fallback}", flush=True)
        # The sidecar records the fallback model, so the next run re-extracts it with the primary.
        return _extract(day, note, threads, {**models_cfg, "extract": fallback})


def _extract(day: date, note: str, threads: list[dict], models_cfg: dict) -> dict:
    msg = user_message(day, note, threads)
    for attempt in range(3):
        try:
            raw, thought = _call(msg, models_cfg)
        except LLMError as e:
            # Hosted JSON modes fail intermittently (e.g. Groq json_validate_failed); try again.
            if attempt == 2:
                raise
            if "json_validate_failed" in str(e) and models_cfg.get("reasoning_effort") == "high":
                # gpt-oss at high effort returns an empty answer on some longer notes; medium gets through.
                print("   JSON validation failed at reasoning_effort high; retrying at medium", flush=True)
                models_cfg = {**models_cfg, "reasoning_effort": "medium"}
            continue
        parsed = normalize(raw)
        # Hosted models occasionally answer with an empty list; a note with text is never empty.
        if parsed["items"] or not note.strip():
            break
    return {
        "thinking": thought,
        "date": day.isoformat(),
        "source_hash": sha(note),
        "prompt_version": PROMPT_VERSION,
        "model": models_cfg["extract"],
        **parsed,
    }
