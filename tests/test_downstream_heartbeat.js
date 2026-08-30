"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const proxyPath = path.join(__dirname, "..", "proxy.js");
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
      const ready = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, res => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on("error", reject);
      });
      if (ready) return;
    } catch {}
    await wait(50);
  }
  throw new Error("proxy did not become ready");
}

async function post(port) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify({ model: "llm", input: "slow reasoning", stream: true }));
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
  const upstream = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    req.resume();
    const response = { id: "resp_slow", object: "response", created_at: 1, status: "in_progress", model: "llm", output: [] };
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const item = { id: "fc_slow", call_id: "call_slow", type: "function_call", name: "shell_command", arguments: "{\"command\":\"echo ok\"}" };
      res.write(`data: ${JSON.stringify({ type: "response.created", response })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "response.completed", response: { ...response, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
    }, 260);
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-heartbeat-"));
  const diagPath = path.join(tempDir, "proxy.log");
  const child = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      LLAMA_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      CODEX_PROXY_HOST: "127.0.0.1",
      CODEX_PROXY_PORT: String(proxyPort),
      CODEX_PROXY_DIAG: diagPath,
      CODEX_DOWNSTREAM_HEARTBEAT_MS: "50",
      CODEX_MEMORY_ENABLED: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await waitForProxy(proxyPort);
    const result = await post(proxyPort);
    assert.strictEqual(result.status, 200);
    const events = result.text.split(/\r?\n/).filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(5).trimStart()));
    const types = events.map(event => event.type);
    assert.strictEqual(types.filter(type => type === "response.created").length, 1);
    assert(types.filter(type => type === "response.in_progress").length >= 3);
    assert.strictEqual(types.filter(type => type === "response.completed").length, 1);
    assert(types.indexOf("response.created") < types.indexOf("response.in_progress"));
    assert(types.indexOf("response.in_progress") < types.indexOf("response.output_item.done"));
    assert.match(fs.readFileSync(diagPath, "utf8"), /DOWNSTREAM_HEARTBEAT count=1/);
    process.stdout.write("DOWNSTREAM HEARTBEAT TEST PASS\n");
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
