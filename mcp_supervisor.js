#!/usr/bin/env node
"use strict";

const fs = require("fs");
const readline = require("readline");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator < 0 || separator === argv.length - 1) {
  process.stderr.write("usage: node mcp_supervisor.js [--retry-inflight] -- command [args...]\n");
  process.exit(2);
}

const options = new Set(argv.slice(0, separator));
const command = argv[separator + 1];
const commandArgs = argv.slice(separator + 2);
const retryAllInflight = options.has("--retry-inflight") || process.env.MCP_SUPERVISOR_RETRY_INFLIGHT === "1";
const requestTimeoutMs = Math.max(0, Number(process.env.MCP_SUPERVISOR_REQUEST_TIMEOUT_MS || 300000));
const restartBaseMs = Math.max(50, Number(process.env.MCP_SUPERVISOR_RESTART_BASE_MS || 250));
const restartMaxMs = Math.max(restartBaseMs, Number(process.env.MCP_SUPERVISOR_RESTART_MAX_MS || 10000));
const maxRequestRetries = Math.max(0, Number(process.env.MCP_SUPERVISOR_MAX_REQUEST_RETRIES || 1));
const name = process.env.MCP_SUPERVISOR_NAME || command;
const logPath = process.env.MCP_SUPERVISOR_LOG || "";

let child = null;
let childGeneration = 0;
let handledGeneration = 0;
let restartAttempt = 0;
let restartTimer = null;
let internalInitTimer = null;
let stopping = false;
let childReady = false;
let parentInitialized = false;
let initializeMessage = null;
let initializedNotification = null;
let pendingInitialEntry = null;
let recoveryQueue = [];
let waitQueue = [];
const pending = new Map();
const readOnlyTools = new Set();

function log(message) {
  const line = `[${new Date().toISOString()}] [${name}] ${message}\n`;
  process.stderr.write(line);
  if (logPath) {
    try {
      fs.appendFileSync(logPath, line, "utf8");
    } catch {}
  }
}

function keyOf(id) {
  return JSON.stringify(id);
}

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function emitRestartError(entry, detail) {
  if (entry.msg.id === undefined) return;
  emit({
    jsonrpc: "2.0",
    id: entry.msg.id,
    error: {
      code: -32098,
      message: `MCP server restarted before completing the request: ${detail}`,
      data: { retryable: true, server: name }
    }
  });
}

function parseLine(line, source) {
  try {
    return JSON.parse(line);
  } catch (error) {
    log(`${source} emitted invalid JSON: ${error.message}`);
    return null;
  }
}

function clearEntryTimer(entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
}

function trackEntry(entry) {
  if (entry.msg.id === undefined) return;
  const key = keyOf(entry.msg.id);
  clearEntryTimer(entry);
  if (requestTimeoutMs > 0 && entry.msg.method !== "initialize") {
    entry.timer = setTimeout(() => {
      if (pending.get(key) !== entry || !child) return;
      log(`request timed out method=${entry.msg.method || "response"}; restarting child`);
      child.kill();
    }, requestTimeoutMs);
  }
  pending.set(key, entry);
}

function writeEntry(entry) {
  if (!child || !child.stdin.writable || !childReady && entry.msg.method !== "initialize") {
    waitQueue.push(entry);
    return;
  }
  entry.generation = childGeneration;
  trackEntry(entry);
  child.stdin.write(entry.line + "\n");
}

function isRetryable(entry) {
  if (entry.retries >= maxRequestRetries) return false;
  if (entry.msg.method !== "tools/call") return true;
  return retryAllInflight || readOnlyTools.has(String(entry.msg.params?.name || ""));
}

function flushQueues() {
  const entries = recoveryQueue.concat(waitQueue);
  recoveryQueue = [];
  waitQueue = [];
  for (const entry of entries) writeEntry(entry);
}

function markReady() {
  childReady = true;
  restartAttempt = 0;
  if (initializedNotification && child?.stdin.writable) {
    child.stdin.write(JSON.stringify(initializedNotification) + "\n");
  }
  flushQueues();
  log(`child ready pid=${child?.pid || 0}`);
}

