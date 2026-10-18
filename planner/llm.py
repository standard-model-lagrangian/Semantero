import json
import os
import re
import sys
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

SECRETS = Path(__file__).resolve().parent.parent / "secrets.toml"

# OpenAI-compatible hosts: provider -> (base url, env var / secrets.toml key holding the API key)
OPENAI_COMPAT = {
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "fireworks": ("https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY"),
    "together": ("https://api.together.xyz/v1", "TOGETHER_API_KEY"),
    "deepinfra": ("https://api.deepinfra.com/v1/openai", "DEEPINFRA_API_KEY"),
    "cerebras": ("https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
}


class LLMError(RuntimeError):
    pass


def chat_json(model_spec: str, system: str, user: str, schema: dict, models_cfg: dict) -> dict:
    """One structured-output call. model_spec is "provider:model", e.g. "ollama:qwen3:8b"."""
    provider, _, model = model_spec.partition(":")
    if provider == "ollama":
        return _ollama(model, system, user, schema, models_cfg)
    if provider in OPENAI_COMPAT:
        return _openai_compat(provider, model, system, user, schema, models_cfg)
    if provider == "anthropic":
        return _anthropic(model, system, user, schema, models_cfg)
    raise LLMError(f"provider {provider!r} not implemented yet")


def _ollama(model: str, system: str, user: str, schema: dict, cfg: dict) -> dict:
    url = cfg.get("ollama_url", "http://localhost:11434").rstrip("/") + "/api/chat"
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "format": schema,
        "stream": False,
        "options": {
            "temperature": 0,
            "num_ctx": cfg.get("num_ctx", 8192),
            # Caps runaway reasoning loops; a capped reply fails to parse and the caller retries.
            "num_predict": cfg.get("num_predict", 4096),
        },
    }
    if "ollama_think" in cfg:
        body["think"] = cfg["ollama_think"]
        if cfg["ollama_think"]:
            # Qwen3 loops under greedy decoding in thinking mode; use its recommended sampling.
            body["options"].update(temperature=0.6, top_p=0.95, top_k=20)
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=cfg.get("timeout_s", 600)) as resp:
            data = json.load(resp)
    except TimeoutError as e:
        raise LLMError(f"Ollama timed out after {cfg.get('timeout_s', 600)}s") from e
    except urllib.error.URLError as e:
        raise LLMError(
            f"can't reach Ollama at {url} ({e}). Is it running? "
            f"Install with `brew install ollama`, start with `ollama serve`, then `ollama pull {model}`."
        ) from e
    try:
        return json.loads(data["message"]["content"])
    except (KeyError, json.JSONDecodeError) as e:
        raise LLMError(f"model returned unparseable output: {data!r:.500}") from e


def api_key(env_var: str) -> str:
    """Key from the environment, else from secrets.toml (launchd jobs don't see your shell env)."""
    if os.environ.get(env_var):
        return os.environ[env_var]
    if SECRETS.exists():
        key = tomllib.loads(SECRETS.read_text()).get(env_var)
        if key:
            return key
    raise LLMError(f"no API key: set {env_var} in your environment or in {SECRETS}")


def _post(url: str, body: dict, key: str, timeout: int) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
        "User-Agent": "planner/0.1",
    })
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            if e.code == 429 and attempt < 7:
                # Free tiers rate-limit per minute; wait as long as the host asks.
                m = re.search(r"try again in ([\d.]+)s", detail)
                wait = float(e.headers.get("retry-after") or (m.group(1) if m else 20)) + 1
                print(f"   rate limited, waiting {wait:.0f}s", file=sys.stderr, flush=True)
                time.sleep(wait)
                continue
            raise LLMError(f"HTTP {e.code} from {url}: {detail[:500]}") from e
        except (TimeoutError, urllib.error.URLError) as e:
            raise LLMError(f"request to {url} failed: {e}") from e


