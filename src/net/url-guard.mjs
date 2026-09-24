import dns from "node:dns/promises"
import net from "node:net"
import http from "node:http"
import https from "node:https"
import { PassThrough, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"

/**
 * 出网目标校验（SSRF 防护）。
 *
 * 起因：0.7.0 的计划里写「http_request 复用现有出网安全校验」—— 查过之后
 * 发现**没有**这样的校验。`webfetch` 当时能把 `http://127.0.0.1:38412/admin`
 * 的响应体原样读回来（实测确认，不是推测），也就是说模型可以拿它当内网扫描
 * 器与云元数据读取器用。而 `http_request` 支持任意 method/headers/body，会把
 * 「能读内网」放大成「能对内网服务发 POST」。
 *
 * 所以这道闸是新增工具的前置条件，不是配套增强。
 *
 * 防的是什么：
 *   - 云元数据端点（AWS/GCP/Azure 都在 169.254.169.254）—— 一次 GET 就能
 *     拿到实例凭证
 *   - 回环与内网地址 —— 开发机上跑的数据库、管理面板、其他 agent
 *   - DNS 重绑定：域名解析出来的 IP 才是要判定的对象，不能只看字面
 *   - 重定向逃逸：`https://evil.com/r` → `http://169.254.169.254/`，
 *     所以调用方必须用 redirect:"manual" 并对每一跳重新校验
 *   - URL 里内嵌的凭证（`http://user:pass@host`）
 */

/** 云元数据端点。这些是最高价值目标：一次 GET 换实例凭证。 */
const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "fd00:ec2::254",
  "100.100.100.200"  // 阿里云
])

export class UrlGuardError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = "UrlGuardError"
    this.details = details
  }
}

function ipv4Blocked(ip) {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "malformed IPv4"
  const [a, b] = parts
  if (a === 0) return "\"this network\" (0.0.0.0/8)"
  if (a === 10) return "private (10.0.0.0/8)"
  if (a === 127) return "loopback (127.0.0.0/8)"
  if (a === 169 && b === 254) return "link-local / cloud metadata (169.254.0.0/16)"
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12)"
  if (a === 192 && b === 168) return "private (192.168.0.0/16)"
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10)"
  if (a === 192 && b === 0) return "IETF protocol assignments (192.0.0.0/24)"
  if (a >= 224) return "multicast or reserved (224.0.0.0/4+)"
  return null
}

function ipv6Blocked(ip) {
  const lower = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase()
  if (lower === "::1" || lower === "::") return "loopback (::1)"
  if (/^fe[89ab]/.test(lower)) return "link-local (fe80::/10)"
  if (/^f[cd]/.test(lower)) return "unique local address (fc00::/7)"
  if (lower.startsWith("ff")) return "multicast (ff00::/8)"
  // IPv4-mapped（::ffff:127.0.0.1）—— 绕过 IPv4 判定的经典手法
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(lower)
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
    const reason = ipv4Blocked([high >>> 8, high & 255, low >>> 8, low & 255].join("."))
    return reason ? `IPv4-mapped ${reason}` : null
  }
  return null
}

/** 这个字面 IP 是否禁止访问；允许则返回 null。 */
export function blockedIpReason(ip) {
  const version = net.isIP(ip)
  if (version === 4) return ipv4Blocked(ip)
  if (version === 6) return ipv6Blocked(ip)
  return null
}

/**
 * 校验一个出网 URL。
 *
 * @param {string} rawUrl
 * @param {{allowPrivate?: boolean, resolve?: boolean, lookup?: (hostname: string) => Promise<{address: string, family: number}[]>}} options
 *   allowPrivate 供本地开发显式放开（config: `tool.http.allow_private_hosts`）
 *   resolve=false 只做字面检查，用于不便做 DNS 的场景
 * @returns {Promise<URL>} 校验通过的 URL
 */
