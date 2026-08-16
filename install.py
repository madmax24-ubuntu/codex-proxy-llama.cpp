#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


VERSION = "1.0.2"
MARKER = "generated_by_codex_proxy_llama_cpp"


@dataclass
class Settings:
    upstream: str
    model: str
    display_name: str
    codex_home: Path
    proxy_host: str
    proxy_port: int
    live_context: int
    usable_context: int
    advertised_context: int
    effective_percent: int
    auto_compact: int
    profile: str
    language: str
    reasoning_effort: str
    reasoning_levels: list[str]
    thinking_mode: str
    reasoning_budgets: dict[str, int]
    input_modalities: list[str]


def request_json(url: str, timeout: float = 10) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    if os.environ.get("LLAMA_API_KEY"):
        headers["Authorization"] = f"Bearer {os.environ['LLAMA_API_KEY']}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def normalize_upstream(value: str) -> str:
    value = value.strip().rstrip("/")
    if value.endswith("/v1"):
        value = value[:-3]
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("upstream must be an http(s) URL such as http://127.0.0.1:8080")
    if parsed.path not in {"", "/"}:
        raise ValueError("upstream must not contain a path; /v1 is added automatically")
    return value.rstrip("/")


def probe_models(upstream: str) -> list[dict[str, Any]]:
    payload = request_json(f"{upstream}/v1/models")
    models = payload.get("data")
    if not isinstance(models, list) or not models:
        raise RuntimeError("/v1/models returned no models")
    return [item for item in models if isinstance(item, dict)]


def model_context(model: dict[str, Any]) -> int:
    values = [
        model.get("meta", {}).get("n_ctx") if isinstance(model.get("meta"), dict) else None,
        model.get("context_window"),
        model.get("max_model_len"),
    ]
    for value in values:
        try:
            number = int(value)
            if number > 0:
                return number
        except (TypeError, ValueError):
            pass
    return 0


def advertised_for_exact_effective(target: int, percent: int) -> int:
    candidate = math.ceil(target * 100 / percent)
    while math.floor(candidate * percent / 100) > target:
        candidate -= 1
    while math.floor((candidate + 1) * percent / 100) <= target:
        candidate += 1
    return candidate


def available_port(host: str, preferred: int) -> int:
    for port in range(preferred, preferred + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"no free port found in range {preferred}-{preferred + 99}")


def prompt(label: str, default: str) -> str:
    answer = input(f"{label} [{default}]: ").strip()
    return answer or default


def choose_model(models: list[dict[str, Any]], requested: str | None, interactive: bool) -> dict[str, Any]:
    if requested:
        match = next((item for item in models if str(item.get("id")) == requested), None)
        if not match:
            ids = ", ".join(str(item.get("id")) for item in models)
            raise ValueError(f"model {requested!r} was not found; available: {ids}")
        return match
    if len(models) == 1 or not interactive:
        return models[0]
    print("Available models:")
    for index, item in enumerate(models, 1):
        context = model_context(item)
        suffix = f", n_ctx={context}" if context else ""
        print(f"  {index}. {item.get('id')}{suffix}")
    selected = int(prompt("Model number", "1"))
    if selected < 1 or selected > len(models):
        raise ValueError("model number is out of range")
    return models[selected - 1]


def detect_profile(model_id: str, requested: str) -> str:
    if requested != "auto":
        return requested
    return "qwen" if "qwen" in model_id.lower() else "generic"


def profile_defaults(profile: str) -> tuple[list[str], str, str, dict[str, int]]:
    if profile == "qwen":
        return ["low", "medium", "xhigh"], "xhigh", "qwen", {"low": 1024, "medium": 4096, "high": 0, "xhigh": 6144}
    return ["low", "medium", "high"], "high", "generic", {"low": 0, "medium": 0, "high": 0, "xhigh": 0}


def toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def language_instruction(language: str) -> str:
    if not language:
        return ""
    return (
        f"Always communicate with the user in {language}. Never switch languages because code, logs, tools, or "
        f"documentation use another language. Preserve code, commands, identifiers, paths, and exact errors as written."
    )


