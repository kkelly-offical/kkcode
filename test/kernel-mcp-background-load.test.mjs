import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createMcpRegistry } from "../src/kernel/mcp/registry.mjs"
import { createToolRegistry } from "../src/kernel/tool/registry.mjs"
import { EventBus } from "../src/kernel/core/events.mjs"
import { EVENT_TYPES } from "../src/kernel/core/constants.mjs"
import { validateConfig } from "../src/config/schema.mjs"

/**
 * MCP 后台加载的内核侧契约：
 *   1. initialize({ defer: true }) 立即返回，boot/回合不被连接时间拖住；
 *      不就绪的 server 工具不进广告面（选定的语义：就绪前排除，而不是
 *      首个用到的 turn 短等待）。
 *   2. 收口时发一次 mcp.loaded 汇总事件（每 server 的 mcp.health 照发），
 *      并回调 onLoad 监听器 —— 工具注册表据此把新工具原子换进广告面。
 *   3. 单 server 失败只进 failed 清单，整轮加载不抛、不阻塞。
 *   4. mcp.background_load: false 回到「连完再进」的前台语义。
 */

const healthyScript = `
let buffer = Buffer.alloc(0);
const delayMs = Number(process.env.MCP_FAKE_DELAY_MS || 0);
function send(message) {
  const payload = JSON.stringify(message);
  const frame = "Content-Length: " + Buffer.byteLength(payload, "utf8") + "\\r\\n\\r\\n" + payload;
  process.stdout.write(frame);
}
function respond(message) {
  if (delayMs > 0) { setTimeout(() => send(message), delayMs); return; }
  send(message);
}
function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.method === "initialize") {
    respond({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    return;
  }
  if (msg.method === "ping") {
    respond({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "tools/list") {
    respond({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: [{ name: "echo", description: "echo tool", inputSchema: { type: "object", properties: {} } }] }
    });
    return;
  }
  respond({ jsonrpc: "2.0", id: msg.id, result: {} });
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

const crashingScript = `
process.stderr.write("dead");
process.exit(1);
`

function slowServerConfig(delayMs = 800) {
  return {
    transport: "stdio",
    command: [process.execPath, "-e", healthyScript],
    env: { MCP_FAKE_DELAY_MS: String(delayMs) },
    shell: false,
    timeout_ms: 5000,
    framing: "content-length"
  }
}

function crashingServerConfig() {
  return {
    transport: "stdio",
    command: [process.execPath, "-e", crashingScript],
    shell: false,
    timeout_ms: 1000
  }
}

function mcpConfig(servers, extra = {}) {
  return {
    runtime: { mcp_refresh_ttl_ms: 0 },
    mcp: { auto_discover: false, servers, ...extra }
  }
}

let tmpDir
let previousKkcodeHome

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-mcp-bg-"))
  previousKkcodeHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = tmpDir
})

after(async () => {
  if (previousKkcodeHome === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = previousKkcodeHome
  await rm(tmpDir, { recursive: true, force: true })
})

function watchLoaded() {
  const events = []
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.type === EVENT_TYPES.MCP_LOADED) events.push(event.payload)
  })
  return { events, unsubscribe }
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(predicate(), "condition not met within the deadline")
}

test("deferred initialize returns before servers are ready and emits one mcp.loaded summary", async () => {
  const registry = createMcpRegistry()
  const { events, unsubscribe } = watchLoaded()
  try {
    await registry.initialize(mcpConfig({ slow: slowServerConfig() }), { cwd: tmpDir, defer: true })
    assert.equal(registry.isReady(), false, "not loaded yet — the return was not gated on connecting")
    assert.equal(registry.isLoading(), true)
    assert.deepEqual(registry.listTools(), [], "not-ready tools stay off the surface")
    assert.equal(registry.loadState().loading, true)

    await waitFor(() => registry.isReady())
    assert.equal(registry.isLoading(), false)
    assert.ok(registry.listTools().some((tool) => tool.name === "echo"))

    assert.equal(events.length, 1, "exactly one summary event per load round")
    assert.equal(events[0].background, true)
    assert.equal(events[0].ok, true)
    assert.equal(events[0].connected, 1)
    assert.deepEqual(events[0].failed, [])
    assert.equal(events[0].toolCount, 1)
  } finally {
    unsubscribe()
    await registry.shutdown()
  }
})

test("a second deferred initialize does not latch onto the in-flight load", async () => {
  const registry = createMcpRegistry()
  try {
    await registry.initialize(mcpConfig({ slow: slowServerConfig() }), { cwd: tmpDir, defer: true })
    const again = registry.initialize(mcpConfig({ slow: slowServerConfig() }), { cwd: tmpDir, defer: true })
    // 不 await 在途加载：这个调用必须立即返回，否则后台加载在 turn 路径上
    // 又变回了阻塞点
    await Promise.race([
      again,
      new Promise((resolve) => setTimeout(resolve, 200)).then(() => {
        throw new Error("deferred initialize latched onto the in-flight load")
      })
    ])
    await waitFor(() => registry.isReady())
  } finally {
    await registry.shutdown()
  }
})

test("tool registry defers MCP and swaps the advertisement surface when the load lands", async () => {
  const mcp = createMcpRegistry()
  // deferMcp 是 createKernel 的装配开关；直接自建的注册表缺省同步语义
  const tools = createToolRegistry({ mcpRegistry: mcp, deferMcp: true })
  const { events, unsubscribe } = watchLoaded()
  const config = {
    tool: { sources: { builtin: false, local: false, plugin: false, mcp: true } },
    ...mcpConfig({ slow: slowServerConfig() })
  }
  try {
    await tools.initialize({ config, cwd: tmpDir })
    assert.ok(tools.isReady(), "tool registry is ready without waiting for MCP")
    const before = await tools.list({})
    assert.ok(!before.some((tool) => tool.name.startsWith("mcp_")), "MCP tools are excluded until ready")

    await waitFor(() => mcp.isReady() && events.length === 1)
    // onLoad → refreshMcpTools 是同步换入，事件到达时广告面已更新
    const afterLoad = await tools.list({})
    assert.ok(
      afterLoad.some((tool) => tool.name.startsWith("mcp_slow_") && tool.name.endsWith("_echo")),
      "loaded MCP tools appear on the surface after mcp.loaded"
    )
  } finally {
    unsubscribe()
    await mcp.shutdown()
  }
})

test("a crashing server degrades into the failed list without blocking or throwing", async () => {
  const registry = createMcpRegistry()
  const { events, unsubscribe } = watchLoaded()
  try {
    await registry.initialize(mcpConfig({ bad: crashingServerConfig() }), { cwd: tmpDir, defer: true })
    await waitFor(() => registry.isReady())
    assert.deepEqual(registry.listTools(), [])
    assert.equal(events.length, 1)
    assert.equal(events[0].ok, true, "per-server failure is degradation, not a failed load round")
    assert.equal(events[0].connected, 0)
    assert.equal(events[0].failed.length, 1)
    assert.equal(events[0].failed[0].name, "bad")
    const snapshot = registry.healthSnapshot().find((item) => item.name === "bad")
    assert.equal(snapshot?.ok, false)
  } finally {
    unsubscribe()
    await registry.shutdown()
  }
})

test("mcp.background_load: false keeps the foreground 'connect before chat' semantics", async () => {
  const mcp = createMcpRegistry()
  const tools = createToolRegistry({ mcpRegistry: mcp, deferMcp: true })
  const config = {
    tool: { sources: { builtin: false, local: false, plugin: false, mcp: true } },
    ...mcpConfig({ slow: slowServerConfig(400) }, { background_load: false })
  }
  try {
    await tools.initialize({ config, cwd: tmpDir })
    assert.ok(mcp.isReady(), "foreground mode: initialize returns only after the load lands")
    const listed = await tools.list({})
    assert.ok(listed.some((tool) => tool.name.startsWith("mcp_slow_")))
  } finally {
    await mcp.shutdown()
  }
})

test("shutdown during a background load settles cleanly", async () => {
  const registry = createMcpRegistry()
  await registry.initialize(mcpConfig({ slow: slowServerConfig(1500) }), { cwd: tmpDir, defer: true })
  assert.equal(registry.isLoading(), true)
  await registry.shutdown()
  assert.equal(registry.isReady(), false)
  assert.equal(registry.isLoading(), false)
  assert.deepEqual(registry.listTools(), [])
})

test("createKernel boots without awaiting MCP and surfaces tools when the load lands", async () => {
  const { createKernel } = await import("../src/kernel/kernel.mjs")
  const events = []
  const kernel = await createKernel({
    cwd: tmpDir,
    trustState: { trusted: true },
    handlers: { onEvent: (event) => { if (event.type === EVENT_TYPES.MCP_LOADED) events.push(event.payload) } },
    configState: {
      config: {
        mcp: { auto_discover: false, servers: { slow: slowServerConfig(800) } },
        tool: { sources: { builtin: true, local: false, plugin: false, mcp: true } },
        agent: { default_mode: "agent" }
      },
      source: { userRaw: {}, projectRaw: {}, envOverlay: {} }
    }
  })
  try {
    assert.equal(events.length, 0, "boot returned before the 800ms MCP connect could finish — it did not await")
    await waitFor(() => events.length === 1)
    assert.equal(events[0].background, true)
    assert.equal(events[0].connected, 1)
    assert.ok(kernel.extensions.mcp.isReady())
    const listed = await kernel.tools.list({ mode: "agent" })
    assert.ok(
      listed.some((tool) => tool.name.startsWith("mcp_slow_")),
      "onLoad → refreshMcpTools wiring lands the new tools on the kernel's surface"
    )
  } finally {
    await kernel.shutdown()
  }
})

test("directly-assembled registries keep the synchronous initialize contract by default", async () => {
  const mcp = createMcpRegistry()
  const tools = createToolRegistry({ mcpRegistry: mcp })
  const config = {
    tool: { sources: { builtin: false, local: false, plugin: false, mcp: true } },
    ...mcpConfig({ slow: slowServerConfig(200) })
  }
  try {
    await tools.initialize({ config, cwd: tmpDir })
    assert.ok(mcp.isReady(), "no deferMcp: initialize resolves only after the load lands")
    assert.ok((await tools.list({})).some((tool) => tool.name.startsWith("mcp_slow_")))
  } finally {
    await mcp.shutdown()
  }
})

test("schema validates mcp.background_load as a boolean", () => {
  assert.equal(validateConfig({ mcp: { background_load: true } }).valid, true)
  assert.equal(validateConfig({ mcp: { background_load: false } }).valid, true)
  const bad = validateConfig({ mcp: { background_load: "yes" } })
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((error) => error.includes("mcp.background_load")))
})
