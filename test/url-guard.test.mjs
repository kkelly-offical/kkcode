import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { assertFetchableUrl, guardedFetch, blockedIpReason, UrlGuardError } from "../src/net/url-guard.mjs"

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

test("cloud metadata endpoints are blocked unconditionally", async () => {
  // 这些是最高价值目标：一次 GET 换实例凭证。allowPrivate 也不该放行。
  for (const host of ["169.254.169.254", "metadata.google.internal", "100.100.100.200"]) {
    await assert.rejects(
      () => assertFetchableUrl(`http://${host}/latest/meta-data/`),
      (e) => e instanceof UrlGuardError && /metadata/i.test(e.message),
      host
    )
    await assert.rejects(
      () => assertFetchableUrl(`http://${host}/`, { allowPrivate: true }),
      (e) => /metadata/i.test(e.message),
      `${host} 在 allowPrivate 下也必须拒`
    )
  }
})

test("loopback and private ranges are blocked", async () => {
  for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.1.1", "100.64.0.1"]) {
    await assert.rejects(() => assertFetchableUrl(`http://${host}/`), UrlGuardError, host)
  }
  // IPv4-mapped IPv6 是绕过 IPv4 判定的经典手法
  assert.ok(blockedIpReason("::ffff:127.0.0.1"), "IPv4-mapped 回环必须拦")
  assert.ok(blockedIpReason("::1"))
  assert.ok(blockedIpReason("fe80::1"))
  assert.ok(blockedIpReason("fd00::1"))
})

test("public addresses pass", () => {
  assert.equal(blockedIpReason("8.8.8.8"), null)
  assert.equal(blockedIpReason("1.1.1.1"), null)
  assert.equal(blockedIpReason("2606:4700::1111"), null)
  assert.equal(blockedIpReason("not-an-ip"), null, "非 IP 交给 DNS 判定，不在这里下结论")
})

test("non-http schemes and embedded credentials are rejected", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"]) {
    await assert.rejects(() => assertFetchableUrl(url), /blocked scheme/, url)
  }
  await assert.rejects(() => assertFetchableUrl("http://user:pass@example.com/"), /credentials embedded/)
  await assert.rejects(() => assertFetchableUrl("not a url"), /not a valid URL/)
})

test("allow_private_hosts opens loopback for local development", async () => {
  const url = await assertFetchableUrl("http://127.0.0.1:8080/api", { allowPrivate: true })
  assert.equal(url.hostname, "127.0.0.1")
})

test("guardedFetch reaches an allowed host", async () => {
  const { server, port } = await listen((req, res) => res.end("OK " + req.method))
  try {
    const { response } = await guardedFetch(`http://127.0.0.1:${port}/`, {}, { allowPrivate: true })
    assert.equal(await response.text(), "OK GET")
  } finally {
    server.close()
  }
})

test("a redirect into a blocked address is caught", async () => {
  // 只校验入口 URL 等于没校验：`https://ok.example/r` → `http://169.254.169.254/`
  // 这一跳会完全绕过入口检查，所以必须 redirect:"manual" 并逐跳复检。
  const { server, port } = await listen((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" })
      res.end()
    } else {
      res.end("SHOULD NOT BE REACHED")
    }
  })
  try {
    await assert.rejects(
      () => guardedFetch(`http://127.0.0.1:${port}/redirect`, {}, { allowPrivate: true }),
      (e) => e instanceof UrlGuardError && /metadata/i.test(e.message)
    )
  } finally {
    server.close()
  }
})

test("guardedFetch follows an allowed redirect and reports the hop count", async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === "/a") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/b` })
      res.end()
    } else {
      res.end("ARRIVED")
    }
  })
  try {
    const { response, redirects, url } = await guardedFetch(`http://127.0.0.1:${port}/a`, {}, { allowPrivate: true })
    assert.equal(await response.text(), "ARRIVED")
    assert.equal(redirects, 1)
    assert.match(url.pathname, /\/b$/)
  } finally {
    server.close()
  }
})

test("a redirect chain longer than the cap is refused", async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/loop` })
    res.end()
  })
  try {
    await assert.rejects(
      () => guardedFetch(`http://127.0.0.1:${port}/loop`, {}, { allowPrivate: true, maxRedirects: 3 }),
      /too many redirects/
    )
  } finally {
    server.close()
  }
})

test("a 302 downgrades POST to GET and drops the body, as the spec requires", async () => {
  const seen = []
  const { server, port } = await listen((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.url === "/post") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/after` })
      res.end()
    } else {
      res.end("done")
    }
  })
  try {
    await guardedFetch(
      `http://127.0.0.1:${port}/post`,
      { method: "POST", body: "payload" },
      { allowPrivate: true }
    )
    assert.deepEqual(seen, ["POST /post", "GET /after"])
  } finally {
    server.close()
  }
})

test("http_request supports methods, headers and body; webfetch stays GET-only", async () => {
  const { ToolRegistry } = await import("../src/tool/registry.mjs")
  const seen = []
  const { server, port } = await listen((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      seen.push({ method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })
      res.writeHead(201, { "content-type": "application/json" })
      res.end('{"created":true}')
    })
  })
  try {
    const config = {
      tool: {
        sources: { builtin: true, local: false, plugin: false, mcp: false },
        http: { allow_private_hosts: true }
      }
    }
    await ToolRegistry.initialize({ config, cwd: process.cwd(), force: true, allowProjectSources: false })
    const ctx = { cwd: process.cwd(), config }

    const out = await ToolRegistry.call("http_request", {
      url: `http://127.0.0.1:${port}/items`,
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: '{"name":"x"}'
    }, ctx)
    assert.match(out.output, /HTTP 201/)
    assert.match(out.output, /created/)
    assert.equal(seen[0].method, "POST")
    assert.equal(seen[0].auth, "Bearer tok")
    assert.equal(seen[0].body, '{"name":"x"}')

    // GET 带 body 是矛盾输入，早报错好过让服务端猜
    const bad = await ToolRegistry.call("http_request",
      { url: `http://127.0.0.1:${port}/x`, method: "GET", body: "y" }, ctx)
    assert.match(bad.output, /cannot carry a body/)

    const badMethod = await ToolRegistry.call("http_request",
      { url: `http://127.0.0.1:${port}/x`, method: "TRACE" }, ctx)
    assert.match(badMethod.output, /unsupported method/)
  } finally {
    server.close()
  }
})

test("header names with control characters are dropped, not forwarded", async () => {
  const { ToolRegistry } = await import("../src/tool/registry.mjs")
  const { server, port } = await listen((req, res) => res.end("ok"))
  try {
    const config = {
      tool: {
        sources: { builtin: true, local: false, plugin: false, mcp: false },
        http: { allow_private_hosts: true }
      }
    }
    await ToolRegistry.initialize({ config, cwd: process.cwd(), force: true, allowProjectSources: false })
    // 带 CRLF 的头名/头值能撑开请求走私，必须在到达 fetch 之前清掉
    const out = await ToolRegistry.call("http_request", {
      url: `http://127.0.0.1:${port}/`,
      headers: { "X-Bad\r\nInjected": "v", "X-Good": "line1\r\nline2" }
    }, { cwd: process.cwd(), config })
    assert.match(out.output, /HTTP 200/, `应正常完成而非崩掉：${out.output}`)
  } finally {
    server.close()
  }
})
