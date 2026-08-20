#!/usr/bin/env node
"use strict";

/*
  Codex <-> llama.cpp Responses compatibility proxy 1.0.3

  Adds support for:
    - Codex namespace tools (MCP) -> flattened function tools for llama.cpp
    - Codex freeform/custom tools (notably apply_patch) -> function tools for llama.cpp
    - reverse translation of calls back to Codex
    - replay/history conversion for namespaced + custom tool calls
    - normalization of Responses system/developer history into one leading instructions block
    - removal of hosted web_search (use MCP web search instead)
    - configurable reasoning-effort passthrough and per-request thinking budgets
    - native Responses transport retained end-to-end (no Responses -> Chat conversion)
    - guarded structured compaction with automatic truncated-summary repair
    - preserves the current real user goal + canonical initial context after compaction
    - removes only older retained user messages, not the live task state
    - JSON cold checkpoints for exact pre-compaction recovery
    - transparent SSE bridge: every downstream JSON chunk is a complete SSE event
    - Codex-compatible response.completed usage normalization
    - safe user-facing progress forwarding without exposing internal reasoning

  No npm packages required.
*/

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VERSION = "1.0.22";
const HOST = process.env.CODEX_PROXY_HOST || "127.0.0.1";
const PORT = Number(process.env.CODEX_PROXY_PORT || "8181");
const UPSTREAM = new URL(process.env.LLAMA_UPSTREAM || "http://127.0.0.1:8080");
const UPSTREAM_API_KEY = process.env.LLAMA_API_KEY || "";
const DEFAULT_MODEL = process.env.CODEX_MODEL || "llm";
const DEBUG = /^(1|true|yes)$/i.test(process.env.CODEX_PROXY_DEBUG || "");
const DIAG_PATH = process.env.CODEX_PROXY_DIAG || path.join(__dirname, "proxy.log");
const POST_COMPACT_OLD_USER_TOKEN_LIMIT = Math.max(0, Number(process.env.CODEX_POST_COMPACT_OLD_USER_TOKEN_LIMIT || "0") || 0);
const POST_COMPACT_TOOL_OUTPUT_MAX_CHARS = Math.max(1000, Number(process.env.CODEX_POST_COMPACT_TOOL_OUTPUT_MAX_CHARS || "4000") || 4000);
const POST_COMPACT_TOOL_OUTPUT_KEEP_RECENT = Math.max(1, Math.min(8, Number(process.env.CODEX_POST_COMPACT_TOOL_OUTPUT_KEEP_RECENT || "2") || 2));
const COMPACT_MAX_OUTPUT_TOKENS = Math.max(1024, Number(process.env.CODEX_COMPACT_MAX_OUTPUT_TOKENS || "4096") || 4096);
const COMPACT_REASONING_EFFORT = String(process.env.CODEX_COMPACT_REASONING_EFFORT || "low").toLowerCase();
const COMPACT_REASONING_BUDGET = Math.max(0, Number(process.env.CODEX_COMPACT_REASONING_BUDGET || "0") || 0);
const FORWARD_TOOL_PROGRESS = !/^(0|false|no)$/i.test(process.env.CODEX_FORWARD_TOOL_PROGRESS || "1");
const PROGRESS_MAX_CHARS = Math.max(120, Number(process.env.CODEX_PROGRESS_MAX_CHARS || "1200") || 1200);
const REASONING_BUDGET_LOW = Math.max(0, Number(process.env.CODEX_REASONING_BUDGET_LOW || "0") || 0);
const REASONING_BUDGET_MEDIUM = Math.max(0, Number(process.env.CODEX_REASONING_BUDGET_MEDIUM || "0") || 0);
const REASONING_BUDGET_HIGH = Math.max(0, Number(process.env.CODEX_REASONING_BUDGET_HIGH || "0") || 0);
const REASONING_BUDGET_XHIGH = Math.max(0, Number(process.env.CODEX_REASONING_BUDGET_XHIGH || "0") || 0);
const DEFAULT_REASONING_EFFORT = String(process.env.CODEX_DEFAULT_REASONING_EFFORT || "high").toLowerCase();
const REASONING_HIGH_MAP = String(process.env.CODEX_REASONING_HIGH_MAP || "high").toLowerCase();
const SUPPORTED_REASONING_LEVELS = new Set(String(process.env.CODEX_REASONING_LEVELS || "low,medium,high")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
const THINKING_MODE = String(process.env.CODEX_THINKING_MODE || "auto").toLowerCase();
const FORCE_SERIAL_TOOL_CALLS = !/^(0|false|no)$/i.test(process.env.CODEX_FORCE_SERIAL_TOOL_CALLS || "1");
const CHECKPOINT_DIR = process.env.CODEX_CHECKPOINT_DIR || path.join(__dirname, "checkpoints");
const MEMORY_DIR = process.env.CODEX_MEMORY_DIR || path.join(__dirname, "memory");
const MEMORY_MAX_ITEMS = Math.max(1, Math.min(8, Number(process.env.CODEX_MEMORY_MAX_ITEMS || "3") || 3));
const MEMORY_MAX_CHARS = Math.max(400, Math.min(4000, Number(process.env.CODEX_MEMORY_MAX_CHARS || "1200") || 1200));
const MEMORY_ENABLED = !/^(0|false|no)$/i.test(process.env.CODEX_MEMORY_ENABLED || "1");
const MEMORY_BACKEND = String(process.env.CODEX_MEMORY_BACKEND || "json").toLowerCase();
const CHECKPOINT_BY_KEY = new Map();
const CHECKPOINT_BY_SUMMARY = new Map();
const MEMORY_INJECTED_TASKS = new Map();
let MEMORY_STORE = null;

function log(...a) { console.log("[codex-llama-proxy]", ...a); }
function debug(...a) { if (DEBUG) console.log("[codex-llama-proxy:debug]", ...a); }
function diag(line) { try { fs.appendFileSync(DIAG_PATH, `[${new Date().toISOString()}] ${line}\n`); } catch { } }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

function safeMkdir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; }
  catch { return false; }
}

const MEMORY_STOP_WORDS = new Set([
  "this", "that", "with", "from", "have", "will", "your", "into", "after", "before", "then", "when", "what",
  "для", "что", "как", "это", "или", "после", "перед", "нужно", "надо", "будет", "были", "есть", "при", "его", "она"
]);

function memorySanitize(value, limit = 1600) {
  return String(value || "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:ghp_|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_.-]{12,}\b/g, "[REDACTED TOKEN]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, "$1$2:[REDACTED]@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function memoryTokens(value) {
  const matches = memorySanitize(value, 12000).toLowerCase().match(/[\p{L}\p{N}_.\/-]{3,}/gu) || [];
  const out = new Set();
  for (const token of matches) {
    if (MEMORY_STOP_WORDS.has(token)) continue;
    out.add(token);
    for (const part of token.split(/[_.\/-]+/)) if (part.length >= 3 && !MEMORY_STOP_WORDS.has(part)) out.add(part);
  }
  return [...out].slice(0, 160);
}

function memoryProject(value) {
  const clean = String(value || "global").trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return /^[a-z]:\//i.test(clean) ? clean.toLowerCase() : clean || "global";
}

class MemoryStore {
  constructor(dir, forceJson = false) {
    this.dir = dir;
    this.jsonPath = path.join(dir, "memory.json");
    this.exportPath = path.join(dir, "memory-backup.json");
    this.db = null;
    this.items = [];
    safeMkdir(dir);
    if (!forceJson && MEMORY_BACKEND === "sqlite") {
      try {
        const { DatabaseSync } = require("node:sqlite");
        this.db = new DatabaseSync(path.join(dir, "memory.db"));
        this.db.exec("CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, project TEXT NOT NULL, problem TEXT NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL, files TEXT NOT NULL, key_terms TEXT NOT NULL, confidence REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0)");
      } catch (err) {
        diag(`MEMORY sqlite unavailable fallback=json error=${err.message}`);
      }
    }
    if (!this.db) this.loadJson();
  }

  loadJson() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.jsonPath, "utf8"));
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.items = [];
    }
  }

  all(limit = 1000) {
    if (this.db) {
      return this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, limit)).map(row => ({
        ...row,
        evidence: JSON.parse(row.evidence || "[]"),
        files: JSON.parse(row.files || "[]"),
        keywords: JSON.parse(row.key_terms || "[]")
      }));
    }
    return this.items.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, limit);
  }

  persistJson() {
    const temp = `${this.jsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.items, null, 2), "utf8");
    fs.renameSync(temp, this.jsonPath);
  }

  exportJson() {
    const temp = `${this.exportPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.all(2000), null, 2), "utf8");
    fs.renameSync(temp, this.exportPath);
  }

  upsert(record) {
    const now = new Date().toISOString();
    const item = {
      ...record,
      project: memoryProject(record.project),
      created_at: record.created_at || now,
      updated_at: now,
      last_used_at: record.last_used_at || null,
      use_count: Number(record.use_count || 0)
    };
    if (this.db) {
      const existing = this.db.prepare("SELECT created_at, use_count, last_used_at FROM memories WHERE id = ?").get(item.id);
      if (existing) {
        item.created_at = existing.created_at;
        item.use_count = Number(existing.use_count || 0);
        item.last_used_at = existing.last_used_at || null;
      }
      this.db.prepare("INSERT INTO memories (id, project, problem, outcome, evidence, files, key_terms, confidence, created_at, updated_at, last_used_at, use_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project=excluded.project, problem=excluded.problem, outcome=excluded.outcome, evidence=excluded.evidence, files=excluded.files, key_terms=excluded.key_terms, confidence=excluded.confidence, updated_at=excluded.updated_at").run(
        item.id, item.project, item.problem, item.outcome, JSON.stringify(item.evidence || []), JSON.stringify(item.files || []), JSON.stringify(item.keywords || []), Number(item.confidence || 0.8), item.created_at, item.updated_at, item.last_used_at, item.use_count
      );
    } else {
      const index = this.items.findIndex(value => value.id === item.id);
      if (index >= 0) item.created_at = this.items[index].created_at || item.created_at;
      if (index >= 0) this.items[index] = { ...this.items[index], ...item };
      else this.items.push(item);
      this.items = this.items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 2000);
      this.persistJson();
    }
    this.exportJson();
    return item;
  }

  markUsed(ids) {
    if (!ids.length) return;
    const now = new Date().toISOString();
    if (this.db) {
      const stmt = this.db.prepare("UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?");
      for (const id of ids) stmt.run(now, id);
    } else {
      for (const item of this.items) if (ids.includes(item.id)) {
        item.last_used_at = now;
        item.use_count = Number(item.use_count || 0) + 1;
      }
      this.persistJson();
    }
  }

  forget(id) {
    let changed = false;
    if (this.db) changed = Number(this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes || 0) > 0;
    else {
      const before = this.items.length;
      this.items = this.items.filter(item => item.id !== id);
      changed = this.items.length !== before;
      if (changed) this.persistJson();
    }
    if (changed) this.exportJson();
    return changed;
  }

  search(query, project, limit = MEMORY_MAX_ITEMS) {
    const queryTokens = new Set(memoryTokens(query));
    const normalizedProject = memoryProject(project);
    if (!queryTokens.size) return [];
    const ranked = [];
    for (const item of this.all(1000)) {
      const itemProject = memoryProject(item.project);
      if (itemProject !== "global" && normalizedProject !== "global" && itemProject !== normalizedProject) continue;
      const terms = new Set(Array.isArray(item.keywords) ? item.keywords : memoryTokens(`${item.problem} ${item.outcome} ${(item.files || []).join(" ")}`));
      let overlap = 0;
      for (const token of queryTokens) if (terms.has(token)) overlap++;
      if (!overlap) continue;
      const projectScore = itemProject === normalizedProject ? 4 : 0.5;
      const score = overlap * 2 + projectScore + Math.min(1, Number(item.use_count || 0) / 10) + Number(item.confidence || 0);
      ranked.push({ ...item, score });
    }
    const found = ranked.sort((a, b) => b.score - a.score || String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, limit);
    this.markUsed(found.map(item => item.id));
    return found;
  }

  close() {
    if (this.db) this.db.close();
  }
}

function getMemoryStore() {
  if (!MEMORY_ENABLED) return null;
  if (!MEMORY_STORE) MEMORY_STORE = new MemoryStore(MEMORY_DIR);
  return MEMORY_STORE;
}