export async function assertFetchableUrl(rawUrl, { allowPrivate = false, resolve = true, lookup = defaultLookup } = {}) {
  let url
  try {
    url = new URL(String(rawUrl || ""))
  } catch {
    throw new UrlGuardError("not a valid URL (HTTP or HTTPS required)")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlGuardError(
      `blocked scheme "${url.protocol}" — only http and https are allowed`,
      { url: url.href }
    )
  }

  // `http://user:pass@host` 会把凭证塞进请求，也常用来混淆真实主机
  if (url.username || url.password) {
    throw new UrlGuardError("credentials embedded in the URL are not allowed", { url: url.origin })
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")

  // 元数据端点无论怎么配都不放行：读到的是实例凭证，不是数据
  if (isMetadataAddress(hostname)) {
    throw new UrlGuardError(
      `blocked cloud metadata endpoint ${hostname} — it serves instance credentials`,
      { url: url.href }
    )
  }

  if (!allowPrivate && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw new UrlGuardError(
      "blocked localhost — set tool.http.allow_private_hosts: true to reach local services",
      { url: url.href }
    )
  }

  const literal = blockedIpReason(hostname)
  if (!allowPrivate && literal) {
    throw new UrlGuardError(
      `blocked ${hostname}: ${literal} — set tool.http.allow_private_hosts: true to reach local services`,
      { url: url.href }
    )
  }

  if (!resolve || net.isIP(hostname)) return url

  // DNS 重绑定：判定对象必须是解析出来的 IP，而不是域名字面。
  // `internal.evil.com` A 记录指向 127.0.0.1 是最省事的绕过方式。
  const addresses = await lookup(hostname)
  if (!Array.isArray(addresses) || !addresses.length) throw new UrlGuardError("DNS returned no usable addresses")
  for (const { address, family } of addresses) {
    if (!net.isIP(address) || net.isIP(address) !== family) throw new UrlGuardError("DNS returned an invalid address")
    if (isMetadataAddress(address)) {
      throw new UrlGuardError(
        `${hostname} resolves to cloud metadata endpoint ${address}`,
        { url: url.href, address }
      )
    }
    const reason = blockedIpReason(address)
    if (!allowPrivate && reason) {
      throw new UrlGuardError(
        `${hostname} resolves to ${address}: ${reason} — set tool.http.allow_private_hosts: true to reach local services`,
        { url: url.href, address }
      )
    }
  }

  return url
}

/**
 * 带逐跳校验的 fetch。
 *
 * 必须手动跟重定向：默认的自动跟随会让 `https://evil.com/r` → `http://169.254.
 * 169.254/` 这一跳完全绕过入口校验 —— 只校验第一个 URL 等于没校验。
 */
export async function guardedFetch(rawUrl, init = {}, {
  allowPrivate = false, maxRedirects = 5, maxWireBytes = 8 * 1024 * 1024,
  maxDecodedBytes = 8 * 1024 * 1024, maxRequestBytes = 8 * 1024 * 1024, lookup = defaultLookup, assertTarget = null, followRedirects = true, onDecodedBytes = null
} = {}) {
  for (const limit of [maxWireBytes, maxDecodedBytes, maxRequestBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new UrlGuardError("response byte limits must be positive integers")
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw new UrlGuardError("invalid redirect limit")
  // Own a timeout even when used outside a tool. Cancellation includes DNS and
  // the complete response body, not just receipt of response headers.
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(30000)
  let current = await assertFetchableUrl(rawUrl, { allowPrivate, resolve: false })
  let method = String(init.method || "GET").toUpperCase()
  let body = requestBody(init.body, maxRequestBytes)
  if ((method === "GET" || method === "HEAD") && body !== undefined) throw new UrlGuardError(`${method} cannot carry a body`)
  let headers = new Headers(init.headers)
  for (const name of ["host", "connection", "proxy-connection", "proxy-authorization", "transfer-encoding", "content-length", "upgrade"]) headers.delete(name)
  headers.set("accept-encoding", "gzip, deflate, br")

  for (let hop = 0; hop <= maxRedirects; hop++) {
    signal.throwIfAborted()
    await assertTarget?.(current)
    // Validate exactly the records used by the connection. A new, non-pooled
    // socket and a pinned lookup prevent DNS rebinding and stale-pool bypasses.
    const hostname = current.hostname.replace(/^\[|\]$/g, "")
    const addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await withAbort(lookup(hostname), signal)
    await assertFetchableUrl(current.href, { allowPrivate, lookup: async () => addresses })
    const result = await fetchPinned(current, { method, body, headers, signal, addresses, maxWireBytes, maxDecodedBytes, onDecodedBytes })
    if (result.location && !followRedirects) return { response: result.response, url: current, redirects: hop }
    if (!result.location) return { response: result.response, url: current, redirects: hop }
    if (hop === maxRedirects) throw new UrlGuardError(`too many redirects (${maxRedirects})`)
    const next = await assertFetchableUrl(new URL(result.location, current).href, { allowPrivate, resolve: false })
    // Fetch semantics: only POST changes to GET on 301/302; 303 changes all
    // non-GET/HEAD methods. Body metadata must disappear with the body.
    if ((result.status === 303 && method !== "HEAD") || ([301, 302].includes(result.status) && method === "POST")) {
      method = "GET"; body = undefined
      for (const name of ["content-type", "content-encoding", "content-language", "content-location", "content-length", "digest"]) headers.delete(name)
    }
    if (next.origin !== current.origin) {
      if (method !== "GET" && method !== "HEAD") throw new UrlGuardError("cross-origin redirect of a write request requires an explicit request to the new URL")
      // Positive allowlist also protects application-specific tokens, not just
      // Authorization/Cookie. Once removed, credentials never reappear later.
      headers = new Headers([...headers].filter(([name]) => REDIRECT_SAFE_HEADERS.has(name)))
    }
    current = next
  }
  throw new UrlGuardError("redirect loop guard exhausted")
}

const REDIRECT_SAFE_HEADERS = new Set(["accept", "accept-language", "accept-encoding", "user-agent", "range", "cache-control"])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const defaultLookup = hostname => dns.lookup(hostname, { all: true })

function isMetadataAddress(address) {
  const host = address.toLowerCase().replace(/\.$/, "")
  if (METADATA_HOSTS.has(host)) return true
  if (net.isIP(host) !== 6) return false
  const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1)
  if (METADATA_HOSTS.has(canonical)) return true
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical)
  if (!mapped) return false
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
  return METADATA_HOSTS.has([high >>> 8, high & 255, low >>> 8, low & 255].join("."))
}

function requestBody(value, maxBytes) {
  if (value === undefined || value === null) return undefined
  if (!(typeof value === "string" || value instanceof Uint8Array || value instanceof URLSearchParams)) throw new UrlGuardError("guardedFetch requires a replayable string or byte request body")
  const body = Buffer.from(value instanceof URLSearchParams ? value.toString() : value)
  if (body.length > maxBytes) throw new UrlGuardError(`request body exceeds ${maxBytes} bytes`)
  return body
}

async function withAbort(promise, signal) {
  signal.throwIfAborted()
  let abort
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
    })])
  } finally { signal.removeEventListener("abort", abort) }
}