def _openai_compat(provider: str, model: str, system: str, user: str, schema: dict, cfg: dict) -> dict:
    base, env_var = OPENAI_COMPAT[provider]
    key = api_key(env_var)
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.6 if cfg.get("hosted_think", True) else 0,
        "max_tokens": cfg.get("hosted_max_tokens", 8192),
        "response_format": {"type": "json_schema", "json_schema": {"name": "extraction", "schema": schema}},
    }
    if cfg.get("reasoning_effort") and "gpt-oss" in model:
        body["reasoning_effort"] = cfg["reasoning_effort"]  # gpt-oss: low | medium | high
    timeout = cfg.get("timeout_s", 600)
    try:
        data = _post(base + "/chat/completions", body, key, timeout)
    except LLMError as e:
        if "response_format" not in str(e) and "json_schema" not in str(e):
            raise
        # Model doesn't support strict schemas here: fall back to JSON mode with the schema in the prompt.
        body["response_format"] = {"type": "json_object"}
        body["messages"][0]["content"] = f"{system}\n\nReply with JSON matching this schema:\n{json.dumps(schema)}"
        data = _post(base + "/chat/completions", body, key, timeout)
    try:
        content = data["choices"][0]["message"]["content"]
        # Some hosts inline reasoning as <think>...</think> before the answer.
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
        return json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
        raise LLMError(f"unparseable reply from {provider}: {data!r:.500}") from e


def list_models(provider: str) -> list[str]:
    base, env_var = OPENAI_COMPAT[provider]
    req = urllib.request.Request(base + "/models", headers={
        "Authorization": f"Bearer {api_key(env_var)}", "User-Agent": "planner/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return sorted(m["id"] for m in json.load(resp)["data"])


def _closed(schema: dict) -> dict:
    """Claude structured outputs require additionalProperties: false on every object."""
    if not isinstance(schema, dict):
        return schema
    out = {k: _closed(v) if isinstance(v, dict) else
           [_closed(x) for x in v] if isinstance(v, list) else v for k, v in schema.items()}
    if out.get("type") == "object":
        out["additionalProperties"] = False
    return out


def _anthropic(model: str, system: str, user: str, schema: dict, cfg: dict) -> dict:
    try:
        import anthropic  # only the weekly review needs the SDK; run via .venv/bin/python
    except ImportError as e:
        raise LLMError("the anthropic SDK isn't installed; run with .venv/bin/python") from e
    client = anthropic.Anthropic(api_key=api_key("ANTHROPIC_API_KEY"), max_retries=4)
    params = dict(
        model=model,
        max_tokens=32000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"effort": cfg.get("weekly_effort", "high"),
                       "format": {"type": "json_schema", "schema": _closed(schema)}},
    )
    try:
        # Long inputs and high max_tokens: stream so the request can't hit an HTTP timeout.
        if model.startswith("claude-haiku"):
            # Haiku has no server-side refusal fallback; a decline surfaces as stop_reason "refusal".
            with client.messages.stream(**params) as stream:
                resp = stream.get_final_message()
        else:
            # On a safety-classifier decline, the API reruns the request on a suitable model.
            with client.beta.messages.stream(**params, betas=["server-side-fallback-2026-07-01"],
                                             fallbacks="default") as stream:
                resp = stream.get_final_message()
    except anthropic.AuthenticationError as e:
        raise LLMError(f"Anthropic rejected the API key: {e}") from e
    except anthropic.APIStatusError as e:
        raise LLMError(f"Anthropic API error {e.status_code}: {e}") from e
    except anthropic.APIConnectionError as e:
        raise LLMError(f"can't reach the Anthropic API: {e}") from e
    if resp.stop_reason == "refusal":
        raise LLMError(f"Claude declined the request: {resp.stop_details}")
    if resp.stop_reason == "max_tokens":
        raise LLMError("Claude hit max_tokens before finishing the JSON")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(f"unparseable reply from Claude: {text[:500]}") from e