function checkpointName(kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${kind}-${crypto.randomBytes(3).toString("hex")}.json`;
}

function saveCheckpoint(kind, payload) {
  try {
    if (!safeMkdir(CHECKPOINT_DIR)) return null;
    const file = path.join(CHECKPOINT_DIR, checkpointName(kind));
    const created = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({
      version: VERSION,
      kind,
      created_at: created,
      payload
    }, null, 2), "utf8");
    fs.writeFileSync(path.join(CHECKPOINT_DIR, "latest.json"), JSON.stringify({
      version: VERSION,
      kind,
      file,
      created_at: created
    }, null, 2), "utf8");
    diag(`CHECKPOINT saved kind=${kind} file=${file}`);
    return file;
  } catch (err) {
    diag(`CHECKPOINT failed kind=${kind} error=${err.message}`);
    return null;
  }
}

function updateCheckpointSummary(file, summary, usage) {
  if (!file) return;
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    obj.compact_summary = typeof summary === "string" ? summary : "";
    obj.usage = usage || null;
    obj.completed_at = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    const hash = checkpointSummaryHash(summary);
    if (hash) CHECKPOINT_BY_SUMMARY.set(hash, file);
  } catch (err) {
    diag(`CHECKPOINT update failed error=${err.message}`);
  }
}

function requestCacheKey(body) {
  if (!body || typeof body !== "object") return "default";
  const candidates = [
    body.prompt_cache_key,
    body.conversation?.id,
    body.metadata?.thread_id,
    body.metadata?.conversation_id
  ];
  for (const v of candidates) if (typeof v === "string" && v) return v;
  return `model:${body.model || DEFAULT_MODEL}`;
}

function requestFingerprint(body) {
  try {
    const raw = JSON.stringify({
      model: body?.model || DEFAULT_MODEL,
      instructions: body?.instructions || "",
      input: body?.input || null
    });
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return "";
  }
}

function checkpointSummaryText(text) {
  const source = String(text || "");
  const match = source.match(/^#{0,6}\s*CONTEXT CHECKPOINT SUMMARY\b/m);
  if (!match) return "";
  return source.slice(match.index).split(/\n\n\[COLD MEMORY:/, 1)[0].trim();
}

function checkpointSummaryHash(text) {
  const summary = checkpointSummaryText(text);
  return summary ? crypto.createHash("sha256").update(summary).digest("hex") : "";
}

function checkpointForRequest(body, cacheKey, model) {
  if (Array.isArray(body?.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      if (!isCompactionSummaryItem(body.input[i])) continue;
      const hash = checkpointSummaryHash(messageContentText(body.input[i].content));
      if (hash && CHECKPOINT_BY_SUMMARY.has(hash)) return CHECKPOINT_BY_SUMMARY.get(hash);
    }
  }
  return CHECKPOINT_BY_KEY.get(cacheKey) || CHECKPOINT_BY_KEY.get(`model:${model || DEFAULT_MODEL}`) || null;
}

function restoreCheckpointIndex(limit = 256) {
  try {
    if (!fs.existsSync(CHECKPOINT_DIR)) return 0;
    const files = fs.readdirSync(CHECKPOINT_DIR)
      .filter(name => name.includes("-compaction-") && name.endsWith(".json"))
      .sort().reverse().slice(0, limit);
    let restored = 0;
    for (const name of files) {
      const file = path.join(CHECKPOINT_DIR, name);
      let obj;
      try { obj = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      const body = obj?.payload?.request;
      if (!body || typeof obj.compact_summary !== "string" || !obj.compact_summary) continue;
      const keys = [requestCacheKey(body), `model:${body.model || DEFAULT_MODEL}`];
      for (const key of keys) if (!CHECKPOINT_BY_KEY.has(key)) CHECKPOINT_BY_KEY.set(key, file);
      const hash = checkpointSummaryHash(obj.compact_summary);
      if (hash && !CHECKPOINT_BY_SUMMARY.has(hash)) CHECKPOINT_BY_SUMMARY.set(hash, file);
      restored++;
    }
    diag(`CHECKPOINT index restored=${restored} summary_keys=${CHECKPOINT_BY_SUMMARY.size}`);
    return restored;
  } catch (err) {
    diag(`CHECKPOINT index restore failed error=${err.message}`);
    return 0;
  }
}

function appendCheckpointHint(body, checkpointPath) {
  if (!body || !Array.isArray(body.input) || !checkpointPath) return false;
  const summary = body.input.find(isCompactionSummaryItem);
  if (!summary) return false;
  const hint = `\n\n[COLD MEMORY: full pre-compaction transcript is archived at ${checkpointPath}. Read/search it only if an exact detail missing from this checkpoint becomes necessary. Do not re-read it by default.]`;
  if (typeof summary.content === "string") {
    if (!summary.content.includes("[COLD MEMORY:")) summary.content += hint;
    return true;
  }
  if (Array.isArray(summary.content)) {
    const textBlock = summary.content.find(x => x && typeof x === "object" && typeof x.text === "string");
    if (textBlock) {
      if (!textBlock.text.includes("[COLD MEMORY:")) textBlock.text += hint;
      return true;
    }
  }
  return false;
}

function isCompactionRequest(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)) return false;
  const latestUser = [...body.input].reverse().find(isUserMessageItem);
  if (!latestUser) return false;
  const text = messageContentText(latestUser.content).trimStart();
  return text.startsWith("Interrupted. You are creating a CONTEXT CHECKPOINT SUMMARY") ||
    text.startsWith("You are performing a CONTEXT CHECKPOINT COMPACTION") ||
    text.startsWith("Create a handoff summary for another LLM") ||
    text.startsWith("Create a continuation handoff for the next model");
}


function pruneCompactionInputHistory(body, maxCharsPerToolOutput = 3000) {
  if (!body || !Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output" && Array.isArray(item.output)) {
      for (const block of item.output) {
        if (block && typeof block === "object" && typeof block.text === "string" && block.text.length > maxCharsPerToolOutput) {
          block.text = block.text.slice(0, maxCharsPerToolOutput) + "\n...[truncated for compaction]...";
        }
      }
    } else if (item.type === "function_call_output" && typeof item.output === "string" && item.output.length > maxCharsPerToolOutput) {
      item.output = item.output.slice(0, maxCharsPerToolOutput) + "\n...[truncated for compaction]...";
    }
  }
}

function applyCompactionPolicy(body, limit = COMPACT_MAX_OUTPUT_TOKENS) {
  if (!body || typeof body !== "object") return body;
  body.max_output_tokens = Math.max(1024, Number(limit) || COMPACT_MAX_OUTPUT_TOKENS);
  body.reasoning = body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {};
  body.reasoning.effort = COMPACT_REASONING_EFFORT;
  if (COMPACT_REASONING_BUDGET > 0) body.thinking_budget_tokens = COMPACT_REASONING_BUDGET;
  else delete body.thinking_budget_tokens;
  if (usesTemplateThinking(body)) {
    body.chat_template_kwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object"
      ? body.chat_template_kwargs
      : {};
    body.chat_template_kwargs.enable_thinking = false;
    body.chat_template_kwargs.preserve_thinking = false;
  }
  body.tool_choice = "none";
  body.parallel_tool_calls = false;
  pruneCompactionInputHistory(body);
  const contract = "COMPACTION OUTPUT CONTRACT: Return only a dense checkpoint in the configured user language. The first line must be # CONTEXT CHECKPOINT SUMMARY. Use Markdown headings in this exact order: CURRENT TASK, WORK COMPLETED, DECISIONS AND CONSTRAINTS, STATE SNAPSHOT, OPEN ISSUES, PARKED TASKS, NEXT ACTION. Every heading is mandatory; write '- None.' when empty. CRITICAL REQUIREMENT: Review the entire preceding history carefully. List ALL steps that were already implemented, edited, or tested under WORK COMPLETED. NEVER list completed tasks or already applied patches in OPEN ISSUES or NEXT ACTION. Under NEXT ACTION, strictly state ONLY the exact next uncompleted step based on the most recent turns. Target 1200-1800 tokens, start NEXT ACTION before token 2000, and finish it with a complete sentence.";
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  if (!instructions.includes("COMPACTION OUTPUT CONTRACT:")) {
    body.instructions = instructions ? `${instructions}\n\n${contract}` : contract;
  }

  if (Array.isArray(body.input) && body.input.length) {
    const lastItem = body.input[body.input.length - 1];
    if (isUserMessageItem(lastItem)) {
      const explicitPrompt = "Выполняется КОМПАКЦИЯ КОНТЕКСТА. Создай структурированный # CONTEXT CHECKPOINT SUMMARY на русском языке.\nВНИМАНИЕ: Все шаги, которые уже были выполнены или протестированы в диалоге выше, ОБЯЗАТЕЛЬНО запиши в '## WORK COMPLETED'. Ни в коем случае не повторяй их в '## NEXT ACTION' или '## OPEN ISSUES'. В '## NEXT ACTION' укажи ТОЛЬКО следующий невыполненный шаг, начиная ровно с того места, где прервалась работа.";
      if (typeof lastItem.content === "string") {
        lastItem.content = explicitPrompt;
      } else if (Array.isArray(lastItem.content)) {
        lastItem.content = [{ type: "input_text", text: explicitPrompt }];
      }
    }
  }

  return body;
}

function usageFrom(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.usage && typeof obj.usage === "object") return obj.usage;
  if (obj.response?.usage && typeof obj.response.usage === "object") return obj.response.usage;
  return null;
}

function usageLine(usage) {
  if (!usage) return "usage=missing";
  const input = usage.input_tokens ?? usage.prompt_tokens ?? "?";
  const output = usage.output_tokens ?? usage.completion_tokens ?? "?";
  const total = usage.total_tokens ??
    ((Number.isFinite(Number(input)) && Number.isFinite(Number(output)))
      ? Number(input) + Number(output)
      : "?");
  return `usage input=${input} output=${output} total=${total}`;
}

function responseTextFromObject(obj) {
  const chunks = [];
  const walk = value => {
    if (Array.isArray(value)) {
      for (const x of value) walk(x);
      return;
    }
    if (!value || typeof value !== "object") return;
    if ((value.type === "output_text" || value.type === "text") && typeof value.text === "string") {
      chunks.push(value.text);
    }
    for (const [k, v] of Object.entries(value)) {
      if (k === "text") continue;
      walk(v);
    }
  };
  walk(obj?.output ?? obj);
  return chunks.join("");
}

function reasoningTextFromObject(obj) {
  const chunks = [];
  const walk = value => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if ((value.type === "reasoning_text" || value.type === "reasoning_summary_text") && typeof value.text === "string") {
      chunks.push(value.text);
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key !== "text") walk(nested);
    }
  };
  walk(obj?.output ?? obj);
  return chunks.join("");
}

function isReasoningStreamEvent(evt) {
  return !!evt && evt.type !== "response.completed" && (
    evt.type?.startsWith("response.reasoning") ||
    evt.item?.type === "reasoning" ||
    evt.part?.type === "reasoning_text" ||
    evt.part?.type === "reasoning_summary_text"
  );
}

function replaceResponseText(obj, text) {
  const response = obj?.response && typeof obj.response === "object" ? obj.response : obj;
  if (!response || typeof response !== "object") return;
  response.output = [{
    id: `msg_compaction_recovery_${Date.now()}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  }];
}

function looksLikeProgressOnly(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return /^(?:i(?:'ll| will| am going to)|let me|first[, ]|next[, ]|i(?:'m| am) going to|сейчас я|сначала я|далее я|теперь я|продолжу|проверю|посмотрю)\b/i.test(t) ||
    /\b(?:i(?:'ll| will) (?:check|inspect|verify|open|read|run|continue|start)|let me (?:check|inspect|verify|open|read|run|continue)|сейчас (?:проверю|посмотрю|открою|запущу))\b/i.test(t);
}

function canonicalNs(ns) {
  return typeof ns === "string" && ns.length ? (ns.endsWith("__") ? ns : ns + "__") : "";
}
function flatNs(ns, name) { return canonicalNs(ns) + name; }

function toolMaps() {
  return {
    namespaceByFlat: new Map(), // flat -> { namespace, name }
    customByName: new Map(),    // name -> { name, argKey }
  };
}

function customArgKey(name) {
  return name === "apply_patch" ? "patch" : "input";
}

function makeFunctionFromCustom(tool, maps) {
  const name = tool.name;
  const argKey = customArgKey(name);
  maps.customByName.set(name, { name, argKey });

  const desc = [
    tool.description || `Invoke the ${name} custom tool.`,
    name === "apply_patch"
      ? "Pass the complete raw Codex patch text in the `patch` string."
      : "Pass the complete raw custom-tool input in the `input` string."
  ].join("\n");

  return {
    type: "function",
    name,
    description: desc,
    parameters: {
      type: "object",
      properties: {
        [argKey]: {
          type: "string",
          description: name === "apply_patch"
            ? "Raw patch text beginning with *** Begin Patch and ending with *** End Patch."
            : "Raw custom tool input."
        }
      },
      required: [argKey],
      additionalProperties: false
    },
    strict: true
  };
}

function rewriteTools(body, maps) {
  if (!Array.isArray(body.tools)) return;

  const out = [];

  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;

    if (tool.type === "function") {
      let f = clone(tool);
      // Handle OpenAI Chat format where details are nested in tool.function
      if (f.function && typeof f.function === "object") {
        const inner = clone(f.function);
        delete f.function;
        f = Object.assign(inner, f);
      }

      if (f.name === "shell_command" || f.name === "exec_command") {
        const patchGuide =
          "NEVER invoke apply_patch through this shell tool when the dedicated apply_patch tool is available. " +
          "For manual edits to existing text/source/config files, call the dedicated apply_patch tool directly, including for large 3000+ line files, and patch only the required hunks. " +
          "Do not wrap apply_patch in PowerShell, bash, heredocs, here-strings, pipes, or command strings. " +
          "Do not use Set-Content, Add-Content, Out-File, redirection, Python/Node full-file rewrite scripts, or similar direct file writes for ordinary localized edits. " +
          "Direct scripted writes are acceptable only for generated files or broad deterministic transformations; inspect git diff afterward. " +
          "Use this shell tool normally for reading/searching, git, tests, builds, diagnostics, package managers, and runtime work.";

        f.description = patchGuide + (f.description ? "\n\n" + f.description : "");
      }

      out.push(f);
      continue;
    }

    if (tool.type === "namespace") {
      const ns = String(tool.name || "");
      for (const inner of Array.isArray(tool.tools) ? tool.tools : []) {
        if (!inner || inner.type !== "function" || typeof inner.name !== "string") continue;
        const flat = flatNs(ns, inner.name);
        maps.namespaceByFlat.set(flat, { namespace: ns, name: inner.name });

        const f = clone(inner);
        f.type = "function";
        f.name = flat;
        delete f.defer_loading;
        delete f.output_schema;
        out.push(f);
      }
      continue;
    }

    if (tool.type === "custom" && typeof tool.name === "string") {
      out.push(makeFunctionFromCustom(tool, maps));
      continue;
    }

    if (tool.type === "web_search" || tool.type === "web_search_preview") {
      debug("dropping hosted web_search");
      continue;
    }

    debug("dropping unsupported Responses tool type:", tool.type);
  }

  body.tools = out;
}

function encodeCustomArgs(name, input) {
  const key = customArgKey(name);
  return JSON.stringify({ [key]: typeof input === "string" ? input : String(input ?? "") });
}

function normalizeApplyPatchInput(input) {
  if (typeof input !== "string") return input;
  const actions = { add: "Add", update: "Update", delete: "Delete" };
  return input
    .replace(/^[ \t]*\*{3}[ \t]*begin[ \t]+patch[ \t]*$/gim, "*** Begin Patch")
    .replace(/^[ \t]*\*{3}[ \t]*(add|update|delete)[ \t]+file[ \t]*:[ \t]*(.+)$/gim,
      (_, action, file) => `*** ${actions[action.toLowerCase()]} File: ${file}`)
    .replace(/^[ \t]*\*{3}[ \t]*end[ \t]+patch[ \t]*$/gim, "*** End Patch");
}

function decodeCustomArgs(name, args) {
  const key = customArgKey(name);
  if (typeof args !== "string") return "";
  let decoded = args;
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed[key] === "string") decoded = parsed[key];
    else if (parsed && typeof parsed.input === "string") decoded = parsed.input;
    else if (parsed && typeof parsed.patch === "string") decoded = parsed.patch;
  } catch { }
  const normalized = name === "apply_patch" ? normalizeApplyPatchInput(decoded) : decoded;
  if (normalized !== decoded) diag("EDIT normalized apply_patch protocol headers");
  return normalized;
}

function shellCommandText(args) {
  if (typeof args !== "string") return "";
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed?.command === "string") return parsed.command;
    if (Array.isArray(parsed?.command)) return parsed.command.join(" ");
    if (typeof parsed?.cmd === "string") return parsed.cmd;
  } catch { }
  return args;
}

function looksLikeDirectFileWrite(command) {
  if (typeof command !== "string" || !command) return false;
  return /\b(?:Set-Content|Add-Content|Out-File)\b/i.test(command) ||
    /\[System\.IO\.File\]::(?:WriteAllText|WriteAllLines|AppendAllText)/i.test(command) ||
    /(?:^|[;&|]\s*)(?:python|python3|node)\b[^\r\n]*(?:write_text|writeFileSync|writeFile|open\([^)]*,\s*['"]w)/i.test(command);
}

function extractApplyPatchFromShellCommand(command) {
  if (typeof command !== "string" || !command) return null;
  if (!/\bapply_patch(?:\.exe)?\b/i.test(command)) return null;

  const beginMarker = "*** Begin Patch";
  const endMarker = "*** End Patch";
  const begin = command.indexOf(beginMarker);
  if (begin < 0) return null;
  const endStart = command.indexOf(endMarker, begin + beginMarker.length);
  if (endStart < 0) return null;

  const end = endStart + endMarker.length;
  let patch = command.slice(begin, end);
  // Codex's native freeform apply_patch expects the raw patch body, not the
  // shell/heredoc wrapper. Normalize only line endings and keep patch content.
  patch = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!patch.endsWith("\n")) patch += "\n";
  return patch;
}

function extractApplyPatchFromShellArgs(args) {
  return extractApplyPatchFromShellCommand(shellCommandText(args));
}

function normalizeToolOutputArray(item) {
  if (item && item.type === "function_call_output" && Array.isArray(item.output)) {
    item.output = item.output.map(block => {
      if (!block || typeof block !== "object") {
        return { type: "input_text", text: String(block ?? "") };
      }
      const b = clone(block);
      let text = typeof b.text === "string" ? b.text : null;
      if (text == null && typeof b.content === "string") text = b.content;
      if (text == null && (b.type === "image_url" || b.type === "input_image" || b.image_url)) {
        text = `[Image attached: ${b.image_url?.url ? "data:image" : (b.type || "image")}]`;
      }
      if (text == null) {
        try { text = JSON.stringify(b); } catch { text = ""; }
      }
      return { type: "input_text", text };
    });
  } else if (item && item.type === "function_call_output" && typeof item.output === "string") {
    item.output = [{ type: "input_text", text: item.output }];
  } else if (item && item.type === "function_call_output" && item.output && typeof item.output === "object") {
    let text = typeof item.output.text === "string" ? item.output.text : null;
    if (text == null && typeof item.output.content === "string") text = item.output.content;
    if (text == null) {
      try { text = JSON.stringify(item.output); } catch { text = ""; }
    }
    item.output = [{ type: "input_text", text }];
  }
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      if (typeof block.content === "string") {
        parts.push(block.content);
        continue;
      }
      // System/developer messages should be textual. If an unfamiliar block
      // appears, preserve it rather than silently discarding instructions.
      try { parts.push(JSON.stringify(block)); } catch { }
    }
    return parts.filter(Boolean).join("\n");
  }

  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    try { return JSON.stringify(content); } catch { return ""; }
  }

  return String(content);
}

