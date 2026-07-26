import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { buildRequestHeaders, createRequestContext } from "../http/identity.mjs"
import { userRootDir } from "../storage/paths.mjs"
import { ProviderError } from "../core/errors.mjs"
import { startAuditSpan } from "../audit/event.mjs"
import {
  assertCredentialTransport,
  assertProviderOutboundAllowed
} from "./security.mjs"
import { validateModelId } from "./model-id.mjs"

export const DEFAULT_MODEL_CACHE_TTL_MS = 15 * 60 * 1000
const MAX_PAGES = 100
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const cacheMemory = new Map()

function cachePath() {
  return path.join(userRootDir(), "cache", "models.json")
}

function configRoot(configState) {
  return configState?.config || configState || {}
}

function resolveHttpUrl(value, label, relativeTo = null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProviderError(`${label} is required for model discovery`, {
      reason: "invalid_config"
    })
  }
  let url
  try {
    url = relativeTo ? new URL(value, relativeTo) : new URL(value)
  } catch {
    throw new ProviderError(`${label} must be a valid URL`, {
      reason: "invalid_config"
    })
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ProviderError(`${label} must use http or https`, {
      reason: "invalid_config"
    })
  }
  if (url.username || url.password) {
    throw new ProviderError(`${label} must not include credentials`, {
      reason: "invalid_config"
    })
  }
  url.hash = ""
  return url
}

