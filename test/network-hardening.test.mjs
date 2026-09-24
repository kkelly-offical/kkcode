import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib"
import { once } from "node:events"
import { assertFetchableUrl, blockedIpReason, guardedFetch } from "../src/net/url-guard.mjs"
import { htmlToReadableMarkdown, readablePage } from "../src/net/readable-page.mjs"

async function fixture(t, handler) {
  const server = http.createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${server.address().port}`
}
const local = { allowPrivate: true }

test("cross-origin redirects drop arbitrary credential headers, even on a return hop", async t => {
  const seen = []
  let first
  const second = await fixture(t, (req, res) => {
    seen.push(req.headers)
    res.writeHead(302, { location: `${first}/final` }); res.end()
  })
  first = await fixture(t, (req, res) => {
    seen.push(req.headers)
    if (req.url === "/start") res.writeHead(302, { location: second })
    res.end("ok")
  })
  await guardedFetch(`${first}/start`, { headers: {
    Authorization: "Bearer fixture", Cookie: "session=fixture", "X-API-Key": "fixture",
    "X-Internal-Credential": "fixture", Referer: "https://example.test/?token=fixture", Accept: "text/plain"
  } }, local)
  assert.equal(seen[0].authorization, "Bearer fixture")
  for (const headers of seen.slice(1)) {
    for (const name of ["authorization", "cookie", "x-api-key", "x-internal-credential", "referer"]) assert.equal(headers[name], undefined)
    assert.equal(headers.accept, "text/plain")
  }
})

test("same-origin redirect preserves credentials and POST-to-GET drops body metadata", async t => {
  const seen = []
  const origin = await fixture(t, (req, res) => {
    seen.push({ method: req.method, headers: req.headers })
    if (req.url === "/start") res.writeHead(302, { location: "/final" })
    res.end("ok")
  })
  await guardedFetch(`${origin}/start`, { method: "post", body: "fixture", headers: {
    Authorization: "Bearer fixture", "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": "999"
  } }, local)
  assert.equal(seen[1].method, "GET")
  assert.equal(seen[1].headers.authorization, "Bearer fixture")
  for (const name of ["content-type", "content-encoding", "content-length"]) assert.equal(seen[1].headers[name], undefined)
})

test("cross-origin redirects never replay write bodies", async t => {
  let destinationCalls = 0
  const destination = await fixture(t, (_req, res) => { destinationCalls++; res.end("unexpected") })
  const origin = await fixture(t, (_req, res) => { res.writeHead(307, { location: destination }); res.end() })
  await assert.rejects(guardedFetch(origin, { method: "POST", body: "fixture-secret" }, local), /cross-origin redirect/)
  assert.equal(destinationCalls, 0)
})

test("307 preserves same-origin method/body and 302 preserves non-POST methods", async t => {
  const seen = []
  const origin = await fixture(t, (req, res) => {
    const chunks = []
    req.on("data", chunk => chunks.push(chunk))
    req.on("end", () => {
      seen.push([req.method, Buffer.concat(chunks).toString()])
      if (req.url === "/307") res.writeHead(307, { location: "/final" })
      if (req.url === "/302") res.writeHead(302, { location: "/final" })
      res.end("ok")
    })
  })
  for (const status of [307, 302]) await guardedFetch(`${origin}/${status}`, { method: "PUT", body: "payload" }, local)
  assert.deepEqual(seen, Array.from({ length: 4 }, () => ["PUT", "payload"]))
})

test("DNS snapshot is validated once and pinned to the actual connection", async t => {
  let host
  const origin = await fixture(t, (req, res) => { host = req.headers.host; res.end("pinned") })
  let lookups = 0
  const url = origin.replace("127.0.0.1", "pinned.invalid")
  const { response } = await guardedFetch(url, {}, { ...local, lookup: async hostname => {
    assert.equal(hostname, "pinned.invalid")
    lookups++
    return [{ address: lookups === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }]
  } })
  assert.equal(await response.text(), "pinned")
  assert.equal(host, new URL(url).host)
  assert.equal(lookups, 1)
})

test("all DNS records are checked, metadata aliases remain blocked with private consent", async () => {
  const options = { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] }
  await assert.rejects(guardedFetch("http://fixture.invalid/", {}, options), /loopback/)
  await assert.rejects(guardedFetch("http://fixture.invalid/", {}, { ...local, lookup: async () => [{ address: "169.254.169.254", family: 4 }] }), /metadata/)
  await assert.rejects(guardedFetch("http://fixture.invalid/", {}, { lookup: async () => [] }), /no usable/)
  await assert.rejects(guardedFetch("http://fixture.invalid/", {}, { lookup: async () => [{ address: "127.0.0.1", family: 6 }] }), /invalid address/)
  for (const host of ["[::ffff:a9fe:a9fe]", "metadata.google.internal."]) await assert.rejects(assertFetchableUrl(`http://${host}/`, local), /metadata/)
  for (const ip of ["::ffff:7f00:1", "0:0:0:0:0:0:0:1", "febf::1", "fe90::1"]) assert.ok(blockedIpReason(ip), ip)
})

