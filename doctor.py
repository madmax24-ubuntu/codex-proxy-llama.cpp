#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def get_json(url: str, timeout: float = 10) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    if os.environ.get("LLAMA_API_KEY"):
        headers["Authorization"] = f"Bearer {os.environ['LLAMA_API_KEY']}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def fail(message: str) -> None:
    raise RuntimeError(message)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a codex-proxy-llama.cpp installation")
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", str(Path.home() / ".codex-llama")))
    parser.add_argument("--require-proxy", action="store_true")
    args = parser.parse_args()
    root = Path(args.codex_home).expanduser().resolve()
    try:
        state = load_json(root / "install-state.json")
        catalog = load_json(root / "model_catalog.json")
        model = catalog["models"][0]
        for name in ("config.toml", "model_catalog.json", "proxy.js", "env.cmd", "env.sh"):
            if not (root / name).exists():
                fail(f"missing file: {root / name}")
        test = subprocess.run(["node", str(root / "proxy.js"), "--selftest"], capture_output=True, text=True, timeout=30)
        if test.returncode:
            fail(test.stderr.strip() or test.stdout.strip() or "proxy self-test failed")
        upstream = str(state["upstream"]).rstrip("/")
        models = get_json(f"{upstream}/v1/models")
        live_model = next((item for item in models.get("data", []) if str(item.get("id")) == state["model"]), None)
        if not live_model:
            fail(f"model {state['model']!r} is absent from /v1/models")
        live_context = int(live_model.get("meta", {}).get("n_ctx") or state["live_context"])
        effective = int(model["context_window"]) * int(model["effective_context_window_percent"]) // 100
        if effective > live_context:
            fail(f"Codex effective context {effective} exceeds llama.cpp n_ctx {live_context}")
        proxy_url = f"http://{state['proxy_host']}:{state['proxy_port']}"
        proxy_status = "not running"
        try:
            health = get_json(f"{proxy_url}/health", timeout=2)
            if not health.get("ok"):
                fail("proxy health returned ok=false")
            proxy_status = f"healthy, version {health.get('version')}"
        except (OSError, urllib.error.URLError):
            if args.require_proxy:
                fail(f"proxy is not reachable at {proxy_url}")
        print(test.stdout.strip())
        print(f"llama.cpp: healthy; model={state['model']}; n_ctx={live_context}")
        print(f"Codex: effective_context={effective}; auto_compact={model['auto_compact_token_limit']}")
        print(f"Proxy: {proxy_status}; url={proxy_url}")
        print("PASS")
        return 0
    except (OSError, KeyError, IndexError, TypeError, ValueError, RuntimeError, json.JSONDecodeError, urllib.error.URLError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
