import test from "node:test"
import assert from "node:assert/strict"
import { createStdioMcpClient } from "../src/kernel/mcp/client-stdio.mjs"

function nodeCommand(script) {
  return [process.execPath, "-e", script]
}

// These child programs are synthetic protocol peers and import no product
// code. Windows forcibly terminates some of them by design; do not let their
// partial V8 files corrupt the test worker's real MCP-client coverage.
const fixtureEnvironment = { NODE_V8_COVERAGE: "" }

const standardMcpServerScript = `
let buffer = Buffer.alloc(0);
function send(message) {
  const payload = JSON.stringify(message);
  const frame = "Content-Length: " + Buffer.byteLength(payload, "utf8") + "\\r\\n\\r\\n" + payload;
  process.stdout.write(frame);
}
function handleMessage(msg) {
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
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] } });
    return;
  }
  if (msg.method === "tools/call") {
    const args = msg.params?.arguments || {};
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(args) }]
      }
    });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result: {} });
}
function tryConsume() {
  while (true) {
    const sep = buffer.indexOf("\\r\\n\\r\\n");
    if (sep !== -1) {
      const header = buffer.subarray(0, sep).toString("utf8");
      const match = /content-length:\\s*(\\d+)/i.exec(header);
      if (match) {
        const len = Number(match[1]);
        const total = sep + 4 + len;
        if (buffer.length < total) return;
        const body = buffer.subarray(sep + 4, total).toString("utf8");
        buffer = buffer.subarray(total);
        try { handleMessage(JSON.parse(body)); } catch {}
        continue;
      }
    }
    const nl = buffer.indexOf("\\n");
    if (nl === -1) return;
    const line = buffer.subarray(0, nl).toString("utf8").trim();
    buffer = buffer.subarray(nl + 1);
    if (!line) continue;
    try { handleMessage(JSON.parse(line)); } catch {}
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  tryConsume();
});
process.stdin.resume();
`

test("stdio mcp client supports auto framing with standard content-length server", async (t) => {
  const client = createStdioMcpClient("stdioAuto", {
    type: "stdio",
    command: nodeCommand(standardMcpServerScript),
    env: fixtureEnvironment,
    shell: false,
    framing: "auto",
    timeout_ms: 5000
  })
  t.after(() => client.shutdown())
  const tools = await client.listTools()
  assert.equal(Array.isArray(tools), true)
  assert.equal(tools[0].name, "echo")
})

test("stdio mcp client timeout classification", async (t) => {
  const script = `
    process.stdin.resume();
  `
  const client = createStdioMcpClient("stdioTimeout", {
    type: "stdio",
    command: nodeCommand(script),
    env: fixtureEnvironment,
    shell: false,
    timeout_ms: 80,
    startup_timeout_ms: 200,
    framing: "content-length"
  })
  t.after(() => client.shutdown())
  await assert.rejects(client.listTools(), (error) => error.reason === "timeout")
})

test("stdio mcp client bad_response classification", async (t) => {
  const script = `
    process.stdin.once("data", () => {
      process.stdout.write("not json\\n", () => process.exit(0));
    });
    process.stdin.resume();
  `
  const client = createStdioMcpClient("stdioBadJson", {
    type: "stdio",
    command: nodeCommand(script),
    env: fixtureEnvironment,
    shell: false,
    // Classification is under test here, not OS process startup latency.
    // The separate timeout test above retains its intentionally short limit.
    timeout_ms: 5000,
    framing: "newline"
  })
  t.after(() => client.shutdown())
  await assert.rejects(client.listTools(), (error) => ["bad_response", "protocol_error"].includes(error.reason))
})

test("stdio mcp client server_crash classification", async (t) => {
  const script = `
    process.stderr.write("boom");
    process.exit(1);
  `
  const client = createStdioMcpClient("stdioCrash", {
    type: "stdio",
    command: nodeCommand(script),
    env: fixtureEnvironment,
    shell: false,
    timeout_ms: 5000
  })
  t.after(() => client.shutdown())
  await assert.rejects(client.listTools(), (error) => error.reason === "server_crash" || error.reason === "spawn_failed")
})

test('a peer closing its input pipe rejects the request without an uncaught EPIPE', async t => {
  const script = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    process.stdin.on('error', () => {});
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('error', () => {});
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        // Close before advertising readiness; otherwise the parent's next
        // request can be buffered while the pipe is still open.
        fs.closeSync(0);
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2024-11-05',capabilities:{}}})+'\\n');
      }
    });
    setInterval(() => {}, 1000);
  `
  const client = createStdioMcpClient('closed-input', { type: 'stdio', command: nodeCommand(script), env: fixtureEnvironment, shell: false, framing: 'newline', timeout_ms: 1000, shutdown_timeout_ms: 100 })
  t.after(() => client.shutdown())
  await assert.rejects(client.listTools(), error => error.reason === 'server_crash')
})

test("stdio mcp health reports spawn_failed", async (t) => {
  const client = createStdioMcpClient("stdioMissing", {
    type: "stdio",
    command: ["nonexistent_kkcode_command_12345"],
    env: fixtureEnvironment,
    shell: false,
    timeout_ms: 300
  })
  t.after(() => client.shutdown())
  const health = await client.health()
  assert.equal(health.ok, false)
  assert.equal(health.reason, "spawn_failed")
})