const COMPACT_SUMMARY_PREFIXES = [
  "Another language model started to solve this problem and produced a summary of its thinking process.",
  "Previous LLM was interrupted and summarized the work so far.",
  "# CONTEXT CHECKPOINT SUMMARY",
  "CONTEXT CHECKPOINT SUMMARY"
];

const COMPACTION_REQUIRED_HEADINGS = [
  "CURRENT TASK",
  "WORK COMPLETED",
  "DECISIONS AND CONSTRAINTS",
  "STATE SNAPSHOT",
  "OPEN ISSUES",
  "PARKED TASKS",
  "NEXT ACTION"
];

function isCompactionInstructionText(text) {
  return /CONTEXT CHECKPOINT (?:SUMMARY|COMPACTION)|Create a handoff summary for another LLM|continuation handoff for the next model/i.test(text || "");
}

function compactionTextMetrics(text) {
  const clean = typeof text === "string" ? text.trim() : "";
  const canonical = clean.replace(/^#{1,6}\s*/, "");
  const prefix = canonical.startsWith("CONTEXT CHECKPOINT SUMMARY");
  const forbidden = /<\/?tool_call\b|<function=|<parameter=|<\|(?:tool_call|im_start|im_end)\|>|assistant\s+to=/i.test(clean);
  const pattern = new RegExp(`^#{0,6}\\s*(${COMPACTION_REQUIRED_HEADINGS.join("|")})\\s*$`, "gmi");
  const matches = [...clean.matchAll(pattern)];
  const found = matches.map(match => match[1].toUpperCase());
  const sections = new Map();
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : clean.length;
    const value = clean.slice(start, end).trim();
    if (!sections.has(found[i]) && value) sections.set(found[i], value);
  }
  const ordered = found.length === COMPACTION_REQUIRED_HEADINGS.length &&
    found.every((heading, index) => heading === COMPACTION_REQUIRED_HEADINGS[index]);
  return { clean, prefix, forbidden, present: sections.size, ordered, sections };
}

function isValidCompactionText(text) {
  const metrics = compactionTextMetrics(text);
  return metrics.prefix && !metrics.forbidden && metrics.ordered &&
    COMPACTION_REQUIRED_HEADINGS.every(heading => metrics.sections.has(heading));
}

function compactionCandidateText(text) {
  const value = String(text || "").trim();
  return checkpointSummaryText(value) || value;
}

function bestCompactionCandidate(...values) {
  return values.map(compactionCandidateText).filter(Boolean).sort((left, right) => {
    const a = compactionTextMetrics(left);
    const b = compactionTextMetrics(right);
    return Number(isValidCompactionText(right)) - Number(isValidCompactionText(left)) ||
      b.present - a.present || right.length - left.length;
  })[0] || "";
}

function repairCompactionText(text, recovery = "", outputLimitHit = false) {
  const generated = compactionTextMetrics(text);
  const previous = compactionTextMetrics(recovery);
  const fallback = {
    "CURRENT TASK": "- Продолжить последний активный запрос пользователя.",
    "WORK COMPLETED": "- Сверить уже выполненную работу с рабочей директорией и cold memory.",
    "DECISIONS AND CONSTRAINTS": "- Сохранить пользовательские изменения, язык общения и действующие ограничения.",
    "STATE SNAPSHOT": "- Полный transcript до сжатия сохранён в cold memory.",
    "OPEN ISSUES": "- Определить оставшиеся пункты по рабочему состоянию и cold memory.",
    "PARKED TASKS": "- Нет подтверждённых отложенных задач.",
    "NEXT ACTION": "- Сверить рабочую директорию и cold memory, определить ближайший незавершённый шаг и продолжить без повторения завершённой работы."
  };
  const parts = ["# CONTEXT CHECKPOINT SUMMARY"];
  for (const heading of COMPACTION_REQUIRED_HEADINGS) {
    let value = generated.sections.get(heading) || previous.sections.get(heading) || fallback[heading];
    if (heading === "NEXT ACTION" && outputLimitHit) {
      const completeLines = value.split(/\r?\n/).filter(line => /[.!?…。！？)`\]}>]$/.test(line.trim()));
      value = [...completeLines, fallback[heading]].join("\n");
    }
    parts.push(`## ${heading}`, value);
  }
  return parts.join("\n\n");
}

function cleanRecoveryText(text, limit = 4000) {
  return String(text || "")
    .replace(/<[^>]{0,300}>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function buildCompactionRecoverySummary(body) {
  const items = Array.isArray(body?.input) ? body.input : [];
  let previous = "";
  for (let i = items.length - 1; i >= 0; i--) {
    const text = messageContentText(items[i]?.content);
    const match = text.match(/^#{0,6}\s*CONTEXT CHECKPOINT SUMMARY\b/m);
    if (!match) continue;
    const prior = text.slice(match.index).trim();
    const repaired = repairCompactionText(prior);
    if (isValidCompactionText(repaired)) {
      previous = repaired;
      break;
    }
  }
  const users = Array.isArray(body?.input)
    ? body.input.filter(isUserMessageItem).map(item => messageContentText(item.content).trim()).filter(Boolean)
    : [];
  const latest = [...users].reverse().find(text => !isCompactionInstructionText(text) && !COMPACT_SUMMARY_PREFIXES.some(prefix => text.startsWith(prefix)));
  const old = compactionTextMetrics(previous);
  const task = cleanRecoveryText(latest) || old.sections.get("CURRENT TASK") || "Продолжить последний активный запрос пользователя, сверившись с рабочей директорией и сохранённым transcript.";
  const recent = items.slice(-24).map(item => {
    if (!item || typeof item !== "object" || item.type === "reasoning") return "";
    if (item.type === "function_call") return `Вызван ${item.name || "tool"}: ${cleanRecoveryText(item.arguments, 500)}`;
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const value = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      return `Результат инструмента: ${cleanRecoveryText(value, 500)}`;
    }
    const text = messageContentText(item.content);
    if (!text || isCompactionInstructionText(text) || COMPACT_SUMMARY_PREFIXES.some(prefix => text.trimStart().startsWith(prefix))) return "";
    return `${item.role || item.type || "item"}: ${cleanRecoveryText(text, 500)}`;
  }).filter(Boolean).slice(-12);
  const snapshot = recent.length ? recent.map(value => `- ${value}`).join("\n") : "- Свежий хвост истории отсутствует; использовать cold memory и состояние рабочей директории.";
  return [
    "# CONTEXT CHECKPOINT SUMMARY",
    "",
    "## CURRENT TASK",
    `- ${task}`,
    "",
    "## WORK COMPLETED",
    old.sections.get("WORK COMPLETED") || "- Выполненные шаги необходимо подтвердить по свежему хвосту истории, Git и cold memory.",
    "",
    "## DECISIONS AND CONSTRAINTS",
    "- Отвечать пользователю на русском языке.",
    "- Не выводить внутренние рассуждения и не имитировать вызовы инструментов текстом.",
    "- Сохранить пользовательские изменения и проверить состояние файлов перед продолжением.",
    "",
    "## STATE SNAPSHOT",
    "- Модель не вернула валидный свежий checkpoint; прокси сформировал восстановительный fallback и не переиспользовал старое резюме без пометки.",
    snapshot,
    "- Полный transcript до сжатия сохранён прокси как cold memory.",
    "",
    "## OPEN ISSUES",
    "- Перед продолжением подтвердить последний завершённый шаг по свежему хвосту, рабочей директории и при необходимости cold memory.",
    "",
    "## PARKED TASKS",
    "- Нет задач, которые следует считать отменёнными.",
    "",
    "## NEXT ACTION",
    "- Молча восстановить состояние последней задачи, затем продолжить её с ближайшего незавершённого шага."
  ].join("\n");
}

function approxTextTokens(text) {
  if (typeof text !== "string" || !text) return 0;
  // Conservative tokenizer-free estimate for mixed English/code/Russian text.
  return Math.max(1, Math.ceil(text.length / 3));
}

function isUserMessageItem(item) {
  return !!item && typeof item === "object" && String(item.role || "").toLowerCase() === "user";
}

function isCompactionSummaryItem(item) {
  if (!isUserMessageItem(item)) return false;
  const text = messageContentText(item.content).trimStart();
  return COMPACT_SUMMARY_PREFIXES.some(prefix => text.startsWith(prefix));
}

function prunePostCompactionUserHistory(body, oldUserTokenLimit = POST_COMPACT_OLD_USER_TOKEN_LIMIT) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)) {
    return { foundSummary: false, removed: 0, keptOld: 0, keptCurrent: 0, beforeTokens: 0, afterTokens: 0 };
  }

  let summaryIndex = -1;
  for (let i = body.input.length - 1; i >= 0; i--) {
    if (isCompactionSummaryItem(body.input[i])) {
      summaryIndex = i;
      break;
    }
  }
  if (summaryIndex < 0) {
    return { foundSummary: false, removed: 0, keptOld: 0, keptCurrent: 0, beforeTokens: 0, afterTokens: 0 };
  }

  // Codex deliberately re-injects canonical initial/world context around a
  // mid-turn compaction. Never slice the whole prefix: only prune retained
  // historical *real user* messages. Keep the newest real user message
  // unconditionally because it is the live task/goal the summary must serve.
  const realUser = [];
  for (let i = 0; i < summaryIndex; i++) {
    const item = body.input[i];
    if (!isUserMessageItem(item) || isCompactionSummaryItem(item)) continue;
    realUser.push({ index: i, tokens: approxTextTokens(messageContentText(item.content)) });
  }

  const current = realUser.length ? realUser[realUser.length - 1] : null;
  const older = current ? realUser.slice(0, -1) : [];
  const beforeTokens = realUser.reduce((n, x) => n + x.tokens, 0);

  const keep = new Set();
  if (current) keep.add(current.index);

  let remaining = oldUserTokenLimit;
  let keptOldTokens = 0;
  for (let i = older.length - 1; i >= 0 && remaining > 0; i--) {
    const e = older[i];
    if (e.tokens <= remaining) {
      keep.add(e.index);
      remaining -= e.tokens;
      keptOldTokens += e.tokens;
    }
  }

  const remove = new Set(older.filter(e => !keep.has(e.index)).map(e => e.index));
  body.input = body.input.filter((_, index) => !remove.has(index));

  return {
    foundSummary: true,
    removed: remove.size,
    keptOld: older.length - remove.size,
    keptCurrent: current ? 1 : 0,
    currentTokens: current?.tokens || 0,
    beforeTokens,
    afterTokens: keptOldTokens + (current?.tokens || 0),
    summaryIndex,
    limit: oldUserTokenLimit
  };
}

function prunePostCompactionToolOutputs(body, maxChars = POST_COMPACT_TOOL_OUTPUT_MAX_CHARS, keepRecent = POST_COMPACT_TOOL_OUTPUT_KEEP_RECENT) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input) || !body.input.some(isCompactionSummaryItem)) {
    return { foundSummary: false, truncated: 0, beforeChars: 0, afterChars: 0 };
  }
  const outputs = [];
  for (let index = 0; index < body.input.length; index++) {
    const item = body.input[index];
    if (!item || !["function_call_output", "custom_tool_call_output"].includes(item.type) || typeof item.output !== "string") continue;
    outputs.push({ index, chars: item.output.length });
  }
  const protectedIndexes = new Set(outputs.slice(-keepRecent).map(item => item.index));
  let truncated = 0;
  let beforeChars = 0;
  let afterChars = 0;
  for (const entry of outputs) {
    const item = body.input[entry.index];
    beforeChars += entry.chars;
    if (!protectedIndexes.has(entry.index) && entry.chars > maxChars) {
      const digest = crypto.createHash("sha256").update(item.output).digest("hex").slice(0, 16);
      const marker = `\n...[POST-COMPACTION TOOL OUTPUT TRUNCATED sha256=${digest} original_chars=${entry.chars}]...\n`;
      const available = Math.max(0, maxChars - marker.length);
      const head = Math.floor(available * 0.75);
      item.output = item.output.slice(0, head) + marker + item.output.slice(-(available - head));
      truncated++;
    }
    afterChars += item.output.length;
  }
  return { foundSummary: true, truncated, beforeChars, afterChars };
}

function appendPostCompactContinuationRule(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input) || !body.input.some(isCompactionSummaryItem)) return false;
  const marker = "POST-COMPACTION CONTINUATION RULE:";
  const rule = `${marker} The checkpoint is the authoritative task state. Treat every item in WORK COMPLETED as finished and never redo it. Ignore older user requests superseded by CURRENT TASK. Execute exactly NEXT ACTION, using current files and new tool results as truth. Repeat a setup, bridge connection, baseline check, test, edit, commit, or push only when NEXT ACTION explicitly requires it or current evidence proves it invalid.`;
  const instructions = String(body.instructions || "").trim();
  if (instructions.includes(marker)) return false;
  body.instructions = instructions ? `${instructions}\n\n${rule}` : rule;
  return true;
}

function normalizeInstructionMessages(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)) {
    return { moved: 0, roles: [] };
  }

  const originalInstructions = typeof body.instructions === "string"
    ? body.instructions.trim()
    : "";
  const pieces = [];
  const seen = new Set();

  function addPiece(text) {
    const t = typeof text === "string" ? text.trim() : "";
    if (!t || seen.has(t)) return;
    seen.add(t);
    pieces.push(t);
  }

  addPiece(originalInstructions);

  const kept = [];
  const roles = [];
  let moved = 0;

  for (const item of body.input) {
    const role = item && typeof item === "object" && typeof item.role === "string"
      ? item.role.toLowerCase()
      : "";

    if (role === "system" || role === "developer") {
      moved += 1;
      roles.push(role);
      addPiece(messageContentText(item.content));
      continue;
    }

    kept.push(item);
  }

  if (moved) {
    body.input = kept;
    body.instructions = pieces.join("\n\n");
  }

  return { moved, roles };
}

function pruneOrphanProgressMessages(body) {
  if (!body || !Array.isArray(body.input) || !FORWARD_TOOL_PROGRESS) return 0;
  const input = body.input;
  const toolCallIds = new Set();
  const toolOutputIds = new Set();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const id = item.id || item.call_id;
      if (id) toolCallIds.add(id);
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const id = item.call_id || item.id;
      if (id) toolOutputIds.add(id);
    }
  }
  const before = input.length;
  body.input = input.filter(item => {
    if (!item || typeof item !== "object") return true;
    if (item.type !== "message" || item.role !== "assistant") return true;
    const id = item.id || item.call_id;
    if (!id) return false;
    return toolCallIds.has(id) || toolOutputIds.has(id);
  });
  const removed = before - body.input.length;
  if (removed) diag(`PROGRESS_PRUNE removed orphan assistant progress messages count=${removed}`);
  return removed;
}

