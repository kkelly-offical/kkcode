import test from "node:test"
import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
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

test('an asynchronous input-pipe failure rejects the in-flight request and closes its peer', async t => {
  const script = `
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2024-11-05',capabilities:{}}})+'\\n');
      if (message.method === 'tools/list') process.stderr.write('fixture-request-received');
    });
    setInterval(() => {}, 1000);
  `
  // Use a real peer and wait until its request is in flight. Closing fd 0 in
  // the peer does not close Node's duplicated Windows pipe consistently.
  // Destroying the parent's actual Writable with EPIPE delivers the same
  // asynchronous stream error on every OS, without changing the client API.
  const originalSpawn = childProcess.spawn
  let injected = false, exited = false
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => {
    const peer = originalSpawn(...args)
    let stderr = ''
    peer.once('close', () => { exited = true })
    peer.stderr.on('data', chunk => {
      stderr += chunk
      if (!injected && stderr.includes('fixture-request-received')) {
        injected = true
        queueMicrotask(() => peer.stdin.destroy(Object.assign(new Error('fixture input pipe closed'), {code:'EPIPE'})))
      }
    })
    return peer
  })
  syncBuiltinESMExports()
  const client = createStdioMcpClient('closed-input', { type: 'stdio', command: nodeCommand(script), env: fixtureEnvironment, shell: false, framing: 'newline', timeout_ms: 5000, shutdown_timeout_ms: 100 })
  try {
    await assert.rejects(client.listTools(), error => error.reason === 'server_crash')
    assert.equal(injected, true)
    assert.equal(spawn.mock.calls.length, 1, 'a failed in-flight request is not automatically replayed')
    await client.shutdown()
    assert.equal(exited, true, 'the failed owned peer is reaped')
  } finally { await client.shutdown(); t.mock.restoreAll(); syncBuiltinESMExports() }
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