function byteLimiter(limit, label, onBytes = null) {
  let bytes = 0
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length
    try { onBytes?.(chunk.length) } catch (error) { callback(error); return }
    callback(bytes > limit ? new UrlGuardError(`${label} response exceeds ${limit} bytes; narrow the request`) : null, chunk)
  } })
}

async function readResponse(incoming, { method, maxWireBytes, maxDecodedBytes, signal, onDecodedBytes }) {
  if (method === "HEAD" || [204, 205, 304].includes(incoming.statusCode)) { incoming.destroy(); return null }
  if (Number(incoming.headers["content-length"]) > maxWireBytes) throw new UrlGuardError(`wire response exceeds ${maxWireBytes} bytes; narrow the request`)
  const encoding = String(incoming.headers["content-encoding"] || "identity").toLowerCase().trim()
  const decoders = { gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress }
  if (encoding !== "identity" && !Object.hasOwn(decoders, encoding)) throw new UrlGuardError(`unsupported response content encoding: ${encoding}`)
  const decoder = encoding === "identity" ? new PassThrough() : decoders[encoding]()
  const chunks = []
  await pipeline(incoming, byteLimiter(maxWireBytes, "wire"), decoder, byteLimiter(maxDecodedBytes, "decoded", onDecodedBytes),
    async source => { for await (const chunk of source) chunks.push(chunk) }, { signal })
  return Buffer.concat(chunks)
}

function fetchPinned(url, options) {
  const { method, body, headers, signal, addresses } = options
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method, headers: Object.fromEntries(headers), signal, agent: false, timeout: 30000,
      lookup: (_host, lookupOptions, callback) => lookupOptions.all
        ? callback(null, addresses)
        : callback(null, addresses[0].address, addresses[0].family)
    }, incoming => {
      const status = incoming.statusCode || 502
      const location = REDIRECT_STATUSES.has(status) && incoming.headers.location
      const resultHeaders = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || ["connection", "transfer-encoding", "content-encoding", "content-length"].includes(name)) continue
        for (const item of Array.isArray(value) ? value : [value]) resultHeaders.append(name, item)
      }
      if (location) {
        // Do not drain an arbitrary or never-ending redirect body.
        incoming.destroy()
        resolve({ status, location, response: new Response(null, { status, headers: resultHeaders }) })
        return
      }
      readResponse(incoming, options).then(buffer => {
        const response = new Response(buffer, { status, statusText: incoming.statusMessage || "", headers: resultHeaders })
        Object.defineProperty(response, "url", { value: url.href })
        resolve({ response })
      }).catch(error => { incoming.destroy(); reject(error) })
    })
    request.on("timeout", () => request.destroy(new Error("HTTP request timed out")))
    request.on("upgrade", (_response, socket) => { socket.destroy(); reject(new UrlGuardError("HTTP upgrades are not supported")) })
    request.on("error", reject)
    request.end(body)
  })
}

export function allowPrivateHosts(config = {}) {
  return config?.tool?.http?.allow_private_hosts === true
}