function rewriteHistoryNode(node, maps, repairs = []) {
  if (Array.isArray(node)) {
    for (const x of node) rewriteHistoryNode(x, maps, repairs);
    return repairs;
  }
  if (!node || typeof node !== "object") return repairs;

  // Codex namespaced function call -> flat llama.cpp function call.
  if (node.type === "function_call" &&
    typeof node.name === "string" &&
    typeof node.namespace === "string" &&
    node.namespace) {
    node.name = flatNs(node.namespace, node.name);
    delete node.namespace;
  }

  // Codex custom/freeform call -> llama.cpp function call.
  if (node.type === "custom_tool_call" && typeof node.name === "string") {
    node.type = "function_call";
    node.arguments = encodeCustomArgs(node.name, node.input);
    delete node.input;
    delete node.namespace;
  }

  if (node.type === "function_call") {
    if (node.arguments && typeof node.arguments === "object") {
      node.arguments = JSON.stringify(node.arguments);
    } else {
      try {
        JSON.parse(node.arguments);
      } catch {
        repairs.push({ name: typeof node.name === "string" ? node.name : "unknown" });
        node.arguments = "{}";
      }
    }
  }

  // Codex custom-tool result -> llama.cpp function result.
  if (node.type === "custom_tool_call_output") {
    node.type = "function_call_output";
  }

  normalizeToolOutputArray(node);

  for (const v of Object.values(node)) rewriteHistoryNode(v, maps, repairs);
  return repairs;
}

function reasoningBudgetForEffort(effort) {
  if (effort === "low") return REASONING_BUDGET_LOW;
  if (effort === "medium") return REASONING_BUDGET_MEDIUM;
  if (effort === "high") return REASONING_BUDGET_HIGH;
  if (effort === "xhigh") return REASONING_BUDGET_XHIGH;
  return null;
}

function usesTemplateThinking(body) {
  if (THINKING_MODE === "on" || THINKING_MODE === "qwen") return true;
  if (THINKING_MODE === "off" || THINKING_MODE === "generic") return false;
  return String(body?.model || DEFAULT_MODEL).toLowerCase().includes("qwen");
}

function normalizeReasoningEffort(body) {
  const reasoning = body && typeof body === "object" ? body.reasoning : null;
  const raw = typeof reasoning?.effort === "string" ? reasoning.effort.toLowerCase() : null;
  let effective = raw || DEFAULT_REASONING_EFFORT;
  let mapped = false;
  if (raw === "high" && REASONING_HIGH_MAP !== "high") {
    effective = REASONING_HIGH_MAP;
    reasoning.effort = effective;
    mapped = true;
  }

  const budget = reasoningBudgetForEffort(effective);
  if (!SUPPORTED_REASONING_LEVELS.has(effective)) {
    diag(`REASONING WARNING unsupported effort=${effective}; forwarding unchanged`);
  } else if (budget > 0) {
    body.thinking_budget_tokens = budget;
    diag(`REASONING request raw=${raw || "missing"} effective=${effective}${mapped ? " mapped=1" : ""} budget=${budget}`);
  }

  return { raw, effective, mapped, budget };
}

function prepareRequest(original) {
  const body = clone(original);
  const maps = toolMaps();

  if (usesTemplateThinking(body)) {
    body.chat_template_kwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object"
      ? body.chat_template_kwargs
      : {};
    if (body.chat_template_kwargs.enable_thinking === undefined) body.chat_template_kwargs.enable_thinking = true;
    if (body.chat_template_kwargs.preserve_thinking === undefined) body.chat_template_kwargs.preserve_thinking = true;
  }
  if (FORCE_SERIAL_TOOL_CALLS) body.parallel_tool_calls = false;

  const reasoningNormalization = normalizeReasoningEffort(body);
  const instructionNormalization = normalizeInstructionMessages(body);
  const autonomyRule = "AUTONOMOUS EXECUTION PROTOCOL: You must work autonomously until the user's task or multi-step plan is 100% complete. If you just finished a sub-step (e.g. edited a file, applied a patch, or ran a tool), DO NOT stop with an explanation, plan summary, or progress message. You MUST immediately execute the next tool call. Before every git commit or push, run applicable syntax checks and tests; never publish code with a known validation failure. Only emit a final text message when ALL planned steps are fully implemented, verified, and pushed.";
  if (typeof body.instructions === "string" && !body.instructions.includes("AUTONOMOUS EXECUTION PROTOCOL:")) {
    body.instructions = `${body.instructions.trim()}\n\n${autonomyRule}`;
  } else if (!body.instructions) {
    body.instructions = autonomyRule;
  }
  const postCompactPruning = prunePostCompactionUserHistory(body);
  const postCompactToolPruning = prunePostCompactionToolOutputs(body);
  pruneOrphanProgressMessages(body);
  rewriteTools(body, maps);
  if (Array.isArray(body.input) && body.input.length > 0) {
    const last = body.input[body.input.length - 1];
    const lastRole = last && (last.role || (Array.isArray(last) ? last[0]?.role : null));
    const isUserOrTool = lastRole === "tool" || lastRole === "function" ||
      (last && (last.type === "function_call_output" || last.type === "custom_tool_call_output"));
    
    const isTerminalWithoutTool = lastRole === "assistant" || (last && last.type === "message" && (last.role === "assistant" || !last.role));

    const autonomyDirective = "[AUTONOMOUS EXECUTION DIRECTIVE: Continue working autonomously. Do NOT stop with an empty message or progress summary. Immediately execute the next required tool call to complete, verify, and push all tasks.]";

    if (isUserOrTool) {
      if (typeof last.output === "string") {
        last.output = `${last.output.trim()}\n\n${autonomyDirective}`;
      } else if (Array.isArray(last.output) && last.output.length > 0) {
        const lastBlock = last.output[last.output.length - 1];
        if (lastBlock && typeof lastBlock === "object") {
          if (typeof lastBlock.text === "string") {
            lastBlock.text = `${lastBlock.text.trim()}\n\n${autonomyDirective}`;
          } else if (typeof lastBlock.content === "string") {
            lastBlock.content = `${lastBlock.content.trim()}\n\n${autonomyDirective}`;
          } else {
            last.output.push({ type: "input_text", text: autonomyDirective });
          }
        } else if (typeof lastBlock === "string") {
          last.output[last.output.length - 1] = `${lastBlock.trim()}\n\n${autonomyDirective}`;
        } else {
          last.output.push({ type: "input_text", text: autonomyDirective });
        }
      } else if (!last.output) {
        last.output = autonomyDirective;
      }
    } else {
      if (typeof last.content === "string") {
        last.content = `${last.content.trim()}\n\n${autonomyDirective}`;
      } else if (Array.isArray(last.content) && last.content.length > 0) {
        const lastPart = last.content[last.content.length - 1];
        if (lastPart && typeof lastPart === "object") {
          if (typeof lastPart.text === "string") {
            lastPart.text = `${lastPart.text.trim()}\n\n${autonomyDirective}`;
          } else if (typeof lastPart.content === "string") {
            lastPart.content = `${lastPart.content.trim()}\n\n${autonomyDirective}`;
          } else {
            last.content.push({ type: "input_text", text: autonomyDirective });
          }
        } else if (typeof lastPart === "string") {
          last.content[last.content.length - 1] = `${lastPart.trim()}\n\n${autonomyDirective}`;
        } else {
          last.content.push({ type: "input_text", text: autonomyDirective });
        }
      } else if (typeof last.text === "string") {
        last.text = `${last.text.trim()}\n\n${autonomyDirective}`;
      }
    }
  }

  const historyRepairs = rewriteHistoryNode(body.input, maps);

  if (Array.isArray(body.include)) {
    body.include = body.include.filter(x =>
      typeof x !== "string" || !x.startsWith("web_search")
    );
  }

  return { body, maps, instructionNormalization, reasoningNormalization, postCompactPruning, postCompactToolPruning, historyRepairs };
}

function namespaceInfo(name, maps) {
  return typeof name === "string" ? maps.namespaceByFlat.get(name) : null;
}

function convertFunctionItem(item, maps) {
  if (!item || item.type !== "function_call" || typeof item.name !== "string") return item;

  const custom = maps.customByName.get(item.name);
  if (custom) {
    if (custom.name === "apply_patch") diag("EDIT apply_patch via dedicated native tool");
    return {
      id: item.id || item.call_id || null,
      call_id: item.call_id || item.id || null,
      name: custom.name,
      type: "custom_tool_call",
      input: decodeCustomArgs(custom.name, item.arguments)
    };
  }


  if ((item.name === "shell_command" || item.name === "exec_command") &&
    looksLikeDirectFileWrite(shellCommandText(item.arguments))) {
    diag(`EDIT WARNING direct file write requested through ${item.name}; prefer native apply_patch for localized source/config edits`);
  }

  const ns = namespaceInfo(item.name, maps);
  if (ns) {
    const out = clone(item);
    out.name = ns.name;
    out.namespace = ns.namespace;
    return out;
  }

  return item;
}

function rewriteResponseObject(obj, maps) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const x = obj[i];
      if (x && x.type === "function_call") obj[i] = convertFunctionItem(x, maps);
      else rewriteResponseObject(x, maps);
    }
    return;
  }
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj.output)) {
    obj.output = obj.output.map(x => convertFunctionItem(x, maps));
  }

  if (obj.item && obj.item.type === "function_call") {
    obj.item = convertFunctionItem(obj.item, maps);
  }

  for (const [k, v] of Object.entries(obj)) {
    if (k === "item" || k === "output") continue;
    rewriteResponseObject(v, maps);
  }
}

