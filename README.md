# codex-proxy-llama.cpp

[![CI](https://github.com/madmax24-ubuntu/codex-proxy-llama.cpp/actions/workflows/ci.yml/badge.svg)](https://github.com/madmax24-ubuntu/codex-proxy-llama.cpp/actions/workflows/ci.yml)

A dependency-free compatibility proxy that connects OpenAI Codex CLI and the Codex IDE extension to a local or remote [llama.cpp](https://github.com/ggml-org/llama.cpp) server through the Responses API.

[Русская документация](docs/README.ru.md)

## Why this exists

Codex expects more than basic OpenAI-compatible chat completions. Agentic sessions use Responses streaming, namespaced MCP tools, freeform tools such as native `apply_patch`, replayable tool history, compaction, reasoning events, and strict SSE framing. This proxy translates those Codex-specific shapes while keeping llama.cpp's native `/v1/responses` transport end to end.

## Features

- Codex namespace tools flattened for llama.cpp and restored in responses.
- Native Codex `apply_patch` bridged through a strict function schema and translated back to a freeform tool call, preserving the IDE diff view.
- Function/custom tool history replay across turns.
- Correct SSE event framing, completion usage normalization, abort propagation, and broken-stream diagnostics.
- Tool-step chatter suppression without hiding the final assistant answer.
- Structured compaction that deterministically preserves the active user request and plan, repairs stale or reasoning-only checkpoints, suppresses compaction reasoning from the UI, and keeps full cold checkpoints.
- Fresh-tail recovery metadata instead of silently reusing a stale checkpoint when compaction output is invalid.
- Persistent project-scoped episodic memory with evidence-gated writes, relevance retrieval, secret redaction, and a bounded prompt footprint.
- Pre-commit validation instructions for agentic sessions.
- Exact effective-context calculation from llama.cpp `n_ctx`.
- Qwen and generic reasoning profiles with configurable budgets.
- Interactive and fully non-interactive Python installer.
- No npm or pip dependencies.

## Requirements

- Node.js 18 or newer.
- Python 3.10 or newer for installation and diagnostics.
- A recent llama.cpp server exposing `/v1/models` and `/v1/responses`.
- A model and chat template capable of reliable tool calling.
- Codex CLI or the Codex IDE extension with custom model-provider support.

The proxy cannot add tool-calling ability to a model that does not have it. Models trained for agentic coding and tool use work best.

## Quick start

Start llama.cpp first. A typical command is:

```bash
llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8080 --ctx-size 32768
```

Clone and run the installer:

```bash
git clone https://github.com/madmax24-ubuntu/codex-proxy-llama.cpp.git
cd codex-proxy-llama.cpp
python install.py
```

The installer probes `/v1/models`, lets you select a model, reads `n_ctx`, finds a free local proxy port, and writes an isolated configuration to `~/.codex-llama` by default.

Start the proxy on Windows:

```powershell
& "$HOME\.codex-llama\start-proxy.cmd"
```

The Windows launcher supervises the proxy process. A single delayed health check does not restart it: recovery requires six consecutive failures plus a final ten-second probe. Actual process exits are restarted immediately.

Compaction deterministically separates the newest user intent from system, developer, `AGENTS.md`, environment, and interruption envelopes. Short confirmations remain attached to the preceding actionable request. The proxy also reports a compact PATH capability baseline to the model and directs it to discover installed tools before creating replacement scripts or downloading software.

After compaction, newer user messages override the checkpoint baseline. A confirmation such as “continue” inherits the actionable task recorded in the checkpoint instead of replacing it.

In another PowerShell window, start Codex with the generated home:

```powershell
$env:CODEX_HOME = "$HOME\.codex-llama"
codex
```

On Linux or macOS:

```bash
~/.codex-llama/start-proxy.sh
```

Then in another shell:

```bash
export CODEX_HOME="$HOME/.codex-llama"
codex
```

For the IDE extension, set `CODEX_HOME` before launching the IDE from that terminal.

## Non-interactive installation

```bash
python install.py \
  --upstream http://127.0.0.1:8080 \
  --model qwen-model-id \
  --profile qwen \
  --language Russian \
  --codex-home ~/.codex-llama \
  --non-interactive
```

Configure a server that is currently offline:

```bash
python install.py \
  --upstream http://127.0.0.1:8080 \
  --model local-model \
  --context-window 32768 \
  --profile generic \
  --skip-probe \
  --non-interactive
```

Use `--dry-run` to inspect the calculated settings without writing files. Use `--force` to back up existing generated files before replacement.

## Context calculation

Codex applies `effective_context_window_percent` to the catalog context size. The installer reverse-calculates the advertised value so the effective value is an exact safe target at or below llama.cpp's live `n_ctx`.

For example:

```text
llama.cpp n_ctx:      120064
advertised to Codex:  126316
effective percent:        95
Codex effective:      120000
```

The auto-compaction threshold stays below the effective limit to leave room for reasoning and the response.

## Qwen profile

The Qwen profile enables `enable_thinking` and `preserve_thinking` template arguments, maps stale Codex `high` effort to `xhigh`, uses bounded reasoning budgets, disables thinking during compaction, and serializes tool calls for parser reliability.

The generic profile does not inject model-specific chat-template arguments or reasoning budgets.

## Authentication

For an authenticated llama.cpp endpoint, set the key only in the environment before starting the proxy:

```bash
export LLAMA_API_KEY="your-secret"
```

On PowerShell:

```powershell
$env:LLAMA_API_KEY = "your-secret"
```

The installer never writes the key to disk. The proxy forwards it as a Bearer token.
The installer and doctor also use `LLAMA_API_KEY` when probing the upstream.

Text input is declared by default. Pass `--vision` when the selected model and llama.cpp multimodal projector support image input; live probing also recognizes `multimodal` or `vision` capabilities reported by the server.

## Diagnostics

```bash
python doctor.py --codex-home ~/.codex-llama
```

Require the proxy itself to be running:

```bash
python doctor.py --codex-home ~/.codex-llama --require-proxy
```

Run repository tests:

```bash
node proxy.js --selftest
python -m unittest discover -s tests -v
```

## Generated files

The installer creates:

- `config.toml`
- `model_catalog.json`
- `mcp_supervisor.js`
- `proxy.js`
- `proxy_watchdog.ps1`
- `env.cmd` and `env.sh`
- `start-proxy.cmd` and `start-proxy.sh`
- `install-state.json`
- `checkpoints/`
- `memory/`

## Episodic memory

The proxy automatically remembers a completed task only when its history contains test or commit evidence. Memories are isolated by workspace, deduplicated, redacted before writing, and reused in later sessions only when their terms overlap the current request. At most three entries and 1200 characters are injected once per task; memory injection is suppressed after compaction and when the user reports that an earlier result regressed or failed.

By default data is stored atomically in readable `memory/memory.json`, with a second `memory-backup.json` export. Set `CODEX_MEMORY_BACKEND=sqlite` to use the built-in `node:sqlite` backend on a Node.js version that provides it.

## Resilient MCP servers

`mcp_supervisor.js` keeps the Codex stdio transport alive when an MCP child process exits, restarts the child with bounded exponential backoff, performs a fresh MCP handshake, and preserves future tool calls. Interrupted read-only calls are retried once when the server advertises `readOnlyHint`; pass `--retry-inflight` only for servers whose calls are safe to repeat.

```toml
[mcp_servers.example]
command = "node"
args = ["/path/to/mcp_supervisor.js", "--", "node", "/path/to/server.js"]

[mcp_servers.example.env]
MCP_SUPERVISOR_NAME = "example"
MCP_SUPERVISOR_LOG = "/path/to/mcp-example.log"
MCP_SUPERVISOR_REQUEST_TIMEOUT_MS = "300000"
```

For a read-only server, add `"--retry-inflight"` before `"--"`. Prefer launching the installed server entry point directly instead of keeping `npx` in the long-running process chain.

The supervisor aggregates paginated `tools/list` responses before returning the catalog to Codex and infers `readOnlyHint: true` for safe read-only tools when the upstream server omits annotations. This prevents non-interactive environments (`approval = "never"`) from silently hiding or blocking MCP tools. MCP resource listing is separate from callable tool discovery, so an empty resource list does not mean the server has no tools.

The generated Codex configuration disables deferred MCP discovery for local models and leaves `tool_mode` unset. This keeps callable MCP namespaces visible to non-OpenAI models on current Codex builds. Restart Codex after changing these settings; an already-running or resumed legacy thread can retain its old tool catalog.

Inspect or remove entries:

```bash
node proxy.js --memory-list
node proxy.js --memory-list /path/to/project
node proxy.js --memory-forget MEMORY_ID
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `LLAMA_UPSTREAM` | llama.cpp origin | `http://127.0.0.1:8080` |
| `LLAMA_API_KEY` | Optional upstream Bearer token | empty |
| `CODEX_MODEL` | Upstream model id | `llm` |
| `CODEX_PROXY_HOST` | Proxy listen address | `127.0.0.1` |
| `CODEX_PROXY_PORT` | Proxy listen port | `8181` |
| `CODEX_THINKING_MODE` | `auto`, `qwen`, `generic`, `on`, or `off` | `auto` |
| `CODEX_REASONING_LEVELS` | Comma-separated supported levels | `low,medium,high` |
| `CODEX_FORCE_SERIAL_TOOL_CALLS` | Force serial tool calls | `1` |
| `CODEX_UPSTREAM_RETRY_ATTEMPTS` | Reconnect attempts before an uncommitted response fails | `30` |
| `CODEX_UPSTREAM_RETRY_BASE_MS` | Initial reconnect delay | `1000` |
| `CODEX_UPSTREAM_RETRY_MAX_MS` | Maximum reconnect delay | `10000` |
| `CODEX_UPSTREAM_IDLE_TIMEOUT_MS` | Reconnect when upstream sends no data for this interval | `300000` |
| `CODEX_DOWNSTREAM_HEARTBEAT_MS` | Emit Responses events while llama.cpp is still processing | `30000` |
| `CODEX_REPEAT_GUARD_THRESHOLD` | Force a new strategy after equivalent consecutive tool results | `3` |
| `CODEX_COMPACT_MAX_OUTPUT_TOKENS` | Compaction output cap | `4096` |
| `CODEX_COMPACT_TASK_ANCHOR_MAX_CHARS` | Maximum authoritative active-task text preserved in every checkpoint | `8000` |
| `CODEX_POST_COMPACT_OLD_USER_TOKEN_LIMIT` | Token budget for superseded user requests kept after compaction | `0` |
| `CODEX_POST_COMPACT_TOOL_OUTPUT_MAX_CHARS` | Maximum retained characters in each older tool output after compaction | `4000` |
| `CODEX_POST_COMPACT_TOOL_OUTPUT_KEEP_RECENT` | Recent tool outputs kept in full after compaction | `2` |
| `CODEX_FORWARD_TOOL_PROGRESS` | Forward concise assistant updates before tool calls | `1` |
| `CODEX_PROGRESS_MAX_CHARS` | Maximum length of a forwarded tool-progress update | `1200` |
| `CODEX_CHECKPOINT_DIR` | Cold-checkpoint directory | `./checkpoints` |
| `CODEX_MEMORY_ENABLED` | Enable persistent episodic memory | `1` |
| `CODEX_MEMORY_DIR` | Episodic-memory directory | `./memory` |
| `CODEX_MEMORY_BACKEND` | `json` or optional built-in `sqlite` storage | `json` |
| `CODEX_MEMORY_MAX_ITEMS` | Maximum retrieved entries per request | `3` |
| `CODEX_MEMORY_MAX_CHARS` | Maximum injected memory characters | `1200` |
| `CODEX_PROXY_DIAG` | Diagnostic log path | `./proxy.log` |

See the generated `env.cmd` or `env.sh` for the complete selected profile.

## Security

The proxy binds to loopback by default. Do not expose it to an untrusted network without authentication and a TLS reverse proxy. Tool calls are executed by Codex under its configured sandbox and approval policy, not by this proxy.

## Compatibility

The project tracks current Codex Responses behavior and recent llama.cpp server builds. Both projects evolve quickly, so include the Codex version, llama.cpp build, model id, and `proxy.log` excerpts in bug reports.

## License

MIT
