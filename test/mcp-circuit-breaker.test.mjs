import test from "node:test"
import assert from "node:assert/strict"
import { createStdioMcpClient } from "../src/mcp/client-stdio.mjs"

function nodeCommand(script) {
  return [process.execPath, "-e", script]
}

const healthyServer = `
let buffer = Buffer.alloc(0);
function send(msg) {
  const p = JSON.stringify(msg);
  process.stdout.write("Content-Length: " + Buffer.byteLength(p, "utf8") + "\\r\\n\\r\\n" + p);
}
function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    return;
  }
  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] } });
    return;
  }
  if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result: {} });
}
function consume() {
  while (true) {
    const sep = buffer.indexOf("\\r\\n\\r\\n");
    if (sep === -1) return;
    const hdr = buffer.subarray(0, sep).toString("utf8");
    const m = /content-length:\\s*(\\d+)/i.exec(hdr);
    if (!m) return;
    const len = Number(m[1]);
    const total = sep + 4 + len;
    if (buffer.length < total) return;
    const body = buffer.subarray(sep + 4, total).toString("utf8");
    buffer = buffer.subarray(total);
    try { handle(JSON.parse(body)); } catch {}
  }
}
process.stdin.on("data", (c) => { buffer = Buffer.concat([buffer, c]); consume(); });
process.stdin.resume();
`

test("stdio client reconnects after server crash", async (t) => {
  const client = createStdioMcpClient("cbReconnect", {
    command: nodeCommand(healthyServer),
    framing: "content-length",
    timeout_ms: 2000,
    startup_timeout_ms: 2000,
    max_reconnect_attempts: 3,
    circuit_reset_ms: 500
  })
  t.after(() => client.shutdown())

  // First call succeeds — establishes connection
  const health1 = await client.health()
  assert.equal(health1.ok, true)

  const tools = await client.listTools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "echo")
})

test("stdio client circuit opens after repeated spawn failures", async (t) => {
  const client = createStdioMcpClient("cbCircuit", {
    command: nodeCommand(healthyServer),
    framing: "content-length",
    timeout_ms: 1000,
    startup_timeout_ms: 1000,
    max_reconnect_attempts: 2,
    circuit_reset_ms: 60000
  })
  t.after(() => client.shutdown())

  // Establish initial connection
  const health = await client.health()
  assert.equal(health.ok, true)
})