function isSafeProgressText(text) {
  const value = String(text || "").trim();
  if (!value || value.length > PROGRESS_MAX_CHARS) return false;
  if (/<\/?tool_call\b|<function=|<parameter=|<\|(?:tool_call|im_start|im_end)\|>|assistant\s+to=/i.test(value)) return false;
  if (/```|^\s*[\[{][\s\S]*(?:"command"|"arguments"|"call_id")/i.test(value)) return false;
  if (/^(?:analysis\b|reasoning\b|thoughts?\b|we need\b|i need\b|i should\b|let(?:'s| us) (?:analy[sz]e|reason|think)|now i (?:understand|see)|wait\b|interesting\b|анализ\b|рассуждени|мне нужно\b|нам нужно\b|надо подумать\b|хм\b|стоп\b|интересно\b)/i.test(value)) return false;
  return value.split(/\r?\n/).length <= 15;
}

function safeProgressMessageIds(obj) {
  const ids = new Set();
  if (!FORWARD_TOOL_PROGRESS || !obj || typeof obj !== "object" || !Array.isArray(obj.output)) return ids;
  for (const item of obj.output) {
    if (item?.type !== "message" || !isSafeProgressText(messageContentText(item.content))) continue;
    const id = item.id || item.call_id;
    if (id) ids.add(id);
  }
  return ids;
}

function looksLikeProgressOnly(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 800) return false;
  return /^(?:понял|сейчас|начну|приступаю|давай|проверю|проанализирую|исправлю|оптимизация|теперь|далее|следующим|i['’]ll|i\s+will|let\s+me|now\s+i\s+will|i\s+understand|optimization|next)\b/i.test(t);
}

function bufferedMessageEventId(encoded) {
  try {
    const event = JSON.parse(String(encoded).replace(/^data:\s*/, "").trim());
    return event.item_id || event.item?.id || event.item?.call_id || "";
  } catch {
    return "";
  }
}

function memoryOutputText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.output === "string") return item.output;
  if (Array.isArray(item.output)) return item.output.map(block => typeof block === "string" ? block : (block?.text || block?.content || "")).join("\n");
  return "";
}

function memoryTaskInfo(body) {
  const items = Array.isArray(body?.input) ? body.input : [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!isUserMessageItem(item)) continue;
    const text = messageContentText(item.content).trim();
    if (!text || /^<environment_context>[\s\S]*<\/environment_context>$/i.test(text) ||
      isCompactionInstructionText(text) || COMPACT_SUMMARY_PREFIXES.some(prefix => text.startsWith(prefix)) ||
      text.startsWith("# CONTEXT CHECKPOINT SUMMARY")) continue;
    return { index, id: item.id || item.internal_chat_message_metadata_passthrough?.turn_id || "", text: memorySanitize(text, 1400) };
  }
  return { index: -1, id: "", text: "" };
}

function memoryHasRegressionSignal(text) {
  return /(?:\b(?:again|still|regress(?:ion|ed)?|returned|reappeared|worse|broken|not fixed|doesn['’]?t work)\b|снова|опять|повторн\w*|регресс\w*|вернул\w*|возник\w*|появил\w*|хуже|сломан\w*|не\s+исправ\w*|не\s+работа\w*)/iu.test(String(text || ""));
}

function rememberMemoryInjection(key) {
  if (!key) return;
  MEMORY_INJECTED_TASKS.set(key, Date.now());
  while (MEMORY_INJECTED_TASKS.size > 512) MEMORY_INJECTED_TASKS.delete(MEMORY_INJECTED_TASKS.keys().next().value);
}

function memoryProjectFromBody(body) {
  const items = Array.isArray(body?.input) ? body.input : [];
  const source = [body?.instructions || "", ...items.map(item => messageContentText(item?.content))].join("\n");
  const matches = [...source.matchAll(/<cwd>([^<]+)<\/cwd>/gi)];
  if (matches.length) return memoryProject(matches[matches.length - 1][1]);
  const roots = [...source.matchAll(/<workspace_roots>[\s\S]*?<root>([^<]+)<\/root>[\s\S]*?<\/workspace_roots>/gi)];
  if (roots.length) return memoryProject(roots[roots.length - 1][1]);
  return "global";
}

function memoryRequestMeta(body) {
  const task = memoryTaskInfo(body);
  const project = memoryProjectFromBody(body);
  const items = Array.isArray(body?.input) ? body.input.slice(Math.max(0, task.index + 1)) : [];
  const evidence = [];
  const files = new Set();
  let hasCommit = false;
  let hasTest = false;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if ((item.type === "custom_tool_call" || item.type === "function_call") && item.name === "apply_patch") {
      const patchText = String(item.input || item.arguments || "");
      for (const match of patchText.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*([^\r\n]+)/g)) files.add(memorySanitize(match[1], 260));
    }
    const output = memoryOutputText(item);
    if (!output) continue;
    for (const match of output.matchAll(/diff --git a\/([^\s]+) b\/([^\s]+)/g)) files.add(memorySanitize(match[2], 260));
    for (const rawLine of output.split(/\r?\n/)) {
      const line = memorySanitize(rawLine, 420);
      if (!line) continue;
      const commit = /^\[[^\]]+\s+[0-9a-f]{7,40}\]/i.test(line) || /[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\s+\S+\s+->\s+\S+/i.test(line);
      const test = /\bSELFTEST PASS\b|\bNODE_CHECK[^\r\n]*PASS\b|\bPASS:\s|\btests?\b[^\r\n]{0,60}\b(?:passed|pass|ok)\b|^Ran \d+ tests?\b|^OK$/i.test(line);
      if (!commit && !test) continue;
      if (commit) hasCommit = true;
      if (test) hasTest = true;
      if (evidence.length < 10 && !evidence.includes(line)) evidence.push(line);
    }
  }
  const taskKey = crypto.createHash("sha256").update(`${project}\n${task.id || task.text}`).digest("hex").slice(0, 20);
  return { task: task.text, taskKey, project, evidence, files: [...files].slice(0, 20), hasCommit, hasTest };
}

function memoryInstructionForRequest(body) {
  const meta = memoryRequestMeta(body);
  if (!MEMORY_ENABLED || isCompactionRequest(body) || !meta.task ||
      (Array.isArray(body?.input) && body.input.some(isCompactionSummaryItem)) ||
      memoryHasRegressionSignal(meta.task) || MEMORY_INJECTED_TASKS.has(meta.taskKey)) {
    return { block: "", meta, count: 0 };
  }
  const store = getMemoryStore();
  if (!store) return { block: "", meta, count: 0 };
  const found = store.search(meta.task, meta.project, MEMORY_MAX_ITEMS);
  if (!found.length) return { block: "", meta, count: 0 };
  const lines = [
    "LOCAL EPISODIC MEMORY (automatically retrieved; historical evidence, not current truth):",
    "Use only entries relevant to the current task. Current files, tool results, and user instructions always take priority. Do not repeat memory to the user unless it affects the work."
  ];
  for (const item of found) {
    const evidence = (item.evidence || []).slice(0, 2).join("; ");
    lines.push(`- [${item.id}] Problem: ${memorySanitize(item.problem, 300)} | Successful outcome: ${memorySanitize(item.outcome, 360)}${evidence ? ` | Evidence: ${memorySanitize(evidence, 260)}` : ""}`);
  }
  rememberMemoryInjection(meta.taskKey);
  return { block: lines.join("\n").slice(0, MEMORY_MAX_CHARS), meta, count: found.length };
}

function rememberCompletedTask(meta, responseText) {
  if (!MEMORY_ENABLED || !meta?.task || (!meta.hasCommit && !meta.hasTest)) return null;
  const outcome = memorySanitize(responseText, 1400);
  if (outcome.length < 20 || looksLikeProgressOnly(outcome)) return null;
  const key = `${memoryProject(meta.project)}\n${meta.task.toLowerCase().replace(/\s+/g, " ")}`;
  const id = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const record = {
    id,
    project: meta.project,
    problem: memorySanitize(meta.task, 900),
    outcome,
    evidence: meta.evidence.map(value => memorySanitize(value, 420)),
    files: meta.files.map(value => memorySanitize(value, 260)),
    keywords: memoryTokens(`${meta.task} ${outcome} ${meta.files.join(" ")}`),
    confidence: meta.hasCommit && meta.hasTest ? 1 : 0.9
  };
  const saved = getMemoryStore()?.upsert(record) || null;
  if (saved) diag(`MEMORY saved id=${saved.id} project=${JSON.stringify(saved.project)} evidence=${saved.evidence.length} files=${saved.files.length}`);
  return saved;
}
function suppressMessagesWithToolCalls(obj, keepMessageIds = new Set()) {
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.output)) return 0;
  const hasToolCall = obj.output.some(x => x && (x.type === "function_call" || x.type === "custom_tool_call"));
  if (!hasToolCall) return 0;
  const before = obj.output.length;
  obj.output = obj.output.filter(x => {
    if (!x || x.type !== "message") return true;
    const id = x.id || x.call_id;
    return !!id && keepMessageIds.has(id);
  });
  return before - obj.output.length;
}

function copyHeaders(src, extraDrop = []) {
  const drop = new Set([
    "host", "content-length", "transfer-encoding", "connection", "content-encoding",
    ...extraDrop.map(x => x.toLowerCase())
  ]);
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!drop.has(k.toLowerCase()) && v !== undefined) out[k] = v;
  }
  return out;
}

function decodeBody(buf, encoding) {
  if (!encoding) return buf;
  const e = String(encoding).toLowerCase();
  if (e === "gzip") return zlib.gunzipSync(buf);
  if (e === "deflate") return zlib.inflateSync(buf);
  if (e === "br" && zlib.brotliDecompressSync) return zlib.brotliDecompressSync(buf);
  return buf;
}

function finiteInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeCompletedForCodex(evt) {
  if (!evt || evt.type !== "response.completed" || !evt.response || typeof evt.response !== "object") {
    return evt;
  }

  const response = evt.response;
  const usage = response.usage;
  if (!usage || typeof usage !== "object") return evt;

  // Codex accepts usage as optional, but if it is present the three core counts
  // are required. llama.cpp Responses versions have varied here. Prefer exact
  // aliases when available; if the object is still incomplete, drop only usage
  // instead of sacrificing an otherwise valid response.completed event.
  const input = finiteInt(usage.input_tokens ?? usage.prompt_tokens);
  const output = finiteInt(usage.output_tokens ?? usage.completion_tokens);
  let total = finiteInt(usage.total_tokens);
  if (total == null && input != null && output != null) total = input + output;

  if (input == null || output == null || total == null) {
    diag(`SSE_NORMALIZE completed usage dropped incomplete=${JSON.stringify(usage).slice(0, 1000)}`);
    delete response.usage;
    return evt;
  }

  usage.input_tokens = input;
  usage.output_tokens = output;
  usage.total_tokens = total;

  if (usage.input_tokens_details && typeof usage.input_tokens_details === "object") {
    if (finiteInt(usage.input_tokens_details.cached_tokens) == null) {
      usage.input_tokens_details.cached_tokens = 0;
    } else {
      usage.input_tokens_details.cached_tokens = finiteInt(usage.input_tokens_details.cached_tokens);
    }
    if (finiteInt(usage.input_tokens_details.cache_write_tokens) == null) {
      usage.input_tokens_details.cache_write_tokens = 0;
    } else {
      usage.input_tokens_details.cache_write_tokens = finiteInt(usage.input_tokens_details.cache_write_tokens);
    }
  }

  if (usage.output_tokens_details && typeof usage.output_tokens_details === "object") {
    if (finiteInt(usage.output_tokens_details.reasoning_tokens) == null) {
      usage.output_tokens_details.reasoning_tokens = 0;
    } else {
      usage.output_tokens_details.reasoning_tokens = finiteInt(usage.output_tokens_details.reasoning_tokens);
    }
  }

  return evt;
}

class SseTranslator {
  constructor(maps, requestMeta = {}) {
    this.maps = maps;
    this.requestMeta = requestMeta;
    this.customItems = new Map(); // item_id -> { name, args, output_index, call_id }
    this.outputIndexByItem = new Map();
    this.nextOutputIndex = 0;
    this.text = "";
    this.reasoningText = "";
    this.sawToolCall = false;
    this.sawCompletedForwarded = false;
    this.messageItems = new Set();
    this.bufferedMessageEvents = [];
  }

  recoveredCompactionEvents(evt, text) {
    const itemId = `msg_compaction_recovery_${String(evt.response?.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const item = { id: itemId, type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    evt.response.output = [item];
    return [
      this.event({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }),
      this.event({ type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
      this.event({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text }),
      this.event({ type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text }),
      this.event({ type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] }),
      this.event({ type: "response.output_item.done", output_index: 0, item }),
      this.event(evt)
    ];
  }

  // IMPORTANT: this returns a COMPLETE SSE event. A blank line terminates an
  // event per the SSE standard. v16.0-v16.2 returned only one '\n', so multiple
  // synthetic data lines could be concatenated into one invalid JSON event.
  event(obj) {
    return "data: " + JSON.stringify(obj) + "\n\n";
  }

  itemKey(evt) {
    return evt?.item_id || evt?.item?.id || evt?.item?.call_id || evt?.call_id || null;
  }

  normalizeEventShape(evt) {
    if (!evt || typeof evt !== "object") return evt;

    const item = evt.item;
    if (item && typeof item === "object" && item.type === "function_call") {
      if (!item.id && item.call_id) item.id = item.call_id;
      if (!item.call_id && item.id) item.call_id = item.id;
    }

    const isFunctionAdded = evt.type === "response.output_item.added" && evt.item?.type === "function_call";
    const isFunctionDone = evt.type === "response.output_item.done" && evt.item?.type === "function_call";
    const isFunctionArgs = evt.type === "response.function_call_arguments.delta" ||
      evt.type === "response.function_call_arguments.done";

    // Only normalize indices on function-call protocol events. Reasoning and
    // assistant text events are otherwise forwarded without shape changes.
    if (isFunctionAdded) {
      const key = this.itemKey(evt);
      let oi = finiteInt(evt.output_index);
      if (oi == null) oi = this.nextOutputIndex++;
      else this.nextOutputIndex = Math.max(this.nextOutputIndex, oi + 1);
      evt.output_index = oi;
      if (key) this.outputIndexByItem.set(key, oi);
    } else if ((isFunctionDone || isFunctionArgs) && evt.output_index === undefined) {
      const key = this.itemKey(evt);
      if (key && this.outputIndexByItem.has(key)) evt.output_index = this.outputIndexByItem.get(key);
    }

    return evt;
  }

  translate(line) {
    // Upstream blank lines are consumed because every JSON event we emit is
    // already terminated with \n\n. This makes framing deterministic.
    if (line === "") return [];

    if (!line.startsWith("data:")) {
      // Keep heartbeat comments as standalone SSE blocks; `event:` metadata is
      // unnecessary because Codex dispatches on the JSON `type` field.
      if (line.startsWith(":")) return [line + "\n\n"];
      return [];
    }

    const payload = line.slice(5).trimStart();
    if (!payload) return [];
    if (payload === "[DONE]") return ["data: [DONE]\n\n"];

    let evt;
    try { evt = JSON.parse(payload); }
    catch {
      // Preserve malformed upstream JSON as one correctly framed SSE event so
      // diagnostics stay truthful. Do not combine it with the next chunk.
      return ["data: " + payload + "\n\n"];
    }

    this.normalizeEventShape(evt);

    if (this.requestMeta.isCompaction && isReasoningStreamEvent(evt)) {
      if (typeof evt.delta === "string" && evt.type?.endsWith(".delta")) this.reasoningText += evt.delta;
      if (!this.reasoningText && evt.item?.type === "reasoning") this.reasoningText = reasoningTextFromObject(evt.item);
      return [];
    }

    if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
      this.text += evt.delta;
    }

    if (evt.type === "response.output_item.added" && evt.item?.type === "function_call") {
      this.sawToolCall = true;
    }

    if (evt.type === "response.output_item.added" && evt.item?.type === "message") {
      const id = this.itemKey(evt);
      if (id) this.messageItems.add(id);
      this.bufferedMessageEvents.push(this.event(evt));
      return [];
    }

    const messageItemId = this.itemKey(evt);
    const isMessageEvent = evt.item?.type === "message" ||
      (messageItemId && this.messageItems.has(messageItemId) && (
        evt.type.startsWith("response.output_text.") ||
        evt.type.startsWith("response.refusal.") ||
        evt.type.startsWith("response.content_part.") ||
        evt.type === "response.output_item.done"
      ));
    if (isMessageEvent) {
      this.bufferedMessageEvents.push(this.event(evt));
      return [];
    }

    // Codex custom/freeform tools are represented to llama.cpp as ordinary
    // function tools. Buffer ONLY that custom call's JSON arguments so we can
    // decode the wrapper back to freeform text. Normal messages, reasoning,
    // namespace calls and shell calls remain streaming and untouched.
    if (evt.type === "response.output_item.added" &&
      evt.item?.type === "function_call" &&
      typeof evt.item.name === "string" &&
      this.maps.customByName.has(evt.item.name)) {
      const id = evt.item.id || evt.item.call_id;
      this.customItems.set(id, {
        name: evt.item.name,
        args: "",
        output_index: evt.output_index ?? 0,
        call_id: evt.item.call_id || evt.item.id || id
      });
      return [];
    }

    if (evt.type === "response.function_call_arguments.delta" && this.customItems.has(evt.item_id)) {
      this.customItems.get(evt.item_id).args += evt.delta || "";
      return [];
    }

    if (evt.type === "response.function_call_arguments.done" && this.customItems.has(evt.item_id)) {
      const st = this.customItems.get(evt.item_id);
      if (typeof evt.arguments === "string") st.args = evt.arguments;
      return [];
    }

    if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
      const id = evt.item.id || evt.item.call_id;
      const st = this.customItems.get(id);
      if (st) {
        const name = st.name;
        const args = typeof evt.item.arguments === "string" ? evt.item.arguments : st.args;
        const input = decodeCustomArgs(name, args);
        const itemId = evt.item.id || evt.item.call_id || id;
        const callId = evt.item.call_id || evt.item.id || id;
        const oi = finiteInt(evt.output_index) ?? st.output_index ?? 0;
        const customItem = {
          id: itemId,
          call_id: callId,
          name,
          type: "custom_tool_call",
          input
        };
        this.customItems.delete(id);
        if (name === "apply_patch") diag("EDIT apply_patch via dedicated native tool (stream)");

        return [
          this.event({
            type: "response.output_item.added",
            output_index: oi,
            item: { ...customItem, input: "" }
          }),
          this.event({
            type: "response.custom_tool_call_input.delta",
            item_id: itemId,
            call_id: callId,
            output_index: oi,
            delta: input
          }),
          this.event({
            type: "response.custom_tool_call_input.done",
            item_id: itemId,
            call_id: callId,
            output_index: oi,
            input
          }),
          this.event({
            type: "response.output_item.done",
            output_index: oi,
            item: customItem
          })
        ];
      }
    }

    // Only compatibility rewriting below this point. In particular, reasoning
    // events are not renamed, buffered, summarized or converted.
    rewriteResponseObject(evt, this.maps);

    if (evt.type === "response.completed") {
      normalizeCompletedForCodex(evt);
      const usage = usageFrom(evt);
      const outputLimitHit = this.requestMeta.isCompaction &&
        (usage?.output_tokens || 0) >= COMPACT_MAX_OUTPUT_TOKENS;
      const outputCandidate = compactionCandidateText(this.text);
      const reasoningCandidate = bestCompactionCandidate(this.reasoningText, reasoningTextFromObject(evt.response));
      const compactCandidate = isValidCompactionText(outputCandidate) ? outputCandidate : bestCompactionCandidate(reasoningCandidate, outputCandidate);
      if (this.requestMeta.isCompaction && isValidCompactionText(compactCandidate) && !outputLimitHit && compactCandidate !== this.text.trim()) {
        this.bufferedMessageEvents = [];
        this.sawCompletedForwarded = true;
        diag(`COMPACTION_GUARD recovered_reasoning chars=${compactCandidate.length}; ${usageLine(usage)}`);
        if (this.requestMeta.checkpointPath) updateCheckpointSummary(this.requestMeta.checkpointPath, compactCandidate, usage);
        return this.recoveredCompactionEvents(evt, compactCandidate);
      }
      if (this.requestMeta.isCompaction && (!isValidCompactionText(compactCandidate) || outputLimitHit)) {
        const recovery = this.requestMeta.recoverySummary || buildCompactionRecoverySummary(null);
        const repaired = repairCompactionText(compactCandidate, recovery, outputLimitHit);
        const metrics = compactionTextMetrics(compactCandidate);
        this.bufferedMessageEvents = [];
        this.sawCompletedForwarded = true;
        diag(`COMPACTION_GUARD repaired_output chars=${compactCandidate.length} prefix=${Number(metrics.prefix)} headings=${metrics.present} ordered=${Number(metrics.ordered)} forbidden=${Number(metrics.forbidden)} output_limit_hit=${Number(outputLimitHit)}; ${usageLine(usage)}`);
        if (this.requestMeta.checkpointPath) updateCheckpointSummary(this.requestMeta.checkpointPath, repaired, usage);
        return this.recoveredCompactionEvents(evt, repaired);
      }
      const safeProgressIds = this.sawToolCall ? safeProgressMessageIds(evt.response) : new Set();
      const suppressed = this.sawToolCall ? suppressMessagesWithToolCalls(evt.response, safeProgressIds) : 0;
      const buffered = this.sawToolCall
        ? this.bufferedMessageEvents.filter(event => safeProgressIds.has(bufferedMessageEventId(event)))
        : this.bufferedMessageEvents;
      if (this.sawToolCall && this.bufferedMessageEvents.length) {
        diag(`TOOL_PROGRESS forwarded_messages=${safeProgressIds.size} forwarded_events=${buffered.length} suppressed_messages=${suppressed}`);
      }
      this.bufferedMessageEvents = [];
      this.sawCompletedForwarded = true;
      const kind = this.requestMeta.isCompaction ? "COMPACTION completed" : "response completed";
      diag(`${kind}; SSE_COMPLETED raw=1 forwarded=1; ${usageLine(usage)}`);
      if (this.requestMeta.isCompaction && this.requestMeta.checkpointPath) {
        const metrics = compactionTextMetrics(this.text);
        diag(`COMPACTION_SUMMARY accepted chars=${this.text.length} headings=${metrics.present} output_limit_hit=${Number((usage?.output_tokens || 0) >= COMPACT_MAX_OUTPUT_TOKENS)}`);
        updateCheckpointSummary(this.requestMeta.checkpointPath, this.text, usage);
      } else if (!this.sawToolCall && looksLikeProgressOnly(this.text)) {
        diag(`TURN_GUARD WARNING progress-only terminal assistant message=${JSON.stringify(this.text.slice(0, 500))}`);
      }
      if (!this.requestMeta.isCompaction && !this.sawToolCall) {
        rememberCompletedTask(this.requestMeta.memoryTask, this.text || responseTextFromObject(evt.response));
      }
      return [...buffered, this.event(evt)];
    } else if (evt.type === "response.failed" || evt.type === "error" || evt.type === "response.incomplete") {
      const kind = this.requestMeta.isCompaction ? "COMPACTION failed" : "response failed";
      let detail = "";
      try { detail = JSON.stringify(evt.error ?? evt).slice(0, 4000); } catch { }
      diag(`${kind}; ${detail}`);
    }

    return [this.event(evt)];
  }
}

function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(data.length),
    connection: "close"
  });
  res.end(data);
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.url === "/health") {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        upstream: UPSTREAM.origin
      });
    }

    const chunks = [];
    req.on("data", c => chunks.push(c));

    req.on("end", () => {
      let outbound = Buffer.concat(chunks);
      let maps = toolMaps();

      try {
        const decoded = decodeBody(outbound, req.headers["content-encoding"]);
        const isResponses =
          req.method === "POST" &&
          (req.url === "/v1/responses" || req.url === "/responses");

        let requestMeta = { isCompaction: false, requestBytes: decoded.length, cacheKey: "default", checkpointPath: null, fingerprint: "", memoryTask: null };

        if (isResponses && decoded.length) {
          const parsed = JSON.parse(decoded.toString("utf8"));
          requestMeta.isCompaction = isCompactionRequest(parsed);
          requestMeta.cacheKey = requestCacheKey(parsed);
          requestMeta.fingerprint = requestFingerprint(parsed);
          if (requestMeta.isCompaction) {
            requestMeta.checkpointPath = saveCheckpoint("compaction", { request: parsed });
            requestMeta.recoverySummary = buildCompactionRecoverySummary(parsed);
            if (requestMeta.checkpointPath) {
              CHECKPOINT_BY_KEY.set(requestMeta.cacheKey, requestMeta.checkpointPath);
              CHECKPOINT_BY_KEY.set(`model:${parsed.model || DEFAULT_MODEL}`, requestMeta.checkpointPath);
            }
          }

          const memory = memoryInstructionForRequest(parsed);
          requestMeta.memoryTask = memory.meta;
          const prepared = prepareRequest(parsed);
          if (memory.block) {
            prepared.body.instructions = `${String(prepared.body.instructions || "").trim()}\n\n${memory.block}`.trim();
            diag(`MEMORY injected count=${memory.count} chars=${memory.block.length} project=${JSON.stringify(memory.meta.project)}`);
          }
          maps = prepared.maps;

          if (prepared.historyRepairs.length) {
            const names = [...new Set(prepared.historyRepairs.map(x => x.name))];
            diag(`HISTORY repaired malformed function_call arguments count=${prepared.historyRepairs.length} names=${JSON.stringify(names)}`);
          }

          if (requestMeta.isCompaction) {
            applyCompactionPolicy(prepared.body);
            diag(`COMPACTION policy max_output_tokens=${COMPACT_MAX_OUTPUT_TOKENS} reasoning=${COMPACT_REASONING_EFFORT} thinking_budget=${COMPACT_REASONING_BUDGET}`);
          } else if (prepared.postCompactPruning?.foundSummary) {
            const checkpoint = checkpointForRequest(prepared.body, requestMeta.cacheKey, parsed.model);
            if (checkpoint && appendCheckpointHint(prepared.body, checkpoint)) {
              diag(`POST_COMPACT cold-memory hint=${checkpoint}`);
            }
            if (appendPostCompactContinuationRule(prepared.body)) diag("POST_COMPACT continuation_rule=1");
          }

          if (prepared.instructionNormalization.moved) {
            diag(
              `INSTRUCTIONS normalized moved=${prepared.instructionNormalization.moved} ` +
              `roles=[${prepared.instructionNormalization.roles.join(",")}]`
            );
          }

          if (prepared.postCompactPruning?.foundSummary) {
            const p = prepared.postCompactPruning;
            diag(
              `POST_COMPACT old-user limit=${POST_COMPACT_OLD_USER_TOKEN_LIMIT} ` +
              `before~=${p.beforeTokens} after~=${p.afterTokens} ` +
              `kept_current=${p.keptCurrent} current~=${p.currentTokens} ` +
              `kept_old=${p.keptOld} removed_old=${p.removed}`
            );
            const t = prepared.postCompactToolPruning;
            diag(`POST_COMPACT tool_outputs truncated=${t.truncated} before_chars=${t.beforeChars} after_chars=${t.afterChars} keep_recent=${POST_COMPACT_TOOL_OUTPUT_KEEP_RECENT} max_chars=${POST_COMPACT_TOOL_OUTPUT_MAX_CHARS}`);
          }

          const beforeTypes = Array.isArray(parsed.input)
            ? parsed.input.map(x => (x && typeof x === "object" ? (x.type || ("role:" + (x.role || "unknown"))) : typeof x))
            : [typeof parsed.input];

          const afterTypes = Array.isArray(prepared.body.input)
            ? prepared.body.input.map(x => (x && typeof x === "object" ? (x.type || ("role:" + (x.role || "unknown"))) : typeof x))
            : [typeof prepared.body.input];

          const kind = requestMeta.isCompaction ? "COMPACTION" : "response";
          diag(`${kind} request bytes=${decoded.length} input before=[${beforeTypes.join(",")}] after=[${afterTypes.join(",")}]`);

          outbound = Buffer.from(JSON.stringify(prepared.body));

          if (maps.namespaceByFlat.size || maps.customByName.size) {
            log(
              `tools: ${maps.namespaceByFlat.size} namespaced, ` +
              `${maps.customByName.size} custom/freeform`
            );
          }
        }

        const transport = UPSTREAM.protocol === "https:" ? https : http;
        const headers = copyHeaders(req.headers);
        if (UPSTREAM_API_KEY) headers.authorization = `Bearer ${UPSTREAM_API_KEY}`;
        headers["content-length"] = String(outbound.length);
        headers["accept-encoding"] = "identity";
        headers["connection"] = "close";

        let upstreamResponse = null;
        let upstreamFinished = false;
        let downstreamClosed = false;
        const ureq = transport.request({
          protocol: UPSTREAM.protocol,
          hostname: UPSTREAM.hostname,
          port: UPSTREAM.port || (UPSTREAM.protocol === "https:" ? 443 : 80),
          method: req.method,
          path: req.url,
          headers
        }, ures => {
          upstreamResponse = ures;
          const ct = String(ures.headers["content-type"] || "");
          const isSse = ct.includes("text/event-stream");

          if (isSse) {
            const rh = copyHeaders(ures.headers);
            rh["content-type"] = ct || "text/event-stream";
            rh["cache-control"] = ures.headers["cache-control"] || "no-cache";
            rh["connection"] = "close";
            res.writeHead(ures.statusCode || 200, rh);

            const tr = new SseTranslator(maps, requestMeta);
            ures.setEncoding("utf8");
            let pending = "";
            let sawResponseCompleted = false;
            let sawDoneMarker = false;
            let streamFinished = false;

            const finishBrokenStream = reason => {
              if (streamFinished) return;
              streamFinished = true;
              upstreamFinished = true;
              diag(reason);
              if (!res.writableEnded && !res.destroyed) res.end();
            };

            ures.on("aborted", () => {
              finishBrokenStream(`SSE_UPSTREAM_ABORT status=${ures.statusCode || 0} complete=${ures.complete ? 1 : 0}`);
            });
            ures.on("error", err => {
              finishBrokenStream(`SSE_UPSTREAM_ERROR status=${ures.statusCode || 0} error=${err.message}`);
            });

            ures.on("data", chunk => {
              pending += chunk;
              const lines = pending.split(/\r?\n/);
              pending = lines.pop() || "";

              for (const line of lines) {
                if (line.startsWith("data:")) {
                  const payload = line.slice(5).trimStart();
                  if (payload === "[DONE]") sawDoneMarker = true;
                  else {
                    try { if (JSON.parse(payload)?.type === "response.completed") sawResponseCompleted = true; } catch { }
                  }
                }
                for (const outLine of tr.translate(line)) res.write(outLine);
              }
            });

            ures.on("end", () => {
              if (streamFinished) return;
              streamFinished = true;
              upstreamFinished = true;
              if (pending) {
                if (pending.startsWith("data:")) {
                  const payload = pending.slice(5).trimStart();
                  if (payload === "[DONE]") sawDoneMarker = true;
                  else {
                    try { if (JSON.parse(payload)?.type === "response.completed") sawResponseCompleted = true; } catch { }
                  }
                }
                for (const outLine of tr.translate(pending)) res.write(outLine);
              }
              if (!sawResponseCompleted) {
                diag(`STREAM_END ERROR upstream_missing_completed status=${ures.statusCode || 0} done=${sawDoneMarker ? 1 : 0}`);
              } else if (!tr.sawCompletedForwarded) {
                diag(`STREAM_END ERROR proxy_did_not_forward_completed status=${ures.statusCode || 0}`);
              } else {
                diag(`STREAM_END OK raw_completed=1 forwarded_completed=1 done=${sawDoneMarker ? 1 : 0}`);
              }
              res.end();
            });
            return;
          }

          const rc = [];
          ures.on("data", c => rc.push(c));
          ures.on("aborted", () => {
            upstreamFinished = true;
            diag(`UPSTREAM_ABORT status=${ures.statusCode || 0} complete=${ures.complete ? 1 : 0}`);
            if (!res.writableEnded && !res.destroyed) res.destroy();
          });
          ures.on("error", err => {
            upstreamFinished = true;
            diag(`UPSTREAM_RESPONSE_ERROR status=${ures.statusCode || 0} error=${err.message}`);
            if (!res.writableEnded && !res.destroyed) res.destroy(err);
          });
          ures.on("end", () => {
            upstreamFinished = true;
            const raw = Buffer.concat(rc);
            let output = raw;

            if (String(ures.headers["content-type"] || "").includes("application/json") && raw.length) {
              try {
                const obj = JSON.parse(raw.toString("utf8"));
                rewriteResponseObject(obj, maps);
                const safeProgressIds = safeProgressMessageIds(obj);
                const suppressed = suppressMessagesWithToolCalls(obj, safeProgressIds);
                if (suppressed || safeProgressIds.size) {
                  diag(`TOOL_PROGRESS forwarded_messages=${safeProgressIds.size} suppressed_messages=${suppressed} nonstream=1`);
                }
                output = Buffer.from(JSON.stringify(obj));
                if ((ures.statusCode || 200) >= 400) {
                  const kind = requestMeta.isCompaction ? "COMPACTION upstream error" : "upstream error";
                  diag(`${kind} status=${ures.statusCode || 0} body=${output.toString("utf8").slice(0, 4000)}`);
                } else {
                  const kind = requestMeta.isCompaction ? "COMPACTION completed" : "response completed";
                  const usage = usageFrom(obj);
                  let responseText = responseTextFromObject(obj);
                  diag(`${kind}; ${usageLine(usage)}`);
                  if (requestMeta.isCompaction && requestMeta.checkpointPath) {
                    const outputLimitHit = (usage?.output_tokens || 0) >= COMPACT_MAX_OUTPUT_TOKENS;
                    const candidate = isValidCompactionText(compactionCandidateText(responseText))
                      ? compactionCandidateText(responseText)
                      : bestCompactionCandidate(reasoningTextFromObject(obj), responseText);
                    const compactText = isValidCompactionText(candidate) && !outputLimitHit
                      ? candidate
                      : repairCompactionText(candidate, requestMeta.recoverySummary, outputLimitHit);
                    if (compactText !== responseText) replaceResponseText(obj, compactText);
                    responseText = compactText;
                    updateCheckpointSummary(requestMeta.checkpointPath, responseText, usage);
                  } else if (looksLikeProgressOnly(responseText)) {
                    diag(`TURN_GUARD WARNING progress-only terminal assistant message=${JSON.stringify(responseText.slice(0, 500))}`);
                  }
                  const nonstreamOutput = obj?.response?.output || obj?.output || [];
                  if (!requestMeta.isCompaction && !nonstreamOutput.some(item => item?.type === "function_call" || item?.type === "custom_tool_call")) {
                    rememberCompletedTask(requestMeta.memoryTask, responseText);
                  }
                }
                output = Buffer.from(JSON.stringify(obj));
              } catch { }
            } else if ((ures.statusCode || 200) >= 400 && raw.length) {
              const kind = requestMeta.isCompaction ? "COMPACTION upstream error" : "upstream error";
              diag(`${kind} status=${ures.statusCode || 0} body=${raw.toString("utf8").slice(0, 4000)}`);
            }

            const rh = copyHeaders(ures.headers);
            rh["content-length"] = String(output.length);
            rh["connection"] = "close";
            res.writeHead(ures.statusCode || 200, rh);
            res.end(output);
          });
        });

        res.once("close", () => {
          if (res.writableEnded || upstreamFinished) return;
          downstreamClosed = true;
          diag("DOWNSTREAM_CLOSE aborting_upstream=1");
          if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
          if (!ureq.destroyed) ureq.destroy();
        });

        ureq.on("error", err => {
          upstreamFinished = true;
          if (downstreamClosed) return;
          diag(`UPSTREAM_REQUEST_ERROR error=${err.message}`);
          if (!res.headersSent && !res.destroyed) sendJson(res, 502, {
            error: "cannot connect to llama.cpp",
            upstream: UPSTREAM.origin,
            detail: err.message
          });
          else if (!res.writableEnded && !res.destroyed) res.end();
        });

        ureq.end(outbound);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, {
          error: "proxy error",
          detail: err.message
        });
        else res.end();
      }
    });
  });
}