test("every redirect gets a fresh validated DNS snapshot", async t => {
  let calls = 0, lookups = 0
  const origin = await fixture(t, (_req, res) => { calls++; res.writeHead(302, { location: "/next" }); res.end() })
  await assert.rejects(guardedFetch(origin.replace("127.0.0.1", "rebind.invalid"), {}, {
    ...local, lookup: async () => [{ address: ++lookups === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }]
  }), /metadata/)
  assert.equal(calls, 1)
  assert.equal(lookups, 2)
})

test("wire and decoded limits apply before complete body allocation", async t => {
  const encoded = gzipSync(Buffer.alloc(65536, "a"))
  const origin = await fixture(t, (req, res) => {
    if (req.url === "/gzip") { res.writeHead(200, { "content-encoding": "gzip" }); res.end(encoded) }
    else if (req.url === "/length") { res.writeHead(200, { "content-length": "65536" }); res.flushHeaders() }
    else { res.writeHead(200); res.write(Buffer.alloc(1024)); res.end(Buffer.alloc(1024)) }
  })
  await assert.rejects(guardedFetch(`${origin}/gzip`, {}, { ...local, maxDecodedBytes: 1024 }), /decoded response exceeds/)
  await assert.rejects(guardedFetch(`${origin}/chunked`, {}, { ...local, maxWireBytes: 1024 }), /wire response exceeds/)
  await assert.rejects(guardedFetch(`${origin}/length`, {}, { ...local, maxWireBytes: 1024 }), /wire response exceeds/)
})

test("supported compressed bodies decode and advertise decoded metadata", async t => {
  const content = Buffer.from("中文 fixture")
  const fixtures = new Map([
    ["/gzip", { encoding: "gzip", encoded: gzipSync(content) }],
    ["/deflate", { encoding: "deflate", encoded: deflateSync(content) }],
    ["/br", { encoding: "br", encoded: brotliCompressSync(content) }],
  ])
  const origin = await fixture(t, (req, res) => {
    const selected = fixtures.get(req.url)
    if (!selected) { res.writeHead(404); res.end("Unknown compression fixture"); return }
    const { encoding, encoded } = selected
    res.writeHead(200, { "content-encoding": encoding, "content-length": encoded.length, "content-type": "text/plain" })
    res.end(encoded)
  })
  for (const name of ["constructor", "__proto__", "toString", "unknown"]) {
    const { response } = await guardedFetch(`${origin}/${name}`, {}, local)
    assert.equal(response.status, 404)
    assert.equal(await response.text(), "Unknown compression fixture")
  }
  for (const requestPath of fixtures.keys()) {
    const { response } = await guardedFetch(`${origin}${requestPath}`, {}, local)
    assert.equal(await response.text(), "中文 fixture")
    assert.equal(response.headers.get("content-encoding"), null)
    assert.equal(response.headers.get("content-length"), null)
  }
})

test("unknown compression and truncated compressed bodies fail explicitly", async t => {
  const origin = await fixture(t, (req, res) => {
    res.writeHead(200, { "content-encoding": req.url === "/unknown" ? "gzip, br" : "gzip" })
    res.end("not a gzip stream")
  })
  await assert.rejects(guardedFetch(`${origin}/unknown`, {}, local), /unsupported response content encoding/)
  await assert.rejects(guardedFetch(`${origin}/broken`, {}, local), /header|gzip|compression/)
})

