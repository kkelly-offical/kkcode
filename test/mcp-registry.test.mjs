import test from "node:test"
import assert from "node:assert/strict"
import { McpRegistry } from "../src/mcp/registry.mjs"

function makeNodeScript(body) {
  return [process.execPath, "-e", body]
}

const healthyScript = `
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
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{ name: "echo", description: "echo tool", inputSchema: { type: "object", properties: {} } }]
      }
    });
    return;
  }
  if (msg.method === "resources/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { resources: [] } });
    return;
  }
  if (msg.method === "resources/templates/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { templates: [] } });
    return;
  }
  if (msg.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(msg.params?.arguments || {}) }]
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

const unhealthyScript = `
process.stderr.write("dead");
process.exit(1);
`

test("mcp registry keeps healthy server and tool bridge works", async () => {
  await McpRegistry.initialize(
    {
      runtime: { mcp_refresh_ttl_ms: 0 },
      mcp: {
        servers: {
          good: {
            transport: "stdio",
            command: makeNodeScript(healthyScript),
            timeout_ms: 1000,
            framing: "auto"
          },
          bad: {
            transport: "stdio",
            command: makeNodeScript(unhealthyScript),
            timeout_ms: 1000
          }
        }
      }
    },
    { force: true }
  )

  const servers = McpRegistry.listServers()
  assert.ok(servers.includes("good"))
  assert.equal(servers.includes("bad"), false)

  const snapshot = McpRegistry.healthSnapshot()
  const good = snapshot.find((item) => item.name === "good")
  const bad = snapshot.find((item) => item.name === "bad")
  assert.equal(good?.ok, true)
  assert.equal(bad?.ok, false)

  const tools = McpRegistry.listTools()
  const echoTool = tools.find((tool) => tool.name === "echo")
  assert.ok(echoTool)

  const out = await McpRegistry.callTool(echoTool.id, { foo: "bar" })
  assert.equal(typeof out.output, "string")
  assert.ok(out.output.includes("\"foo\":\"bar\""))
  assert.ok(out.raw)

  McpRegistry.shutdown()
})