function handleChildMessage(line, generation, replayInitId) {
  if (generation !== childGeneration) return;
  const msg = parseLine(line, "child");
  if (!msg) return;
  let becameReady = false;
  if (replayInitId !== null && msg.id === replayInitId) {
    if (internalInitTimer) clearTimeout(internalInitTimer);
    internalInitTimer = null;
    markReady();
    return;
  }
  if (msg.id !== undefined) {
    const key = keyOf(msg.id);
    const entry = pending.get(key);
    if (entry) {
      pending.delete(key);
      clearEntryTimer(entry);
      if (entry.msg.method === "initialize") {
        parentInitialized = true;
        pendingInitialEntry = null;
        becameReady = true;
      }
      if (entry.msg.method === "tools/list" && Array.isArray(msg.result?.tools)) {
        readOnlyTools.clear();
        for (const tool of msg.result.tools) {
          if (tool?.annotations?.readOnlyHint === true) readOnlyTools.add(String(tool.name));
        }
      }
    }
  }
  process.stdout.write(line + "\n");
  if (becameReady) markReady();
}

function finishChild(generation, detail) {
  if (generation !== childGeneration || handledGeneration === generation || stopping) return;
  handledGeneration = generation;
  childReady = false;
  child = null;
  if (internalInitTimer) clearTimeout(internalInitTimer);
  internalInitTimer = null;
  for (const [key, entry] of pending) {
    if (entry.generation !== generation) continue;
    pending.delete(key);
    clearEntryTimer(entry);
    if (entry.msg.method === "initialize" && !parentInitialized) {
      pendingInitialEntry = entry;
    } else if (isRetryable(entry)) {
      recoveryQueue.push({ ...entry, retries: entry.retries + 1, timer: null });
    } else {
      emitRestartError(entry, detail);
    }
  }
  log(`child stopped (${detail}); queued=${recoveryQueue.length + waitQueue.length}`);
  scheduleRestart();
}

function scheduleRestart() {
  if (stopping || restartTimer) return;
  const delay = Math.min(restartMaxMs, restartBaseMs * 2 ** Math.min(restartAttempt, 8));
  restartAttempt += 1;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startChild();
  }, delay);
}

function startChild() {
  if (stopping || child) return;
  const generation = ++childGeneration;
  handledGeneration = 0;
  childReady = false;
  let replayInitId = null;
  try {
    child = spawn(command, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env
    });
  } catch (error) {
    child = null;
    log(`spawn failed: ${error.message}`);
    scheduleRestart();
    return;
  }
  const spawned = child;
  readline.createInterface({ input: spawned.stdout }).on("line", line => handleChildMessage(line, generation, replayInitId));
  spawned.stdin.on("error", error => finishChild(generation, `stdin error: ${error.message}`));
  spawned.stdout.on("error", error => finishChild(generation, `stdout error: ${error.message}`));
  spawned.stderr.on("data", chunk => process.stderr.write(chunk));
  spawned.on("error", error => finishChild(generation, `spawn error: ${error.message}`));
  spawned.on("exit", (code, signal) => finishChild(generation, `exit code=${code} signal=${signal || "none"}`));
  spawned.on("spawn", () => {
    log(`child started pid=${spawned.pid}`);
    if (parentInitialized && initializeMessage) {
      replayInitId = `mcp-supervisor-init-${generation}`;
      const replay = { ...initializeMessage, id: replayInitId };
      spawned.stdin.write(JSON.stringify(replay) + "\n");
      if (requestTimeoutMs > 0) {
        internalInitTimer = setTimeout(() => {
          if (child === spawned && !childReady) spawned.kill();
        }, requestTimeoutMs);
      }
    } else if (pendingInitialEntry && pendingInitialEntry.generation !== generation) {
      writeEntry(pendingInitialEntry);
    }
  });
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = parseLine(line, "parent");
  if (!msg) return;
  if (msg.method === "initialize") {
    initializeMessage = msg;
    const entry = { line, msg, retries: 0, timer: null, generation: 0 };
    pendingInitialEntry = entry;
    writeEntry(entry);
    return;
  }
  if (msg.method === "notifications/initialized") {
    initializedNotification = msg;
    if (childReady && child?.stdin.writable) child.stdin.write(line + "\n");
    return;
  }
  writeEntry({ line, msg, retries: 0, timer: null, generation: 0 });
}).on("close", () => shutdown(0));

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (internalInitTimer) clearTimeout(internalInitTimer);
  for (const entry of pending.values()) clearEntryTimer(entry);
  if (child) child.kill();
  setTimeout(() => process.exit(code), 25).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", error => {
  log(`uncaught exception: ${error.stack || error.message}`);
  shutdown(1);
});

startChild();