def render_config(settings: Settings) -> str:
    catalog_path = settings.codex_home / "model_catalog.json"
    provider = "llamacpp_proxy"
    compact_prompt = (
        "Create a dense continuation checkpoint for the next model. Preserve the current user request, exact progress, "
        "changed files, tests, decisions, constraints, errors, identifiers, numeric limits, and the next concrete action. "
        "Merge still-relevant facts from older checkpoints. Do not expose chain-of-thought. Do not call tools or continue "
        "implementation. Output only the checkpoint."
    )
    lines = [
        f"# {MARKER} = {toml_string(VERSION)}",
        f"model = {toml_string(settings.model)}",
        f"model_provider = {toml_string(provider)}",
        f"model_catalog_json = {toml_string(str(catalog_path))}",
        f"model_reasoning_effort = {toml_string(settings.reasoning_effort)}",
        'model_reasoning_summary = "none"',
        "model_supports_reasoning_summaries = false",
        "hide_agent_reasoning = true",
        "show_raw_agent_reasoning = false",
        "suppress_unstable_features_warning = true",
        f"model_context_window = {settings.advertised_context}",
        f"model_auto_compact_token_limit = {settings.auto_compact}",
        'model_auto_compact_token_limit_scope = "total"',
        "tool_output_token_limit = 20000",
        f"developer_instructions = {toml_string(language_instruction(settings.language))}",
        f"compact_prompt = {toml_string(compact_prompt)}",
        'web_search = "disabled"',
        "",
        "[features]",
        "apply_patch_streaming_events = true",
        "enable_request_compression = false",
        "multi_agent = false",
        "shell_snapshot = false",
        "",
        f"[model_providers.{provider}]",
        'name = "Local model via llama.cpp compatibility proxy"',
        f"base_url = {toml_string(f'http://{settings.proxy_host}:{settings.proxy_port}/v1')}",
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "supports_websockets = false",
        "request_max_retries = 2",
        "stream_max_retries = 0",
        "stream_idle_timeout_ms = 900000",
        "",
    ]
    if os.name == "nt":
        lines.extend(["[windows]", 'sandbox = "elevated"', ""])
    return "\n".join(lines)


def base_instructions(language: str) -> str:
    language_rule = language_instruction(language)
    return (
        "You are an autonomous senior software engineer. Complete the user's task, use tools proactively, preserve "
        "unrelated changes, and verify the exact behavior you change. Use the dedicated apply_patch tool for localized "
        "text and source edits; never invoke apply_patch through a shell tool. Never finish with only a promise or progress "
        "sentence when a tool can advance the task. " + language_rule
    ).strip()


def render_catalog(settings: Settings) -> str:
    levels = [
        {"effort": level, "description": f"{level} reasoning effort"}
        for level in settings.reasoning_levels
    ]
    model = {
        "slug": settings.model,
        "display_name": settings.display_name,
        "name": settings.model,
        "model": settings.model,
        "provider": "llamacpp_proxy",
        "context_window": settings.advertised_context,
        "truncation_policy": {"mode": "tokens", "limit": 20000},
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": True,
        "priority": 0,
        "base_instructions": base_instructions(settings.language),
        "supports_tools": True,
        "supports_parallel_tool_calls": False,
        "experimental_supported_tools": [],
        "supports_reasoning_summaries": False,
        "support_verbosity": False,
        "default_reasoning_level": settings.reasoning_effort,
        "supported_reasoning_levels": levels,
        "input_modalities": settings.input_modalities,
        "supports_image_detail_original": False,
        "max_context_window": settings.advertised_context,
        "auto_compact_token_limit": settings.auto_compact,
        "effective_context_window_percent": settings.effective_percent,
        "apply_patch_tool_type": "freeform",
        "default_reasoning_summary": "none",
    }
    return json.dumps({"models": [model]}, ensure_ascii=False, indent=2) + "\n"


