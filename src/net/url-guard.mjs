import dns from "node:dns/promises"
import net from "node:net"

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
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "")
  if (lower === "::1" || lower === "::") return "loopback (::1)"
  if (lower.startsWith("fe80")) return "link-local (fe80::/10)"
  if (/^f[cd]/.test(lower)) return "unique local address (fc00::/7)"
  if (lower.startsWith("ff")) return "multicast (ff00::/8)"
  // IPv4-mapped（::ffff:127.0.0.1）—— 绕过 IPv4 判定的经典手法
  const mapped = /^(?:::ffff:)([0-9.]+)$/.exec(lower)
  if (mapped) {
    const reason = ipv4Blocked(mapped[1])
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
 * @param {{allowPrivate?: boolean, resolve?: boolean}} options
 *   allowPrivate 供本地开发显式放开（config: `tool.http.allow_private_hosts`）
 *   resolve=false 只做字面检查，用于不便做 DNS 的场景
 * @returns {Promise<URL>} 校验通过的 URL
 */
export async function assertFetchableUrl(rawUrl, { allowPrivate = false, resolve = true } = {}) {
  let url
  try {
    url = new URL(String(rawUrl || ""))
  } catch {
    throw new UrlGuardError(`not a valid URL: ${rawUrl}`)
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
  if (METADATA_HOSTS.has(hostname)) {
    throw new UrlGuardError(
      `blocked cloud metadata endpoint ${hostname} — it serves instance credentials`,
      { url: url.href }
    )
  }

  if (allowPrivate) return url

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new UrlGuardError(
      "blocked localhost — set tool.http.allow_private_hosts: true to reach local services",
      { url: url.href }
    )
  }

  const literal = blockedIpReason(hostname)
  if (literal) {
    throw new UrlGuardError(
      `blocked ${hostname}: ${literal} — set tool.http.allow_private_hosts: true to reach local services`,
      { url: url.href }
    )
  }

  if (!resolve || net.isIP(hostname)) return url

  // DNS 重绑定：判定对象必须是解析出来的 IP，而不是域名字面。
  // `internal.evil.com` A 记录指向 127.0.0.1 是最省事的绕过方式。
  let addresses = []
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch (error) {
    // 解析失败交给 fetch 报错，这里不冒充网络错误
    if (error?.code === "ENOTFOUND" || error?.code === "EAI_AGAIN") return url
    throw error
  }

  for (const { address } of addresses) {
    if (METADATA_HOSTS.has(address)) {
      throw new UrlGuardError(
        `${hostname} resolves to cloud metadata endpoint ${address}`,
        { url: url.href, address }
      )
    }
    const reason = blockedIpReason(address)
    if (reason) {
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
export async function guardedFetch(rawUrl, init = {}, { allowPrivate = false, maxRedirects = 5 } = {}) {
  let current = await assertFetchableUrl(rawUrl, { allowPrivate })
  let method = init.method || "GET"
  let body = init.body

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(current, { ...init, method, body, redirect: "manual" })
    const isRedirect = response.status >= 300 && response.status < 400 && response.headers.get("location")
    if (!isRedirect) return { response, url: current, redirects: hop }

    if (hop === maxRedirects) {
      throw new UrlGuardError(`too many redirects (${maxRedirects}) starting from ${rawUrl}`)
    }
    const next = new URL(response.headers.get("location"), current)
    current = await assertFetchableUrl(next.href, { allowPrivate })
    // 303 与「非 GET 收到 301/302」都按规范降级为 GET，body 随之丢弃
    if (response.status === 303 || (response.status === 301 || response.status === 302)) {
      if (method !== "GET" && method !== "HEAD") {
        method = "GET"
        body = undefined
      }
    }
  }
  throw new UrlGuardError("redirect loop guard exhausted")
}

export function allowPrivateHosts(config = {}) {
  return config?.tool?.http?.allow_private_hosts === true
}
