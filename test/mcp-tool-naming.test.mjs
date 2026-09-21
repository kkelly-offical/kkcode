import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createMcpRegistry } from "../src/kernel/mcp/registry.mjs"

const STDIO_FIXTURE = `
let buffer = Buffer.alloc(0);
function send(message) {
  const payload = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(payload, "utf8") + "\\r\\n\\r\\n" + payload);
}
function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.method === "initialize") { send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }); return; }
  if (msg.method === "ping") { send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }); return; }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo.v2", description: "dotted tool", inputSchema: { type: "object", properties: {} } },
      { name: "fetch data", description: "spaced tool", inputSchema: { type: "object", properties: {} } },
      { name: "a_very_long_tool_name_that_keeps_going_and_going_past_sixty_four_characters_total", description: "long tool", inputSchema: { type: "object", properties: {} } }
    ] } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result: {} });
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) return;
    const length = parseInt(match[1], 10);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.slice(headerEnd + 4 + length);
    try { handleMessage(JSON.parse(body)); } catch {}
  }
});
`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kkcode-mcp-naming-"))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = join(root, "state")
  await mkdir(process.env.KKCODE_HOME)
  t.after(async () => {
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return root
}

const PROVIDER_SAFE = /^[a-zA-Z0-9_-]{1,64}$/

test("MCP tool ids are provider-safe, bounded, and collision-free with diagnostics", { timeout: 30000 }, async t => {
  const root = await fixture(t)
  const registry = createMcpRegistry()
  t.after(() => registry.shutdown())
  await registry.initialize({
    mcp: {
      auto_discover: false,
      servers: {
        // dots and spaces used to flow straight into `mcp_<server>_<tool>` and
        // get rejected by provider APIs (^[a-zA-Z0-9_-]{1,64}$).
        "my.server v2": { transport: "stdio", command: [process.execPath, "-e", STDIO_FIXTURE], timeout_ms: 10000 },
        "my_server_v2": { transport: "stdio", command: [process.execPath, "-e", STDIO_FIXTURE], timeout_ms: 10000 }
      }
    }
  }, { cwd: root, allowProjectSources: false })

  const tools = registry.listTools()
  assert.equal(tools.length, 6, "both servers register all three tools")
  for (const tool of tools) {
    assert.match(tool.id, PROVIDER_SAFE, `${tool.id} must satisfy the provider tool-name contract`)
  }

  const ids = tools.map((tool) => tool.id)
  assert.equal(new Set(ids).size, ids.length, "sanitization collisions get deterministic suffixes")

  // "my.server v2" and "my_server_v2" sanitize to the same base id — the
  // second registration must get a suffix rather than overwriting the first.
  const echoTools = tools.filter((tool) => tool.name === "echo.v2")
  assert.equal(echoTools.length, 2)
  assert.deepEqual([...new Set(echoTools.map((tool) => tool.server))].sort(), ["my.server v2", "my_server_v2"])

  const longTool = tools.find((tool) => tool.name.startsWith("a_very_long"))
  assert.ok(longTool.id.length <= 64, `${longTool.id} truncated to the 64-char provider limit`)

  const diagnostics = registry.diagnostics()
  assert.ok(diagnostics.some((d) => d.kind === "tool_id_sanitized" && d.server === "my.server v2"), "sanitization is diagnosed")
  assert.ok(diagnostics.some((d) => d.kind === "tool_id_collision"), "collision suffixing is diagnosed")

  // calls route by sanitized id back to the owning server
  const echo = echoTools[0]
  const result = await registry.callTool(echo.id, { hello: "world" })
  assert.ok(result, "sanitized id remains callable")
})

test("safe names keep their historical ids (no contract drift)", { timeout: 30000 }, async t => {
  const root = await fixture(t)
  const registry = createMcpRegistry()
  t.after(() => registry.shutdown())
  await registry.initialize({
    mcp: {
      auto_discover: false,
      servers: {
        fixture: { transport: "stdio", command: [process.execPath, "-e", STDIO_FIXTURE], timeout_ms: 10000 }
      }
    }
  }, { cwd: root, allowProjectSources: false })

  const tools = registry.listTools()
  const echo = tools.find((tool) => tool.name === "echo.v2")
  assert.equal(echo.id, "mcp_fixture_echo_v2", "tool name sanitizes while server stays readable")
  const spaced = tools.find((tool) => tool.name === "fetch data")
  assert.equal(spaced.id, "mcp_fixture_fetch_data")
  const long = tools.find((tool) => tool.name.startsWith("a_very_long"))
  assert.ok(long.id.length <= 64 && /_[0-9a-f]{8}$/.test(long.id), "long ids truncate with a stable hash suffix")
  assert.equal(registry.diagnostics().filter((d) => d.kind === "tool_id_collision").length, 0, "no collisions with a single safe server")
})