def proxy_environment(settings: Settings) -> dict[str, str]:
    values = {
        "LLAMA_UPSTREAM": settings.upstream,
        "CODEX_MODEL": settings.model,
        "CODEX_PROXY_HOST": settings.proxy_host,
        "CODEX_PROXY_PORT": str(settings.proxy_port),
        "CODEX_THINKING_MODE": settings.thinking_mode,
        "CODEX_REASONING_LEVELS": ",".join(settings.reasoning_levels),
        "CODEX_DEFAULT_REASONING_EFFORT": settings.reasoning_effort,
        "CODEX_REASONING_HIGH_MAP": "xhigh" if settings.profile == "qwen" else "high",
        "CODEX_REASONING_BUDGET_LOW": str(settings.reasoning_budgets["low"]),
        "CODEX_REASONING_BUDGET_MEDIUM": str(settings.reasoning_budgets["medium"]),
        "CODEX_REASONING_BUDGET_HIGH": str(settings.reasoning_budgets["high"]),
        "CODEX_REASONING_BUDGET_XHIGH": str(settings.reasoning_budgets["xhigh"]),
        "CODEX_COMPACT_MAX_OUTPUT_TOKENS": "2048",
        "CODEX_COMPACT_REASONING_BUDGET": "0",
        "CODEX_FORCE_SERIAL_TOOL_CALLS": "1",
        "CODEX_CHECKPOINT_DIR": str(settings.codex_home / "checkpoints"),
        "CODEX_PROXY_DIAG": str(settings.codex_home / "proxy.log"),
    }
    return values


def render_env_cmd(settings: Settings) -> str:
    lines = ["@echo off", f'set "CODEX_HOME={settings.codex_home}"']
    lines.extend(f'set "{key}={value}"' for key, value in proxy_environment(settings).items())
    return "\r\n".join(lines) + "\r\n"


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def render_env_sh(settings: Settings) -> str:
    lines = ["#!/usr/bin/env sh", f"export CODEX_HOME={shell_quote(str(settings.codex_home))}"]
    lines.extend(f"export {key}={shell_quote(value)}" for key, value in proxy_environment(settings).items())
    return "\n".join(lines) + "\n"


def render_start_cmd(settings: Settings) -> str:
    return (
        "@echo off\r\n"
        "call \"%~dp0env.cmd\"\r\n"
        "node \"%CODEX_HOME%\\proxy.js\" --selftest || exit /b 1\r\n"
        "node \"%CODEX_HOME%\\proxy.js\"\r\n"
    )


def render_start_sh(settings: Settings) -> str:
    return (
        "#!/usr/bin/env sh\n"
        ". \"$(dirname \"$0\")/env.sh\"\n"
        "node \"$CODEX_HOME/proxy.js\" --selftest || exit 1\n"
        "exec node \"$CODEX_HOME/proxy.js\"\n"
    )


