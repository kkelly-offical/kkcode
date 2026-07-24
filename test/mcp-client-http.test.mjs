import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { createHttpMcpClient } from "../src/mcp/client-http.mjs"
import { PACKAGE_VERSION } from "../src/version.mjs"

async function startServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    close: async () => new Promise((resolve) => server.close(() => resolve()))
  }
}

test("http mcp client classifies timeout", async () => {
  const srv = await startServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
      return
    }
    setTimeout(() => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ tools: [] }))
    }, 200)
  })

  try {
    const client = createHttpMcpClient("timeoutSrv", { type: "http", url: srv.url, timeout_ms: 50 })
    await assert.rejects(client.listTools(), (error) => error.reason === "timeout")
  } finally {
    await srv.close()
  }
})

test("http mcp client classifies bad response and server crash", async () => {
  const srv = await startServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === "/tools") {
      res.statusCode = 400
      res.end("bad request")
      return
    }
    if (req.url === "/resources") {
      res.statusCode = 500
      res.end("server crash")
      return
    }
    res.setHeader("content-type", "application/json")
    res.end("{}")
  })

  try {
    const client = createHttpMcpClient("statusSrv", { type: "http", url: srv.url, timeout_ms: 500 })
    await assert.rejects(client.listTools(), (error) => error.reason === "bad_response")
    const resources = await client.listResources()
    assert.deepEqual(resources, [])
  } finally {
    await srv.close()
  }
})

test("http mcp health reports connection_refused", async () => {
  const client = createHttpMcpClient("refusedSrv", { type: "http", url: "http://127.0.0.1:9", timeout_ms: 200 })
  const health = await client.health()
  assert.equal(health.ok, false)
  assert.equal(health.reason, "connection_refused")
})

test("http mcp requests include KK Code identity", async () => {
  let headers
  const srv = await startServer((req, res) => {
    headers = req.headers
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ tools: [] }))
  })
  try {
    const client = createHttpMcpClient("identitySrv", { type: "http", url: srv.url, timeout_ms: 500 })
    await client.listTools()
    assert.match(headers["user-agent"], new RegExp(`^KK-Code/${PACKAGE_VERSION.replaceAll(".", "\\.")} `))
    assert.equal(headers["x-kk-code-client"], "cli")
  } finally {
    await srv.close()
  }
})
