"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const proxyPath = process.argv[2] || path.join(__dirname, "..", "proxy.js");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => server.listen(0, "127.0.0.1", err => err ? reject(err) : resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForProxy(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const ok = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, res => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on("error", reject);
        req.setTimeout(500, () => req.destroy(new Error("timeout")));
      });
      if (ok) return;
    } catch {}
    await wait(50);
  }
  throw new Error("proxy did not become ready");
}

async function post(port, body) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/responses",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": raw.length }
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

async function main() {
  let attempts = 0;
  let committedAttempts = 0;
  let unfinishedAttempts = 0;
  let malformedAttempts = 0;
  let stalledAttempts = 0;
  let mode = "recover";
  const upstream = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    req.resume();
    if (mode === "stalled") {
      stalledAttempts++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (stalledAttempts === 1) {
        res.write('data: {"type":"response.created","response":{"id":"resp_stalled","status":"in_progress","output":[]}}\n\n');
        return;
      }
      const text = "STALL_RECOVERED";
      const events = [
        { type: "response.created", response: { id: "resp_stall_retry", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { id: "msg_stall_retry", type: "message", status: "in_progress", role: "assistant", content: [] } },
        { type: "response.output_text.delta", item_id: "msg_stall_retry", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item: { id: "msg_stall_retry", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
        { type: "response.completed", response: { id: "resp_stall_retry", status: "completed", output: [{ id: "msg_stall_retry", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    if (mode === "unfinished") {
      unfinishedAttempts++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (unfinishedAttempts === 1) {
        const text = "Баг найден и исправлен.\n\nОсталось по parked-списку: compliance-аудит и прогон тестов.";
        const events = [
          { type: "response.created", response: { id: "resp_unfinished", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { id: "msg_unfinished", type: "message", status: "in_progress", role: "assistant", content: [] } },
          { type: "response.output_text.delta", item_id: "msg_unfinished", output_index: 0, content_index: 0, delta: text },
          { type: "response.output_item.done", output_index: 0, item: { id: "msg_unfinished", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
          { type: "response.completed", response: { id: "resp_unfinished", status: "completed", output: [{ id: "msg_unfinished", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        ];
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      const events = [
        { type: "response.created", response: { id: "resp_continued", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { id: "fc_continued", call_id: "call_continued", type: "function_call", name: "shell_command", arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: { id: "fc_continued", call_id: "call_continued", type: "function_call", name: "shell_command", arguments: "{\"command\":\"npm test\"}" } },
        { type: "response.completed", response: { id: "resp_continued", status: "completed", output: [{ id: "fc_continued", call_id: "call_continued", type: "function_call", name: "shell_command", arguments: "{\"command\":\"npm test\"}" }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    if (mode === "malformed") {
      malformedAttempts++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (malformedAttempts === 1) {
        const text = "</function>\n</tool_call>";
        const events = [
          { type: "response.created", response: { id: "resp_malformed", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { id: "msg_malformed", type: "message", status: "in_progress", role: "assistant", content: [] } },
          { type: "response.output_text.delta", item_id: "msg_malformed", output_index: 0, content_index: 0, delta: text },
          { type: "response.output_item.done", output_index: 0, item: { id: "msg_malformed", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
          { type: "response.completed", response: { id: "resp_malformed", status: "completed", output: [{ id: "msg_malformed", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }
        ];
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      const events = [
        { type: "response.created", response: { id: "resp_malformed_recovered", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { id: "fc_malformed_recovered", call_id: "call_malformed_recovered", type: "function_call", name: "shell_command", arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: { id: "fc_malformed_recovered", call_id: "call_malformed_recovered", type: "function_call", name: "shell_command", arguments: "{\"command\":\"npm test\"}" } },
        { type: "response.completed", response: { id: "resp_malformed_recovered", status: "completed", output: [{ id: "fc_malformed_recovered", call_id: "call_malformed_recovered", type: "function_call", name: "shell_command", arguments: "{\"command\":\"npm test\"}" }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    if (mode === "committed") {
      committedAttempts++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.created","response":{"id":"resp_committed","status":"in_progress","output":[]}}\n\n');
      res.write('data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_committed","call_id":"call_committed","type":"function_call","name":"shell_command","arguments":""}}\n\n');
      res.write('data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_committed","call_id":"call_committed","type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"echo ok\\"}"}}\n\n');
      setTimeout(() => res.socket.destroy(), 40);
      return;
    }
    attempts++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (attempts === 1) {
      res.write('data: {"type":"response.created","response":{"id":"resp_first","status":"in_progress","output":[]}}\n\n');
      setTimeout(() => {
        res.socket.destroy();
        upstream.close(() => setTimeout(() => upstream.listen(upstreamPort, "127.0.0.1"), 180));
      }, 40);
      return;
    }
    const events = [
      { type: "response.created", response: { id: "resp_retry", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_retry", type: "message", status: "in_progress", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_retry", output_index: 0, content_index: 0, delta: "RECOVERED" },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_retry", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "RECOVERED", annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_retry", status: "completed", output: [{ id: "msg_retry", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "RECOVERED", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-retry-"));
  const diagPath = path.join(tempDir, "proxy.log");
  const child = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      LLAMA_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      CODEX_PROXY_HOST: "127.0.0.1",
      CODEX_PROXY_PORT: String(proxyPort),
      CODEX_PROXY_DIAG: diagPath,
      CODEX_UPSTREAM_RETRY_ATTEMPTS: "3",
      CODEX_UPSTREAM_RETRY_BASE_MS: "50",
      CODEX_UPSTREAM_RETRY_MAX_MS: "100",
      CODEX_UPSTREAM_IDLE_TIMEOUT_MS: "200",
      CODEX_MEMORY_ENABLED: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await waitForProxy(proxyPort);
    const result = await post(proxyPort, { model: "llm", input: "probe", stream: true, reasoning: { effort: "low" } });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(attempts, 2);
    assert.match(result.text, /RECOVERED/);
    assert.match(result.text, /"type":"response.completed"/);
    assert.doesNotMatch(result.text, /resp_first/);
    const diag = fs.readFileSync(diagPath, "utf8");
    assert.match(diag, /UPSTREAM_RETRY scheduled attempt=1\/3/);
    assert.match(diag, /UPSTREAM_REQUEST_ERROR error=connect ECONNREFUSED/);
    mode = "committed";
    const committed = await post(proxyPort, { model: "llm", input: "tool", stream: true, reasoning: { effort: "low" } });
    await wait(150);
    assert.strictEqual(committedAttempts, 1);
    assert.match(committed.text, /fc_committed/);
    assert.doesNotMatch(committed.text, /"type":"response.completed"/);
    mode = "unfinished";
    const unfinished = await post(proxyPort, { model: "llm", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "finish everything" }] }], stream: true, reasoning: { effort: "low" } });
    assert.strictEqual(unfinishedAttempts, 2);
    assert.match(unfinished.text, /fc_continued/);
    assert.doesNotMatch(unfinished.text, /msg_unfinished/);
    assert.strictEqual((unfinished.text.match(/"type":"response.completed"/g) || []).length, 1);
    assert.match(fs.readFileSync(diagPath, "utf8"), /TURN_GUARD AUTO_CONTINUE depth=0 reason=explicit-remaining-work/);
    mode = "malformed";
    const malformed = await post(proxyPort, { model: "llm", input: "continue the active task", stream: true, reasoning: { effort: "low" } });
    assert.strictEqual(malformedAttempts, 2);
    assert.match(malformed.text, /fc_malformed_recovered/);
    assert.doesNotMatch(malformed.text, /msg_malformed/);
    assert.strictEqual((malformed.text.match(/"type":"response.completed"/g) || []).length, 1);
    assert.match(fs.readFileSync(diagPath, "utf8"), /TURN_GUARD AUTO_CONTINUE depth=0 reason=malformed-tool-markup/);
    mode = "stalled";
    const stalled = await post(proxyPort, { model: "llm", input: "stall", stream: true, reasoning: { effort: "low" } });
    assert.strictEqual(stalledAttempts, 2);
    assert.match(stalled.text, /STALL_RECOVERED/);
    assert.doesNotMatch(stalled.text, /resp_stalled/);
    assert.match(fs.readFileSync(diagPath, "utf8"), /UPSTREAM_IDLE_TIMEOUT idle_ms=200/);
    process.stdout.write("UPSTREAM RETRY TEST PASS\n");
  } finally {
    child.kill();
    await close(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (stderr) throw new Error(stderr);
}

main().catch(err => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