function appendModelsPath(baseUrl) {
  const url = resolveHttpUrl(baseUrl, "provider base_url")
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`
  url.search = ""
  return url
}

function providerProtocol(name, provider) {
  const type = provider.type || name
  if (type === "gateway") {
    if (!["openai", "anthropic"].includes(provider.protocol)) {
      throw new ProviderError(`provider "${name}" gateway protocol must be openai or anthropic`, {
        provider: name,
        reason: "invalid_config"
      })
    }
    return provider.protocol
  }
  if (type === "anthropic") return "anthropic"
  if (type === "openai" || type === "openai-compatible") return "openai"
  throw new ProviderError(`provider "${name}" does not expose an OpenAI or Anthropic model catalog`, {
    provider: name,
    reason: "unsupported_protocol"
  })
}

function explicitOfflineModels(configState, providerName) {
  const direct = configState?.source
      ? [
        configState.source.envOverlay,
        configState.source.projectRaw,
        configState.source.userRaw
      ].map((source) => source?.provider?.[providerName]?.models).find(Array.isArray)
    : configState?.config?.provider?.[providerName]?.models || configState?.provider?.[providerName]?.models
  if (!Array.isArray(direct)) return []
  return [...new Set(normalizeModels(direct).map((model) => model.id))]
}

export function resolveProviderConnection(configState, providerName = null) {
  const config = configRoot(configState)
  const name = providerName || config.provider?.default
  if (!name) {
    throw new ProviderError("no provider selected", { reason: "invalid_config" })
  }
  const provider = config.provider?.[name]
  if (!provider || typeof provider !== "object") {
    throw new ProviderError(`provider "${name}" is not configured`, {
      provider: name,
      reason: "unknown_provider"
    })
  }
  const protocol = providerProtocol(name, provider)
  const protocolEndpoint = provider.endpoints?.[protocol]
  const protocolBase = protocolEndpoint || provider.base_url
  const relativeTo = protocolEndpoint && provider.base_url
    ? `${String(provider.base_url).replace(/\/+$/, "")}/`
    : null
  const baseUrl = resolveHttpUrl(
    protocolBase,
    `provider.${name}.${protocolEndpoint ? `endpoints.${protocol}` : "base_url"}`,
    relativeTo
  )
  const modelsUrl = provider.endpoints?.models
    ? resolveHttpUrl(provider.endpoints.models, `provider.${name}.endpoints.models`, `${baseUrl.toString().replace(/\/+$/, "")}/`)
    : appendModelsPath(baseUrl.toString())
  const apiKeyEnv = provider.api_key_env || ""
  return {
    name,
    type: provider.type || name,
    protocol,
    baseUrl: baseUrl.toString().replace(/\/+$/, ""),
    modelsUrl: modelsUrl.toString(),
    apiKeyEnv,
    apiKey: provider.api_key || (apiKeyEnv ? process.env[apiKeyEnv] : "") || "",
    defaultModel: provider.default_model || "",
    discovery: {
      enabled: provider.discovery?.enabled !== false,
      cacheTtlMs: Number(provider.discovery?.cache_ttl_ms ?? DEFAULT_MODEL_CACHE_TTL_MS)
    }
  }
}

function modelCacheKey(connection) {
  const credentialFingerprint = connection.apiKey
    ? createHash("sha256").update(connection.apiKey).digest("hex")
    : "anonymous"
  return createHash("sha256")
    .update([
      connection.name,
      connection.protocol,
      connection.modelsUrl,
      connection.apiKeyEnv,
      credentialFingerprint
    ].join("\0"))
    .digest("hex")
}

async function readDiskCache(key) {
  const file = cachePath()
  const memoryKey = `${file}\0${key}`
  if (cacheMemory.has(memoryKey)) {
    const cached = cacheMemory.get(memoryKey)
    return { ...cached, models: normalizeModels(cached.models) }
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    const entry = parsed?.version === 1 ? parsed.entries?.[key] : null
    if (entry && Array.isArray(entry.models) && Number.isFinite(entry.fetchedAt)) {
      const normalized = { ...entry, models: normalizeModels(entry.models) }
      cacheMemory.set(memoryKey, normalized)
      return normalized
    }
  } catch {
    // A missing or malformed cache must never prevent live discovery.
  }
  return null
}

async function writeDiskCache(key, entry) {
  const file = cachePath()
  const memoryKey = `${file}\0${key}`
  cacheMemory.set(memoryKey, entry)
  await mkdir(path.dirname(file), { recursive: true })
  let parsed = { version: 1, entries: {} }
  try {
    const current = JSON.parse(await readFile(file, "utf8"))
    if (current?.version === 1 && current.entries && typeof current.entries === "object") {
      parsed = current
    }
  } catch {
    // Start a fresh cache.
  }
  parsed.entries[key] = entry
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, file)
}

function discoveryHeaders(connection, requestId) {
  const authentication = connection.protocol === "anthropic"
    ? {
        customHeaders: {
          ...(connection.apiKey ? { "x-api-key": connection.apiKey } : {}),
          "anthropic-version": "2023-06-01"
        }
      }
    : connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}
  return buildRequestHeaders({
    target: "model-discovery",
    provider: connection.name,
    protocol: connection.protocol,
    requestId,
    openAIClientRequestId: connection.protocol === "openai",
    accept: "application/json",
    ...authentication
  })
}

function timeoutSignal(timeoutMs, parentSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout
}

async function fetchSameOrigin(url, connection, { requestId, timeoutMs, signal }) {
  let current = new URL(url)
  const originalOrigin = current.origin
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(current, {
      method: "GET",
      headers: discoveryHeaders(connection, requestId),
      redirect: "manual",
      signal: timeoutSignal(timeoutMs, signal)
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get("location")
    if (!location) {
      throw new ProviderError(`model discovery redirect from ${originalOrigin} has no location`, {
        provider: connection.name,
        reason: "bad_response"
      })
    }
    const next = resolveHttpUrl(location, "model discovery redirect", current)
    if (next.origin !== originalOrigin) {
      throw new ProviderError("model discovery refused a cross-origin redirect to protect credentials", {
        provider: connection.name,
        reason: "unsafe_redirect"
      })
    }
    current = next
  }
  throw new ProviderError("model discovery exceeded the redirect limit", {
    provider: connection.name,
    reason: "bad_response"
  })
}

function normalizeModels(json) {
  const candidates = Array.isArray(json) ? json
    : Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.models) ? json.models
        : []
  return candidates.map((item) => {
    if (typeof item === "string") {
      return {
        id: validateModelId(item, {
          label: "model catalog id",
          reason: "bad_response"
        })
      }
    }
    if (!item || typeof item !== "object") return null
    const rawId = item.id || item.name || item.model || ""
    if (!String(rawId).trim()) return null
    const id = validateModelId(rawId, {
      label: "model catalog id",
      reason: "bad_response"
    })
    const contextLength = readContextLength(item)
    const maxOutput = readMaxOutput(item)
    const supported = Array.isArray(item.supported_parameters) ? item.supported_parameters : null
    return {
      id,
      ...(maxOutput ? { maxOutputTokens: maxOutput } : {}),
      ...(supported ? { supportedParameters: supported } : {}),
      ...(item.display_name || item.displayName ? { displayName: item.display_name || item.displayName } : {}),
      ...(item.owned_by || item.ownedBy ? { ownedBy: item.owned_by || item.ownedBy } : {}),
      ...(item.created_at || item.created ? { created: item.created_at || item.created } : {}),
      ...(contextLength ? { contextLength } : {})
    }
  }).filter(Boolean)
}

/**
 * 从目录条目里提取上下文窗口长度。
 *
 * 0.6.0 之前 normalizeModels 只保留 4 个字段 —— provider 即使在 /models 里
 * 返回了上下文长度也被丢弃，于是这个数字永远只能人肉填进
 * provider.model_context。各家字段名不一，逐个试。
 */
/** 输出上限：思考预算按它的比例推算，拿不到就退回按上下文推 */
function readMaxOutput(item) {
  const candidates = [
    item.max_output_tokens, item.maxOutputTokens,
    item.max_completion_tokens, item.output_token_limit,
    item.top_provider?.max_completion_tokens
  ]
  for (const value of candidates) {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 256) return Math.floor(n)
  }
  return 0
}

function readContextLength(item) {
  const candidates = [
    item.context_length, item.contextLength,
    item.context_window, item.contextWindow,
    item.max_context_window_tokens, item.max_context_length,
    item.max_input_tokens, item.input_token_limit
  ]
  for (const value of candidates) {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 1024) return Math.floor(n)
  }
  return 0
}

/**
 * 把发现到的上下文长度合并进 configState 的 provider.model_context（仅内存，
 * 不落盘）。用户显式写过的键绝不覆盖 —— 手工配置优先于 API 自报。
 * 返回本次新增的条数，调用方可据此提示。
 */
export function applyDiscoveredContextLimits(configState, models = []) {
  const provider = configState?.config?.provider
  if (!provider) return 0
  let added = 0
  const mc = { ...(provider.model_context || {}) }
  for (const model of models) {
    if (!model?.id || !model.contextLength) continue
    if (mc[model.id] !== undefined) continue
    mc[model.id] = model.contextLength
    added += 1
  }
  if (added > 0) provider.model_context = mc
  return added
}

/**
 * 把发现到的模型能力（输出上限、是否支持思考）写回该 provider 的内存配置。
 *
 * 这是「不让用户手动填」的落点：思考预算按输出上限的比例推算，输出上限
 * 又能从目录直接读到，于是换模型不需要动任何数字。用户显式写过的值不覆盖。
 */
export function applyDiscoveredCapabilities(configState, providerName, models = []) {
  const provider = configState?.config?.provider?.[providerName]
  if (!provider) return false
  const active = provider.default_model
  const match = models.find((m) => m?.id === active)
  if (!match) return false

  let changed = false
  if (match.maxOutputTokens && provider.max_output_tokens === undefined) {
    provider.max_output_tokens = match.maxOutputTokens
    changed = true
  }
  if (match.contextLength && (provider.context_limit === undefined || provider.context_limit === null)) {
    provider.context_limit = match.contextLength
    changed = true
  }
  return changed
}

function nextPageUrl(json, current, protocol) {
  const direct = json?.next_page_url || json?.next
  if (typeof direct === "string" && direct) return resolveHttpUrl(direct, "model pagination URL", current)
  if (!json?.has_more) return null
  const cursor = json?.last_id || json?.lastId || json?.after
  if (!cursor) {
    throw new ProviderError("model discovery response has_more without a pagination cursor", {
      reason: "bad_response"
    })
  }
  const next = new URL(current)
  next.searchParams.set(protocol === "anthropic" ? "after_id" : "after", String(cursor))
  return next
}

async function readResponseTextLimited(response, connection) {
  const declaredLength = Number(response.headers.get("content-length") || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new ProviderError("model discovery response is too large", {
      provider: connection.name,
      reason: "bad_response"
    })
  }
  if (!response.body?.getReader) {
    const raw = await response.text()
    if (Buffer.byteLength(raw) <= MAX_RESPONSE_BYTES) return raw
    throw new ProviderError("model discovery response is too large", {
      provider: connection.name,
      reason: "bad_response"
    })
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new ProviderError("model discovery response is too large", {
          provider: connection.name,
          reason: "bad_response"
        })
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString("utf8")
}

async function fetchCatalog(connection, { signal = null, timeoutMs = 10000, requestId = "" } = {}) {
  if (connection.apiKeyEnv && !connection.apiKey) {
    throw new ProviderError(`missing API key for provider "${connection.name}" (env: ${connection.apiKeyEnv || "unknown"})`, {
      provider: connection.name,
      reason: "auth"
    })
  }
  const effectiveRequestId = requestId || createRequestContext().requestId
  const models = []
  const seenIds = new Set()
  const seenPages = new Set()
  let current = new URL(connection.modelsUrl)
  const origin = current.origin
  for (let page = 0; page < MAX_PAGES && current; page++) {
    if (current.origin !== origin) {
      throw new ProviderError("model pagination refused a cross-origin URL to protect credentials", {
        provider: connection.name,
        reason: "unsafe_redirect"
      })
    }
    const pageKey = current.toString()
    if (seenPages.has(pageKey)) {
      throw new ProviderError("model discovery pagination loop detected", {
        provider: connection.name,
        reason: "bad_response"
      })
    }
    seenPages.add(pageKey)
    const response = await fetchSameOrigin(current, connection, { requestId: effectiveRequestId, timeoutMs, signal })
    if (!response.ok) {
      throw new ProviderError(`model discovery failed for provider "${connection.name}": HTTP ${response.status}`, {
        provider: connection.name,
        reason: response.status === 401 || response.status === 403 ? "auth" : "bad_response"
      })
    }
    const raw = await readResponseTextLimited(response, connection)
    let json
    try {
      json = JSON.parse(raw)
    } catch {
      throw new ProviderError("model discovery returned invalid JSON", {
        provider: connection.name,
        reason: "bad_response"
      })
    }
    for (const model of normalizeModels(json)) {
      if (seenIds.has(model.id)) continue
      seenIds.add(model.id)
      models.push(model)
    }
    const responseUrl = response.url ? new URL(response.url) : current
    current = nextPageUrl(json, responseUrl, connection.protocol)
  }
  if (current) {
    throw new ProviderError(`model discovery exceeded ${MAX_PAGES} pages`, {
      provider: connection.name,
      reason: "bad_response"
    })
  }
  return { models, requestId: effectiveRequestId, pageCount: seenPages.size }
}

export async function discoverModelsForProvider(configState, {
  providerName = null,
  refresh = false,
  signal = null,
  timeoutMs = 10000,
  now = Date.now()
} = {}) {
  const connection = resolveProviderConnection(configState, providerName)
  const requestContext = createRequestContext()
  const auditSpan = await startAuditSpan({
    type: "model.discovery",
    ...requestContext,
    provider: connection.name,
    protocol: connection.protocol,
    refresh
  }).catch(() => null)
  try {
    const offlineModels = explicitOfflineModels(configState, connection.name)
    if (!connection.discovery.enabled) {
      if (!offlineModels.length) {
        throw new ProviderError(`model discovery is disabled for provider "${connection.name}" and no user models list is configured`, {
          provider: connection.name,
          reason: "model_catalog_unavailable"
        })
      }
      const result = {
        provider: connection.name,
        protocol: connection.protocol,
        models: offlineModels.map((id) => ({ id })),
        source: "config",
        cached: false,
        stale: false,
        fetchedAt: null,
        requestId: null
      }
      await auditSpan?.finish({ status: "ok", source: result.source, modelCount: result.models.length })
      return result
    }

    // These checks deliberately run before cache reads. A catalog populated
    // under a trusted configuration must not make the same project-controlled
    // endpoint appear safe after the workspace is untrusted.
    await assertProviderOutboundAllowed(configState, {
      providerName: connection.name,
      protocol: connection.protocol,
      operation: "model discovery"
    })
    assertCredentialTransport({
      baseUrl: connection.modelsUrl,
      apiKey: connection.apiKey,
      providerName: connection.name,
      operation: "model discovery"
    })

    const key = modelCacheKey(connection)
    const cached = await readDiskCache(key)
    if (!refresh && cached && now - cached.fetchedAt < connection.discovery.cacheTtlMs) {
      const result = {
        provider: connection.name,
        protocol: connection.protocol,
        models: cached.models,
        source: "cache",
        cached: true,
        stale: false,
        fetchedAt: cached.fetchedAt,
        requestId: null
      }
      await auditSpan?.finish({ status: "ok", source: result.source, modelCount: result.models.length })
      return result
    }

    try {
      const live = await fetchCatalog(connection, {
        signal,
        timeoutMs,
        requestId: requestContext.requestId
      })
      const entry = { fetchedAt: now, models: live.models }
      let warning = null
      try {
        await writeDiskCache(key, entry)
      } catch (error) {
        warning = `model cache could not be written: ${error?.message || "unknown error"}`
      }
      const result = {
        provider: connection.name,
        protocol: connection.protocol,
        models: live.models,
        source: "network",
        cached: false,
        stale: false,
        fetchedAt: now,
        requestId: live.requestId,
        ...(warning ? { warning } : {})
      }
      await auditSpan?.finish({
        status: "ok",
        source: result.source,
        modelCount: result.models.length,
        pageCount: live.pageCount
      })
      return result
    } catch (error) {
      if (!cached && offlineModels.length) {
        const result = {
          provider: connection.name,
          protocol: connection.protocol,
          models: offlineModels.map((id) => ({ id })),
          source: "config",
          cached: false,
          stale: true,
          fetchedAt: null,
          requestId: null,
          warning: error?.message || "model discovery failed"
        }
        await auditSpan?.finish({
          status: "stale",
          source: result.source,
          stale: true,
          modelCount: result.models.length
        })
        return result
      }
      if (!cached) throw error
      const result = {
        provider: connection.name,
        protocol: connection.protocol,
        models: cached.models,
        source: "cache",
        cached: true,
        stale: true,
        fetchedAt: cached.fetchedAt,
        requestId: null,
        warning: error?.message || "model discovery failed"
      }
      await auditSpan?.finish({
        status: "stale",
        source: result.source,
        stale: true,
        modelCount: result.models.length
      })
      return result
    }
  } catch (error) {
    await auditSpan?.fail(error, { status: "error" })
    throw error
  }
}

export function clearModelCatalogMemoryCache() {
  cacheMemory.clear()
}