def backup(path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    destination = path.with_name(f"{path.name}.backup-{stamp}")
    shutil.copy2(path, destination)
    return destination


def write_install(settings: Settings, force: bool, dry_run: bool) -> list[Path]:
    source_proxy = Path(__file__).resolve().with_name("proxy.js")
    if not source_proxy.exists():
        raise FileNotFoundError(f"proxy.js not found next to installer: {source_proxy}")
    files: dict[Path, str | bytes] = {
        settings.codex_home / "config.toml": render_config(settings),
        settings.codex_home / "model_catalog.json": render_catalog(settings),
        settings.codex_home / "proxy.js": source_proxy.read_bytes(),
        settings.codex_home / "env.cmd": render_env_cmd(settings),
        settings.codex_home / "env.sh": render_env_sh(settings),
        settings.codex_home / "start-proxy.cmd": render_start_cmd(settings),
        settings.codex_home / "start-proxy.sh": render_start_sh(settings),
        settings.codex_home / "install-state.json": json.dumps({MARKER: VERSION, **asdict(settings)}, default=str, indent=2) + "\n",
    }
    conflicts = [path for path in files if path.exists()]
    if conflicts and not force:
        names = "\n".join(f"  {path}" for path in conflicts)
        raise FileExistsError(f"installation would overwrite existing files; use --force to back them up:\n{names}")
    if dry_run:
        return list(files)
    settings.codex_home.mkdir(parents=True, exist_ok=True)
    (settings.codex_home / "checkpoints").mkdir(exist_ok=True)
    for path in conflicts:
        backup(path)
    for path, content in files.items():
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8", newline="")
    if os.name != "nt":
        for name in ("env.sh", "start-proxy.sh"):
            (settings.codex_home / name).chmod(0o755)
    return list(files)


def build_settings(args: argparse.Namespace) -> Settings:
    interactive = not args.non_interactive and sys.stdin.isatty()
    upstream = normalize_upstream(args.upstream or (prompt("llama.cpp URL", "http://127.0.0.1:8080") if interactive else "http://127.0.0.1:8080"))
    if args.skip_probe:
        if not args.model or not args.context_window:
            raise ValueError("--skip-probe requires --model and --context-window")
        models = [{"id": args.model, "meta": {"n_ctx": args.context_window}}]
    else:
        models = probe_models(upstream)
    selected = choose_model(models, args.model, interactive)
    model_id = str(selected.get("id") or selected.get("name") or "llm")
    live = args.context_window or model_context(selected)
    if not live:
        if not interactive:
            raise ValueError("context window was not reported; pass --context-window")
        live = int(prompt("llama.cpp context window", "32768"))
    usable_default = max(1024, live - min(64, max(1, live // 1000)))
    usable = args.usable_context or usable_default
    if usable > live:
        raise ValueError(f"usable context {usable} exceeds llama.cpp n_ctx {live}")
    percent = args.effective_percent
    advertised = advertised_for_exact_effective(usable, percent)
    profile = detect_profile(model_id, args.profile)
    if interactive and args.profile == "auto":
        profile = prompt("Model profile (qwen/generic)", profile).lower()
        if profile not in {"qwen", "generic"}:
            raise ValueError("profile must be qwen or generic")
    levels, effort, thinking_mode, budgets = profile_defaults(profile)
    response_reserve = min(max(2048, usable // 8), max(8192, budgets.get(effort, 0) + 1024))
    auto_compact = args.auto_compact or max(1024, usable - response_reserve)
    if auto_compact >= usable:
        raise ValueError("auto-compaction threshold must be lower than usable context")
    port = args.proxy_port if args.proxy_port else available_port(args.proxy_host, 8181)
    codex_home = Path(args.codex_home).expanduser().resolve()
    display_name = args.display_name or f"{model_id} via llama.cpp"
    language = args.language.strip()
    capabilities = {str(value).lower() for value in selected.get("capabilities", [])}
    modalities = ["text", "image"] if args.vision or "multimodal" in capabilities or "vision" in capabilities else ["text"]
    return Settings(upstream, model_id, display_name, codex_home, args.proxy_host, port, live, usable,
                    advertised, percent, auto_compact, profile, language, effort, levels, thinking_mode, budgets, modalities)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Install the Codex compatibility proxy for a llama.cpp server")
    result.add_argument("--upstream", help="llama.cpp origin, for example http://127.0.0.1:8080")
    result.add_argument("--model", help="model id returned by /v1/models")
    result.add_argument("--display-name")
    result.add_argument("--codex-home", default=str(Path.home() / ".codex-llama"))
    result.add_argument("--proxy-host", default="127.0.0.1")
    result.add_argument("--proxy-port", type=int)
    result.add_argument("--context-window", type=int)
    result.add_argument("--usable-context", type=int)
    result.add_argument("--effective-percent", type=int, default=95, choices=range(50, 101), metavar="50..100")
    result.add_argument("--auto-compact", type=int)
    result.add_argument("--profile", choices=["auto", "qwen", "generic"], default="auto")
    result.add_argument("--language", default="")
    result.add_argument("--vision", action="store_true", help="declare image input support in the Codex model catalog")
    result.add_argument("--non-interactive", action="store_true")
    result.add_argument("--skip-probe", action="store_true", help="configure an offline server; requires --model and --context-window")
    result.add_argument("--force", action="store_true", help="back up and replace existing generated files")
    result.add_argument("--dry-run", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    if not shutil.which("node"):
        print("error: Node.js 18+ is required", file=sys.stderr)
        return 2
    try:
        settings = build_settings(args)
        files = write_install(settings, args.force, args.dry_run)
    except (OSError, ValueError, RuntimeError, urllib.error.URLError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    action = "Would write" if args.dry_run else "Installed"
    print(f"{action} {len(files)} files in {settings.codex_home}")
    print(f"Model: {settings.model} ({settings.profile}), llama.cpp n_ctx={settings.live_context}")
    print(f"Codex effective context: {settings.usable_context}; auto-compaction: {settings.auto_compact}")
    print(f"Proxy: http://{settings.proxy_host}:{settings.proxy_port} -> {settings.upstream}")
    if not args.dry_run:
        command = "start-proxy.cmd" if os.name == "nt" else "./start-proxy.sh"
        print(f"Start the proxy with: {settings.codex_home / command}")
        print(f"Set CODEX_HOME={settings.codex_home} before starting Codex")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
