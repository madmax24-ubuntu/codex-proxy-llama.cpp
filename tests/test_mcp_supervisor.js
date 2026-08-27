"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

if (process.argv[2] === "--fixture") {
  const state = process.env.MCP_FIXTURE_STATE;
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }) + "\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } }) + "\n");
    } else if (msg.method === "tools/call") {
      if (!fs.existsSync(state)) {
        fs.writeFileSync(state, "crashed", "utf8");
        process.exit(23);
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "recovered" }] } }) + "\n");
    }
  });
  return;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-supervisor-"));
const state = path.join(root, "state");
const supervisor = path.resolve(__dirname, "..", "mcp_supervisor.js");
const child = spawn(process.execPath, [supervisor, "--", process.execPath, __filename, "--fixture"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MCP_FIXTURE_STATE: state, MCP_SUPERVISOR_REQUEST_TIMEOUT_MS: "5000" }
});
const responses = new Map();
let stderr = "";

child.stderr.on("data", chunk => { stderr += chunk; });
readline.createInterface({ input: child.stdout }).on("line", line => {
  const msg = JSON.parse(line);
  const callback = responses.get(JSON.stringify(msg.id));
  if (callback) {
    responses.delete(JSON.stringify(msg.id));
    callback(msg);
  }
});

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}\n${stderr}`)), 10000);
    responses.set(JSON.stringify(id), message => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

(async () => {
  const initialized = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await request(2, "tools/list");
  if (tools.result?.tools?.[0]?.name !== "ping") throw new Error("tools/list failed");
  const result = await request(3, "tools/call", { name: "ping", arguments: {} });
  if (result.result?.content?.[0]?.text !== "recovered") throw new Error(`recovery failed: ${JSON.stringify(result)}`);
  if (!/exit code=23/.test(stderr) || !/child ready/.test(stderr)) throw new Error(`restart was not observed\n${stderr}`);
  process.stdout.write("MCP_SUPERVISOR_TEST_PASS\n");
  child.stdin.end();
  fs.rmSync(root, { recursive: true, force: true });
})().catch(error => {
  process.stderr.write(error.stack + "\n");
  child.kill();
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 1;
});
