import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { createSseMcpClient } from "../src/mcp/client-sse.mjs"

function sseFrame(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result })
  return `event: message\ndata: ${msg}\n\n`
}

function sseError(id, error) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error })
  return `event: message\ndata: ${msg}\n\n`
}

async function startSseServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    close: async () => new Promise((resolve) => server.close(() => resolve()))
  }
}

function parseJsonRpcBody(req) {
  return new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk) => { data += chunk })
    req.on("end", () => {
      try { resolve(JSON.parse(data)) } catch { resolve(null) }
    })
  })
}

function jsonResponse(res, body) {
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

function sseResponse(res, body) {
  res.setHeader("content-type", "text/event-stream")
  res.setHeader("cache-control", "no-cache")
  res.write(body)
  res.end()
}

async function healthySseHandler(req, res) {
  const body = await parseJsonRpcBody(req)
  if (!body) { res.statusCode = 400; res.end(); return }

  if (body.method === "initialize") {
    res.setHeader("mcp-session-id", "test-session-123")
    jsonResponse(res, {
      jsonrpc: "2.0", id: body.id,
      result: { protocolVersion: "2024-11-05", capabilities: {} }
    })
    return
  }
  if (body.method === "notifications/initialized") {
    res.statusCode = 204; res.end(); return
  }
  if (body.method === "ping") {
    jsonResponse(res, { jsonrpc: "2.0", id: body.id, result: { ok: true } })
    return
  }
  if (body.method === "tools/list") {
    sseResponse(res, sseFrame(body.id, {
      tools: [{ name: "greet", description: "greet tool", inputSchema: { type: "object", properties: {} } }]
    }))
    return
  }
  if (body.method === "tools/call") {
    const args = body.params?.arguments || {}
    sseResponse(res, sseFrame(body.id, {
      content: [{ type: "text", text: JSON.stringify(args) }]
    }))
    return
  }
  jsonResponse(res, { jsonrpc: "2.0", id: body.id, result: {} })
}

test("sse client parses SSE response and lists tools", async () => {
  const srv = await startSseServer(healthySseHandler)
  try {
    const client = createSseMcpClient("sseHealthy", { url: srv.url, timeout_ms: 2000 })
    const tools = await client.listTools()
    assert.equal(Array.isArray(tools), true)
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, "greet")
    client.shutdown()
  } finally {
    await srv.close()
  }
})

test("sse client callTool via SSE stream", async () => {
  const srv = await startSseServer(healthySseHandler)
  try {
    const client = createSseMcpClient("sseCall", { url: srv.url, timeout_ms: 2000 })
    const result = await client.callTool("greet", { name: "world" })
    assert.equal(typeof result.output, "string")
    assert.ok(result.output.includes('"name":"world"'))
    client.shutdown()
  } finally {
    await srv.close()
  }
})

test("sse client classifies timeout", async () => {
  const srv = await startSseServer(async (req, res) => {
    await parseJsonRpcBody(req)
    // Hold connection open — never respond, triggers timeout
    await new Promise((resolve) => setTimeout(resolve, 5000))
    res.end()
  })
  try {
    const client = createSseMcpClient("sseTimeout", { url: srv.url, timeout_ms: 100 })
    const health = await client.health()
    assert.equal(health.ok, false)
    assert.equal(health.reason, "timeout")
    client.shutdown()
  } finally {
    await srv.close()
  }
})

test("sse client classifies connection_refused", async () => {
  const client = createSseMcpClient("sseRefused", { url: "http://127.0.0.1:9", timeout_ms: 200 })
  const health = await client.health()
  assert.equal(health.ok, false)
  assert.equal(health.reason, "connection_refused")
})

test("sse client classifies server error (HTTP 500)", async () => {
  const srv = await startSseServer(async (req, res) => {
    await parseJsonRpcBody(req)
    res.statusCode = 500
    res.end("internal error")
  })
  try {
    const client = createSseMcpClient("sse500", { url: srv.url, timeout_ms: 1000 })
    const health = await client.health()
    assert.equal(health.ok, false)
    assert.equal(health.reason, "server_crash")
    client.shutdown()
  } finally {
    await srv.close()
  }
})