test("HEAD and bodyless status responses do not enter decompression", async t => {
  const origin = await fixture(t, (req, res) => {
    res.writeHead(req.url === "/empty" ? 204 : 200, { "content-encoding": "gzip", "content-length": "200" })
    res.end()
  })
  for (const [path, method, status] of [["/head", "HEAD", 200], ["/empty", "GET", 204]]) {
    const { response } = await guardedFetch(`${origin}${path}`, { method }, local)
    assert.equal(response.status, status)
    assert.equal(await response.text(), "")
  }
})

test("redirect bodies are closed without draining and cancellation aborts body and DNS", async t => {
  let closed
  const closedPromise = new Promise(resolve => { closed = resolve })
  const origin = await fixture(t, (req, res) => {
    if (req.url === "/redirect") {
      res.on("close", closed)
      res.writeHead(302, { location: "/final" }); res.write("never ending redirect")
    } else if (req.url === "/hang") { res.writeHead(200); res.write("never ending body") }
    else res.end("done")
  })
  const { response } = await guardedFetch(`${origin}/redirect`, {}, local)
  assert.equal(await response.text(), "done")
  await closedPromise
  await assert.rejects(guardedFetch(`${origin}/hang`, { signal: AbortSignal.timeout(40) }, local), /abort|timeout/i)
  await assert.rejects(guardedFetch("http://pending.invalid/", { signal: AbortSignal.timeout(40) }, { lookup: () => new Promise(() => {}) }), /abort|timeout/i)
})

test("static HTML becomes linked Markdown, not executable markup or scripts", () => {
  const { title, markdown } = htmlToReadableMarkdown(`<!doctype html><html><head><title>Fixture &amp; docs</title><style>secret-style</style></head>
    <body><nav>boilerplate</nav><main><h1>Overview</h1><p>Hello <strong>world</strong> &amp; friends.</p>
    <a href="../api?q=1">API</a><a href="javascript:alert(1)">unsafe</a>
    <script>secret-script</script><p hidden="hidden">hidden-data</p><p aria-hidden="true">hidden-aria</p>
    <ul><li>One</li><li>Two</li></ul><pre><code>const value = &lt;tag&gt;;</code></pre></main></body></html>`, "https://example.test/docs/page")
  assert.equal(title, "Fixture & docs")
  assert.match(markdown, /# Overview/)
  assert.match(markdown, /Hello \*\*world\*\* & friends/)
  assert.match(markdown, /\[API\]\(https:\/\/example.test\/api\?q=1\)/)
  assert.match(markdown, /- One/)
  assert.match(markdown, /const value = <tag>;/)
  assert.doesNotMatch(markdown, /secret-|hidden-|javascript:|boilerplate|<script/)
})

test("readable pages preserve source and text formats; binary and oversized HTML fail", async () => {
  assert.equal(await readablePage(new Response('{"ok":true}', { headers: { "content-type": "application/json" } }), "https://example.test/data"), 'Source: https://example.test/data\n\n{"ok":true}')
  await assert.rejects(readablePage(new Response("binary", { headers: { "content-type": "image/png" } }), "https://example.test/"), /unsupported content type/)
  assert.throws(() => htmlToReadableMarkdown("a".repeat(2 * 1024 * 1024 + 1), "https://example.test/"), /parsing limit/)
  const latin = await readablePage(new Response(Uint8Array.of(233), { headers: { "content-type": "text/plain; charset=windows-1252" } }), "https://example.test/")
  assert.match(latin, /é/)
})

test("webfetch rejects unsupported prompts before networking and returns static source links", async t => {
  const { ToolRegistry } = await import("../src/kernel/tool/registry.mjs")
  let calls = 0
  const origin = await fixture(t, (_req, res) => { calls++; res.writeHead(200, { "content-type": "text/html" }); res.end('<html><body><h1>Docs</h1><a href="/next">Next</a></body></html>') })
  const config = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false }, http: { allow_private_hosts: true } } }
  await ToolRegistry.initialize({ config, cwd: process.cwd(), force: true, allowProjectSources: false })
  const ctx = { cwd: process.cwd(), config }
  const rejected = await ToolRegistry.call("webfetch", { url: origin, prompt: "Summarize it" }, ctx)
  assert.match(rejected.output, /does not run a processing prompt/)
  assert.equal(calls, 0)
  const result = await ToolRegistry.call("webfetch", { url: origin }, ctx)
  assert.match(result.output, /Source: http:/)
  assert.match(result.output, /# Docs/)
  assert.ok(result.output.includes(`[Next](${origin}/next)`))
  assert.equal(calls, 1)
})