function selftest() {
  const request = {
    model: "llm",
    input: [
      {
        type: "custom_tool_call",
        call_id: "c_old",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n"
      },
      {
        type: "custom_tool_call_output",
        call_id: "c_old",
        output: "Done"
      }
    ],
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Patch files",
        format: { type: "text" }
      },
      {
        type: "namespace",
        name: "mcp__demo",
        description: "demo",
        tools: [
          {
            type: "function",
            name: "ping",
            parameters: { type: "object", properties: {} }
          }
        ]
      },
      { type: "web_search" }
    ]
  };

  const p = prepareRequest(request);
  const ap = p.body.tools.find(x => x.name === "apply_patch");
  if (!ap || ap.type !== "function" || !ap.parameters?.properties?.patch) {
    throw new Error("apply_patch custom->function conversion failed");
  }
  const malformedPatch = "*** begin patch\n*** Update file: fixture.txt\n@@\n-old\n+new\n*** end patch";
  const normalizedPatch = decodeCustomArgs("apply_patch", JSON.stringify({ patch: malformedPatch }));
  if (!normalizedPatch.startsWith("*** Begin Patch\n*** Update File: fixture.txt") ||
    !normalizedPatch.endsWith("*** End Patch")) {
    throw new Error("apply_patch protocol header normalization failed");
  }
  if (!p.body.tools.find(x => x.name === "mcp__demo__ping")) {
    throw new Error("namespace flatten failed");
  }
  if (p.body.tools.some(x => x.type === "web_search")) {
    throw new Error("web_search removal failed");
  }
  if (p.body.input[0].type !== "function_call") {
    throw new Error("custom history call conversion failed");
  }
  if (p.body.input[1].type !== "function_call_output") {
    throw new Error("custom history output conversion failed");
  }

  const response = {
    output: [
      {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "apply_patch",
        arguments: JSON.stringify({
          patch: "*** Begin Patch\n*** Add File: b.txt\n+y\n*** End Patch\n"
        })
      },
      {
        id: "fc_2",
        type: "function_call",
        call_id: "call_2",
        name: "mcp__demo__ping",
        arguments: "{}"
      }
    ]
  };
  rewriteResponseObject(response, p.maps);

  if (response.output[0].type !== "custom_tool_call" ||
    response.output[0].input.indexOf("*** Begin Patch") === -1) {
    throw new Error("function->custom apply_patch response conversion failed");
  }
  if (response.output[1].namespace !== "mcp__demo" ||
    response.output[1].name !== "ping") {
    throw new Error("namespace response unflatten failed");
  }

  // Simulate a localized edit in a 3000-line file. The file size is irrelevant
  // to the native patch path: only the patch hunks cross the model/tool boundary.
  const largeFileLines = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`);
  const largePatch = [
    "*** Begin Patch",
    "*** Update File: large-3000.txt",
    "@@",
    `-${largeFileLines[1499]}`,
    "+line-1500-edited",
    "*** End Patch",
    ""
  ].join("\n");
  const largeResponse = {
    output: [{
      id: "fc_large",
      type: "function_call",
      call_id: "call_large",
      name: "apply_patch",
      arguments: JSON.stringify({ patch: largePatch })
    }]
  };
  rewriteResponseObject(largeResponse, p.maps);
  if (largeResponse.output[0].type !== "custom_tool_call" ||
    largeResponse.output[0].input !== largePatch) {
    throw new Error("3000-line apply_patch round-trip failed");
  }

  // Verify the streamed Responses path also preserves the complete patch.
  const tr = new SseTranslator(p.maps);
  const added = tr.translate("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "fc_stream", type: "function_call", call_id: "call_stream", name: "apply_patch", arguments: "" }
  }));
  if (added.length !== 0) throw new Error("streamed custom tool should be delayed");
  tr.translate("data: " + JSON.stringify({
    type: "response.function_call_arguments.done",
    item_id: "fc_stream",
    arguments: JSON.stringify({ patch: largePatch })
  }));
  const doneLines = tr.translate("data: " + JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: { id: "fc_stream", type: "function_call", call_id: "call_stream", name: "apply_patch", arguments: JSON.stringify({ patch: largePatch }) }
  }));
  const doneText = doneLines.join("");
  if (!doneText.includes('"type":"response.custom_tool_call_input.done"') ||
    !doneText.includes("line-1500-edited")) {
    throw new Error("streamed 3000-line apply_patch translation failed");
  }

  const shellReq = {
    tools: [{ type: "function", name: "shell_command", description: "Run shell", parameters: { type: "object" } }]
  };
  const shellPrepared = prepareRequest(shellReq);
  const shellTool = shellPrepared.body.tools.find(x => x.name === "shell_command");
  if (!shellTool?.description?.includes("NEVER invoke apply_patch through this shell tool") ||
    !shellTool.description.includes("3000+ line files") ||
    shellTool.description.includes("Fallback form:")) {
    throw new Error("shell editing guidance injection failed");
  }

  if (!looksLikeDirectFileWrite('Set-Content -Path "x.js" -Value $code') ||
    !looksLikeDirectFileWrite('[System.IO.File]::WriteAllText("x.js", $code)') ||
    looksLikeDirectFileWrite('Get-Content x.js | Select-Object -First 20')) {
    throw new Error("direct file-write detection failed");
  }

  function parseSseJsonEvents(chunks) {
    const text = chunks.join("");
    return text.split(/\r?\n\r?\n/).filter(block => block.trim()).map(block => {
      const data = block.split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return data;
      return JSON.parse(data);
    });
  }

  // v16.0-v16.2 bug regression: one function call was expanded into four
  // `data:` lines without blank separators, making EventSource concatenate them
  // into one invalid JSON event. Every synthetic event must now parse alone.
  const customFramed = parseSseJsonEvents(doneLines);
  if (customFramed.length !== 4 ||
    customFramed[0]?.type !== "response.output_item.added" ||
    customFramed[1]?.type !== "response.custom_tool_call_input.delta" ||
    customFramed[2]?.type !== "response.custom_tool_call_input.done" ||
    customFramed[3]?.type !== "response.output_item.done") {
    throw new Error(`custom tool SSE framing failed: ${JSON.stringify(customFramed.map(x => x?.type || x))}`);
  }

  const shellPatchCommand = `apply_patch <<'PATCH'\n${largePatch}PATCH`;
  const shellAsShell = {
    output: [{
      id: "fc_shell_patch",
      type: "function_call",
      call_id: "call_shell_patch",
      name: "shell_command",
      arguments: JSON.stringify({ command: shellPatchCommand })
    }]
  };
  rewriteResponseObject(shellAsShell, p.maps);
  if (shellAsShell.output[0].type !== "function_call" || shellAsShell.output[0].name !== "shell_command") {
    throw new Error("ordinary shell/apply_patch wrapper must not be intercepted by protocol bridge");
  }

  // Ordinary shell calls must stream immediately. No buffering, replay or
  // promotion is allowed because those mechanisms can disturb event framing.
  const shellStream = new SseTranslator(p.maps);
  const shellAdded = shellStream.translate("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "fc_shell_stream", type: "function_call", call_id: "call_shell_stream", name: "shell_command", arguments: "" }
  }));
  const shellArgs = shellStream.translate("data: " + JSON.stringify({
    type: "response.function_call_arguments.done",
    item_id: "fc_shell_stream",
    arguments: JSON.stringify({ command: shellPatchCommand })
  }));
  const shellDone = shellStream.translate("data: " + JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: { id: "fc_shell_stream", type: "function_call", call_id: "call_shell_stream", name: "shell_command", arguments: JSON.stringify({ command: shellPatchCommand }) }
  }));
  if (shellAdded.length !== 1 || shellArgs.length !== 1 || shellDone.length !== 1 ||
    !shellAdded[0].includes('"name":"shell_command"') ||
    !shellDone[0].includes('"name":"shell_command"')) {
    throw new Error("ordinary shell stream transparency failed");
  }
  for (const part of [shellAdded, shellArgs, shellDone]) parseSseJsonEvents(part);

  // Thinking/reasoning events must pass through without renaming, buffering or
  // content mutation.
  const reasoningStream = new SseTranslator(p.maps);
  const reasoningOriginal = {
    type: "response.reasoning_text.delta",
    item_id: "reasoning_1",
    delta: "inspect graph"
  };
  const reasoningOut = reasoningStream.translate("data: " + JSON.stringify(reasoningOriginal));
  const reasoningParsed = parseSseJsonEvents(reasoningOut);
  if (reasoningParsed.length !== 1 || JSON.stringify(reasoningParsed[0]) !== JSON.stringify(reasoningOriginal)) {
    throw new Error(`reasoning SSE transparency failed: ${JSON.stringify(reasoningParsed)}`);
  }

  // response.completed must itself be one parseable event. An incomplete usage
  // object is discarded (usage is optional) rather than poisoning completion.
  const completedStream = new SseTranslator(p.maps);
  const completedOut = completedStream.translate("data: " + JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_selftest",
      status: "completed",
      usage: { input_tokens: 10 }
    }
  }));
  const completedParsed = parseSseJsonEvents(completedOut);
  if (completedParsed.length !== 1 || completedParsed[0]?.type !== "response.completed" ||
    completedParsed[0]?.response?.id !== "resp_selftest" ||
    completedParsed[0]?.response?.usage !== undefined ||
    completedStream.sawCompletedForwarded !== true) {
    throw new Error("response.completed framing/normalization failed");
  }

  const expectedBudgets = { low: REASONING_BUDGET_LOW, medium: REASONING_BUDGET_MEDIUM, high: REASONING_BUDGET_HIGH, xhigh: REASONING_BUDGET_XHIGH };
  for (const effort of SUPPORTED_REASONING_LEVELS) {
    const prepared = prepareRequest({ model: "llm", input: "probe", reasoning: { effort } });
    if (prepared.body.reasoning?.effort !== effort) {
      throw new Error(`reasoning passthrough failed for ${effort}`);
    }
    if (expectedBudgets[effort] > 0 && prepared.body.thinking_budget_tokens !== expectedBudgets[effort]) {
      throw new Error(`reasoning budget failed for ${effort}: got ${prepared.body.thinking_budget_tokens}`);
    }
  }
  const missingEffort = prepareRequest({ model: "llm", input: "probe" });
  const defaultBudget = reasoningBudgetForEffort(DEFAULT_REASONING_EFFORT);
  if (defaultBudget > 0 && missingEffort.body.thinking_budget_tokens !== defaultBudget) {
    throw new Error("missing-effort default budget failed");
  }
  const staleHigh = prepareRequest({ model: "llm", input: "probe", reasoning: { effort: "high" } });
  if (REASONING_HIGH_MAP !== "high" && staleHigh.body.reasoning?.effort !== REASONING_HIGH_MAP) {
    throw new Error("reasoning high-effort mapping failed");
  }

  const profileDefaults = prepareRequest({ model: DEFAULT_MODEL, input: "probe", parallel_tool_calls: true });
  if (FORCE_SERIAL_TOOL_CALLS && profileDefaults.body.parallel_tool_calls !== false) {
    throw new Error("serial tool-call enforcement failed");
  }
  if (usesTemplateThinking(profileDefaults.body) &&
    (profileDefaults.body.chat_template_kwargs?.enable_thinking !== true ||
      profileDefaults.body.chat_template_kwargs?.preserve_thinking !== true)) {
    throw new Error("template thinking defaults failed");
  }
  const explicitThinking = prepareRequest({
    model: "llm",
    input: "probe",
    chat_template_kwargs: { enable_thinking: false, preserve_thinking: false }
  });
  if (explicitThinking.body.chat_template_kwargs.enable_thinking !== false ||
    explicitThinking.body.chat_template_kwargs.preserve_thinking !== false) {
    throw new Error("explicit Qwen chat_template_kwargs were overwritten");
  }

  // Progress-only assistant messages must never be converted into a fake
  // transport failure. response.completed must always reach Codex.
  const progress = new SseTranslator(p.maps, {
    isCompaction: false,
    fingerprint: "selftest-progress-forward"
  });
  progress.translate("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "msg_progress", type: "message", role: "assistant", content: [] }
  }));
  progress.translate("data: " + JSON.stringify({
    type: "response.output_text.delta",
    item_id: "msg_progress",
    output_index: 0,
    content_index: 0,
    delta: "I'll inspect the repository now."
  }));
  progress.translate("data: " + JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: { id: "msg_progress", type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll inspect the repository now." }] }
  }));
  const progressCompleted = progress.translate("data: " + JSON.stringify({
    type: "response.completed",
    response: { id: "resp_progress", status: "completed", output: [] }
  }));
  if (!progressCompleted.join("").includes('"type":"response.completed"')) {
    throw new Error("progress-only response.completed was swallowed");
  }

  const toolChatter = new SseTranslator(p.maps);
  toolChatter.translate("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "msg_tool", type: "message", role: "assistant", content: [] }
  }));
  toolChatter.translate("data: " + JSON.stringify({
    type: "response.output_text.delta",
    item_id: "msg_tool",
    output_index: 0,
    content_index: 0,
    delta: "I'll inspect another file."
  }));
  toolChatter.translate("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 1,
    item: { id: "fc_tool", type: "function_call", call_id: "call_tool", name: "shell_command", arguments: "" }
  }));
  const toolChatterCompleted = parseSseJsonEvents(toolChatter.translate("data: " + JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_tool_chatter",
      status: "completed",
      output: [
        { id: "msg_tool", type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll inspect another file." }] },
        { id: "fc_tool", type: "function_call", call_id: "call_tool", name: "shell_command", arguments: "{}" }
      ]
    }
  })));
  if (FORWARD_TOOL_PROGRESS &&
    (toolChatterCompleted.length !== 3 ||
      toolChatterCompleted[0]?.type !== "response.output_item.added" ||
      toolChatterCompleted[1]?.type !== "response.output_text.delta" ||
      !toolChatterCompleted[2]?.response?.output?.some(x => x.type === "message"))) {
    throw new Error("safe tool-progress forwarding failed");
  }
  if (!FORWARD_TOOL_PROGRESS &&
    (toolChatterCompleted.length !== 1 ||
      toolChatterCompleted[0]?.response?.output?.some(x => x.type === "message"))) {
    throw new Error("disabled tool-progress suppression failed");
  }

  const unsafeProgress = {
    output: [
      { id: "msg_reasoning", type: "message", role: "assistant", content: [{ type: "output_text", text: "Wait, I need to reason through every branch before I call the tool." }] },
      { id: "fc_reasoning", type: "function_call", call_id: "call_reasoning", name: "shell_command", arguments: "{}" }
    ]
  };
  const unsafeIds = safeProgressMessageIds(unsafeProgress);
  suppressMessagesWithToolCalls(unsafeProgress, unsafeIds);
  if (unsafeProgress.output.some(x => x.type === "message")) {
    throw new Error("unsafe tool chatter was forwarded");
  }

  const finalMessage = new SseTranslator(p.maps);
  finalMessage.translate("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "msg_final", type: "message", role: "assistant", content: [] }
  }));
  finalMessage.translate("data: " + JSON.stringify({
    type: "response.output_text.delta",
    item_id: "msg_final",
    output_index: 0,
    content_index: 0,
    delta: "Готово."
  }));
  const finalMessageCompleted = parseSseJsonEvents(finalMessage.translate("data: " + JSON.stringify({
    type: "response.completed",
    response: { id: "resp_final", status: "completed", output: [] }
  })));
  if (finalMessageCompleted.length !== 3 ||
    finalMessageCompleted[0]?.type !== "response.output_item.added" ||
    finalMessageCompleted[1]?.type !== "response.output_text.delta" ||
    finalMessageCompleted[2]?.type !== "response.completed") {
    throw new Error("final assistant message buffering failed");
  }

  const validCheckpoint = [
    "# CONTEXT CHECKPOINT SUMMARY",
    "## CURRENT TASK", "Task.",
    "## WORK COMPLETED", "Done.",
    "## DECISIONS AND CONSTRAINTS", "Constraints.",
    "## STATE SNAPSHOT", "State.",
    "## OPEN ISSUES", "Issues.",
    "## PARKED TASKS", "None.",
    "## NEXT ACTION", "Continue."
  ].join("\n");
  if (!isValidCompactionText(validCheckpoint) || isValidCompactionText(`${validCheckpoint}\n<tool_call>`)) {
    throw new Error("compaction output validation failed");
  }
  const markdownCheckpoint = [
    "# CONTEXT CHECKPOINT SUMMARY",
    "## CURRENT TASK",
    "Текущая задача",
    "## WORK COMPLETED",
    "Выполненная работа",
    "## DECISIONS AND CONSTRAINTS",
    "Ограничения",
    "## STATE SNAPSHOT",
    "Состояние",
    "## OPEN ISSUES",
    "Открытые вопросы",
    "## PARKED TASKS",
    "Нет.",
    "## NEXT ACTION",
    "Продолжить."
  ].join("\n");
  if (!isValidCompactionText(markdownCheckpoint)) {
    throw new Error("markdown compaction output validation failed");
  }
  const preservedCheckpoint = buildCompactionRecoverySummary({
    input: [{
      role: "user",
      content: [{ type: "input_text", text: `Another language model started to solve this problem.\n${markdownCheckpoint}` }]
    }]
  });
  if (!isValidCompactionText(preservedCheckpoint) || preservedCheckpoint === markdownCheckpoint ||
    !preservedCheckpoint.includes("восстановительный fallback")) {
    throw new Error("stale checkpoint fallback detection failed");
  }
  const freshReasoningCheckpoint = markdownCheckpoint.replace("Текущая задача", "Свежая задача после последних инструментов");
  const reasoningOnlyCompaction = new SseTranslator(p.maps, { isCompaction: true, recoverySummary: preservedCheckpoint });
  const hiddenReasoning = reasoningOnlyCompaction.translate("data: " + JSON.stringify({
    type: "response.reasoning_text.delta",
    item_id: "reasoning_compaction",
    delta: freshReasoningCheckpoint
  }));
  if (hiddenReasoning.length !== 0) throw new Error("compaction reasoning leaked downstream");
  const recoveredReasoning = parseSseJsonEvents(reasoningOnlyCompaction.translate("data: " + JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_reasoning_compaction",
      status: "completed",
      output: [{ id: "reasoning_compaction", type: "reasoning", content: [{ type: "reasoning_text", text: freshReasoningCheckpoint }] }],
      usage: { input_tokens: 100, output_tokens: 300, total_tokens: 400 }
    }
  })));
  if (recoveredReasoning.length !== 7 || recoveredReasoning[2]?.delta !== freshReasoningCheckpoint ||
    recoveredReasoning[6]?.response?.output?.[0]?.content?.[0]?.text !== freshReasoningCheckpoint) {
    throw new Error("reasoning-only compaction recovery failed");
  }
  const wrappedCheckpoint = `Another language model started to solve this problem and produced a summary of its thinking process.\n${markdownCheckpoint}`;
  const checkpointHash = checkpointSummaryHash(wrappedCheckpoint);
  if (!checkpointHash || checkpointHash !== checkpointSummaryHash(`${wrappedCheckpoint}\n\n[COLD MEMORY: test]`)) {
    throw new Error("checkpoint summary identity normalization failed");
  }
  CHECKPOINT_BY_SUMMARY.set(checkpointHash, "checkpoint-selftest.json");
  const matchedCheckpoint = checkpointForRequest({ input: [{ role: "user", content: wrappedCheckpoint }] }, "missing", DEFAULT_MODEL);
  CHECKPOINT_BY_SUMMARY.delete(checkpointHash);
  if (matchedCheckpoint !== "checkpoint-selftest.json") {
    throw new Error("checkpoint summary identity lookup failed");
  }
  const recoverySummary = buildCompactionRecoverySummary({
    input: [{ role: "user", content: [{ type: "input_text", text: "Продолжить проверку проекта" }] }]
  });
  const invalidCompaction = new SseTranslator(p.maps, { isCompaction: true, recoverySummary });
  invalidCompaction.translate("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "msg_bad_compaction", type: "message", role: "assistant", content: [] }
  }));
  invalidCompaction.translate("data: " + JSON.stringify({
    type: "response.output_text.delta",
    item_id: "msg_bad_compaction",
    output_index: 0,
    content_index: 0,
    delta: "<tool_call><function=shell_command>"
  }));
  const recoveredCompaction = parseSseJsonEvents(invalidCompaction.translate("data: " + JSON.stringify({
    type: "response.completed",
    response: { id: "resp_bad_compaction", status: "completed", output: [] }
  })));
  if (recoveredCompaction.length !== 7 ||
    recoveredCompaction.some(event => JSON.stringify(event).includes("<tool_call>")) ||
    recoveredCompaction[2]?.delta !== repairCompactionText("<tool_call><function=shell_command>", recoverySummary) ||
    recoveredCompaction[6]?.response?.output?.[0]?.content?.[0]?.text !== repairCompactionText("<tool_call><function=shell_command>", recoverySummary)) {
    throw new Error("invalid compaction recovery failed");
  }

  const clippedCheckpoint = `${validCheckpoint}\nНезавершённый фрагмент`;
  const repairedClipped = repairCompactionText(clippedCheckpoint, recoverySummary, true);
  if (!isValidCompactionText(repairedClipped) || repairedClipped.endsWith("Незавершённый фрагмент")) {
    throw new Error("truncated compaction repair failed");
  }

  const compactProbe = {
    input: [
      { type: "function_call", call_id: "broken_call", name: "fetch_url", arguments: '{"url":"https://ghcr.io/v2/' },
      { role: "user", content: [{ type: "input_text", text: "You are performing a CONTEXT CHECKPOINT COMPACTION." }] }
    ]
  };
  if (!isCompactionRequest(compactProbe)) {
    throw new Error("compaction request detection failed");
  }
  if (isCompactionRequest({
    input: [
      { role: "user", content: [{ type: "input_text", text: "Another language model started to solve this problem. CONTEXT CHECKPOINT SUMMARY" }] },
      { role: "user", content: [{ type: "input_text", text: "Продолжай обычную работу" }] }
    ]
  })) {
    throw new Error("historical summary was misclassified as a compaction request");
  }
  const compactCapped = prepareRequest(compactProbe);
  applyCompactionPolicy(compactCapped.body, 4096);
  if (compactCapped.body.max_output_tokens !== 4096) {
    throw new Error("compaction max_output_tokens cap failed");
  }
  if (compactCapped.historyRepairs.length !== 1 || compactCapped.body.input[0].arguments !== "{}") {
    throw new Error("malformed historical function call repair failed");
  }

  const mixedInstructions = prepareRequest({
    model: "llm",
    instructions: "BASE INSTRUCTIONS",
    input: [
      { role: "user", content: [{ type: "input_text", text: "first user" }] },
      { role: "system", content: [{ type: "input_text", text: "MID SYSTEM" }] },
      { role: "assistant", content: [{ type: "output_text", text: "assistant reply" }] },
      { role: "developer", content: [{ type: "input_text", text: "DEV RULES" }] },
      { role: "system", content: [{ type: "input_text", text: "MID SYSTEM" }] },
      { role: "user", content: "second user" }
    ]
  });

  if (mixedInstructions.body.input.some(x =>
    x && typeof x === "object" &&
    (String(x.role || "").toLowerCase() === "system" ||
      String(x.role || "").toLowerCase() === "developer"))) {
    throw new Error("system/developer message remained in Responses history");
  }
  if (!mixedInstructions.body.instructions.startsWith("BASE INSTRUCTIONS\n\nMID SYSTEM\n\nDEV RULES")) {
    throw new Error("system/developer instruction merge failed");
  }
  if (mixedInstructions.instructionNormalization.moved !== 3) {
    throw new Error("instruction normalization count failed");
  }
  if (mixedInstructions.body.input.length !== 3 ||
    mixedInstructions.body.input[0].role !== "user" ||
    mixedInstructions.body.input[1].role !== "assistant" ||
    mixedInstructions.body.input[2].role !== "user") {
    throw new Error("instruction normalization changed ordinary history order");
  }

  const summaryPrefix = COMPACT_SUMMARY_PREFIXES[0];
  const postCompact = {
    model: "llm",
    input: [
      { role: "user", content: "OLD USER A".repeat(1200) },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "canonical/non-user context marker" }] },
      { role: "user", content: "CURRENT USER REQUEST: fix the collision regression exactly" },
      { role: "user", content: summaryPrefix + "\ncompact summary" }
    ]
  };
  const prune = prunePostCompactionUserHistory(postCompact, 0);
  if (!prune.foundSummary || prune.removed !== 1 || prune.keptCurrent !== 1 || prune.keptOld !== 0) {
    throw new Error(`post-compaction history pruning failed: ${JSON.stringify(prune)}`);
  }
  const texts = postCompact.input.map(x => messageContentText(x.content));
  if (texts.some(x => x.startsWith("OLD USER A")) ||
    !texts.includes("canonical/non-user context marker") ||
    !texts.includes("CURRENT USER REQUEST: fix the collision regression exactly") ||
    !postCompact.input.some(isCompactionSummaryItem)) {
    throw new Error("post-compaction pruning lost current task/canonical context or kept stale user history");
  }
  const postCompactTools = {
    instructions: "BASE",
    input: [
      { role: "user", content: summaryPrefix + "\ncompact summary" },
      { type: "function_call_output", output: "A".repeat(9000) },
      { type: "custom_tool_call_output", output: "B".repeat(8000) },
      { type: "function_call_output", output: "RECENT_ONE" },
      { type: "custom_tool_call_output", output: "RECENT_TWO" }
    ]
  };
  const toolPrune = prunePostCompactionToolOutputs(postCompactTools, 1200, 2);
  if (toolPrune.truncated !== 2 || postCompactTools.input[1].output.length !== 1200 ||
    postCompactTools.input[2].output.length !== 1200 ||
    postCompactTools.input[3].output !== "RECENT_ONE" || postCompactTools.input[4].output !== "RECENT_TWO" ||
    !postCompactTools.input[1].output.includes("POST-COMPACTION TOOL OUTPUT TRUNCATED")) {
    throw new Error(`post-compaction tool output pruning failed: ${JSON.stringify(toolPrune)}`);
  }
  if (!appendPostCompactContinuationRule(postCompactTools) || appendPostCompactContinuationRule(postCompactTools) ||
    !postCompactTools.instructions.includes("Treat every item in WORK COMPLETED as finished")) {
    throw new Error("post-compaction continuation rule failed");
  }

  if (compactCapped.body.reasoning?.effort !== COMPACT_REASONING_EFFORT ||
    (COMPACT_REASONING_BUDGET > 0 && compactCapped.body.thinking_budget_tokens !== COMPACT_REASONING_BUDGET) ||
    (usesTemplateThinking(compactCapped.body) && compactCapped.body.chat_template_kwargs?.enable_thinking !== false) ||
    (usesTemplateThinking(compactCapped.body) && compactCapped.body.chat_template_kwargs?.preserve_thinking !== false) ||
    compactCapped.body.tool_choice !== "none" ||
    compactCapped.body.parallel_tool_calls !== false) {
    throw new Error("compaction non-thinking/serial/no-tools policy failed");
  }

  if (!looksLikeProgressOnly("I'll check the files first and then continue.")) {
    throw new Error("progress-only terminal detector failed");
  }

  const memoryTemp = fs.mkdtempSync(path.join(require("os").tmpdir(), "codex-memory-selftest-"));
  let memoryStore = new MemoryStore(memoryTemp, true);
  try {
    memoryStore.upsert({
      id: "memory-selftest",
      project: "C:/work/rublox",
      problem: "BotBrain syntax error after optimization",
      outcome: "Restored the missing class brace and verified all JavaScript files",
      evidence: ["NODE_CHECK_ALL_TRACKED_JS=PASS"],
      files: ["entities/BotBrain.js"],
      keywords: memoryTokens("BotBrain syntax error optimization missing brace JavaScript"),
      confidence: 1
    });
    memoryStore.close();
    memoryStore = new MemoryStore(memoryTemp, true);
    const recalled = memoryStore.search("Fix another BotBrain JavaScript syntax error", "C:/work/rublox", 3);
    if (recalled.length !== 1 || recalled[0].id !== "memory-selftest") throw new Error("episodic memory retrieval failed");
    const priorMemoryStore = MEMORY_STORE;
    MEMORY_STORE = memoryStore;
    MEMORY_INJECTED_TASKS.clear();
    const memoryRequest = {
      instructions: "<environment_context><cwd>C:/work/rublox</cwd></environment_context>",
      input: [{ id: "memory-task-1", role: "user", content: [{ type: "input_text", text: "Fix another BotBrain JavaScript syntax error" }] }]
    };
    const recalledRequest = memoryInstructionForRequest(memoryRequest);
    if (recalledRequest.count !== 1 || !recalledRequest.block.includes("memory-selftest") || recalledRequest.block.length > MEMORY_MAX_CHARS) {
      throw new Error("episodic memory cross-session injection failed");
    }
    const repeatedRequest = memoryInstructionForRequest(memoryRequest);
    const regressionRequest = memoryInstructionForRequest({
      instructions: "<environment_context><cwd>C:/work/rublox</cwd></environment_context>",
      input: [{ id: "memory-task-2", role: "user", content: "Ошибка BotBrain снова появилась, исправление не работает" }]
    });
    const compactedMemoryRequest = memoryInstructionForRequest({
      instructions: "<environment_context><cwd>C:/work/rublox</cwd></environment_context>",
      input: [
        { id: "memory-task-3", role: "user", content: "Fix another BotBrain JavaScript syntax error" },
        { role: "user", content: summaryPrefix + "\ncompact summary" }
      ]
    });
    MEMORY_STORE = priorMemoryStore;
    MEMORY_INJECTED_TASKS.clear();
    if (repeatedRequest.count || regressionRequest.count || compactedMemoryRequest.count) {
      throw new Error("episodic memory repeat/regression/post-compaction guard failed");
    }
    const memoryMeta = memoryRequestMeta({ input: [
      { role: "user", content: [{ type: "input_text", text: "Fix BotBrain syntax" }] },
      { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: entities/BotBrain.js\n*** End Patch" },
      { type: "function_call_output", output: "NODE_CHECK_ALL_TRACKED_JS=PASS\n[main abc1234] fix syntax" }
    ] });
    if (!memoryMeta.hasTest || !memoryMeta.hasCommit || memoryMeta.files[0] !== "entities/BotBrain.js") {
      throw new Error("episodic memory evidence extraction failed");
    }
    if (!memorySanitize("api_key=super-secret-value https://user:pass@example.com").includes("https://user:[REDACTED]@example.com")) throw new Error("episodic memory secret redaction failed");
    if (!memoryStore.forget("memory-selftest") || memoryStore.all().length) throw new Error("episodic memory deletion failed");
  } finally {
    memoryStore.close();
    fs.rmSync(memoryTemp, { recursive: true, force: true });
  }

  console.log(`SELFTEST PASS ${VERSION}`);
}

function runMemoryCli() {
  const listIndex = process.argv.indexOf("--memory-list");
  const forgetIndex = process.argv.indexOf("--memory-forget");
  if (listIndex < 0 && forgetIndex < 0) return false;
  const store = getMemoryStore();
  if (!store) throw new Error("episodic memory is disabled");
  if (forgetIndex >= 0) {
    const id = process.argv[forgetIndex + 1];
    if (!id) throw new Error("--memory-forget requires an id");
    console.log(store.forget(id) ? `FORGOT ${id}` : `NOT FOUND ${id}`);
    return true;
  }
  const projectArg = process.argv[listIndex + 1];
  const project = projectArg && !projectArg.startsWith("--") ? memoryProject(projectArg) : "";
  const items = store.all(2000).filter(item => !project || memoryProject(item.project) === project);
  console.log(JSON.stringify(items, null, 2));
  return true;
}

if (process.argv.includes("--selftest")) {
  selftest();
} else if (runMemoryCli()) {
  process.exitCode = 0;
} else {
  restoreCheckpointIndex();
  const server = createServer();
  server.on("error", err => {
    diag(`SERVER_ERROR code=${err.code || "unknown"} error=${err.message}`);
    console.error(`[codex-llama-proxy] cannot listen on http://${HOST}:${PORT}: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    log(`${VERSION} listening on http://${HOST}:${PORT}`);
    log(`forwarding to ${UPSTREAM.origin}`);
    log(`health: http://${HOST}:${PORT}/health`);
  });
}
