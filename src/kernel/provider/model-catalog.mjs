import path from "node:path"
import { createHmac, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { buildRequestHeaders, createRequestContext } from "../../http/identity.mjs"
import { userRootDir } from "../../storage/paths.mjs"
import { ProviderError } from "../core/errors.mjs"
import { startAuditSpan } from "../../audit/event.mjs"
import {
  assertCredentialTransport,
  assertProviderOutboundAllowed
} from "./security.mjs"
import { validateModelId } from "./model-id.mjs"
import { trimTrailingSlashes } from "./url-path.mjs"
import { supportsThinking } from "./thinking-effort.mjs"
import { assertProviderDataPolicy } from '../permission/data-policy.mjs'
import {
  MODEL_CAPABILITY_KEYS,
  inferCapabilitiesFromName,
  normalizeCapabilities,
  parseCatalogEntryCapabilities,
  parseCatalogEntryPricing
} from "./model-capabilities.mjs"

export const DEFAULT_MODEL_CACHE_TTL_MS = 15 * 60 * 1000
const MAX_PAGES = 100
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const cacheMemory = new Map()

// 每个模型条目都标出来源：auto = 自动发现（network/cache），manual = 手动
// 维护的配置回退。上游（/model 选择器、远程 models.updated 事件）按条目渲染
// 徽标，不用再解释顶层 source。origin 是返回时附加的，不写进磁盘缓存。
function withOrigin(models, origin) {
  return models.map((model) => ({ ...model, origin }))
}

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
  url.pathname = `${trimTrailingSlashes(url.pathname)}/models`
  url.search = ""
  return url
}

function providerProtocol(name, provider) {
  const type = provider.type || name
  if (type === "gateway") {
    if (!["openai", "responses", "anthropic"].includes(provider.protocol)) {
      throw new ProviderError(`provider "${name}" gateway protocol must be openai, responses or anthropic`, {
        provider: name,
        reason: "invalid_config"
      })
    }
    return provider.protocol
  }
  if (type === "anthropic") return "anthropic"
  if (type === 'openai-responses' || ['openai', 'openai-compatible'].includes(type) && provider.protocol === 'responses') return 'responses'
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
    ? `${trimTrailingSlashes(String(provider.base_url))}/`
    : null
  const baseUrl = resolveHttpUrl(
    protocolBase,
    `provider.${name}.${protocolEndpoint ? `endpoints.${protocol}` : "base_url"}`,
    relativeTo
  )
  const modelsUrl = provider.endpoints?.models
    ? resolveHttpUrl(provider.endpoints.models, `provider.${name}.endpoints.models`, `${trimTrailingSlashes(baseUrl.toString())}/`)
    : appendModelsPath(protocol === 'responses' ? (() => { const url = new URL(baseUrl); url.pathname = url.pathname.replace(/\/responses\/?$/, ''); return url.href })() : baseUrl.toString())
  const apiKeyEnv = provider.api_key_env || ""
  return {
    name,
    type: provider.type || name,
    protocol,
    baseUrl: trimTrailingSlashes(baseUrl.toString()),
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
  // Partition catalog metadata by credential so key rotation cannot reuse another
  // account's model list. This is a cache namespace, not a password verifier;
  // cache entries contain only fetchedAt/models and never authenticate a caller.
  // Domain-separated HMAC scopes the *actual* credential to this catalog. Env
  // variable names are not secrets or identities: renaming the variable with
  // the same value should keep the same cache, while rotating its value must not.
  return createHmac("sha256", connection.apiKey || "")
    .update(JSON.stringify([
      "kkcode.model-catalog.v2",
      connection.name,
      connection.protocol,
      connection.modelsUrl
    ]))
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
    openAIClientRequestId: ['openai', 'responses'].includes(connection.protocol),
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
    // Neither following nor rejecting a redirect consumes its body. Release
    // the socket now, including endless/error bodies, rather than wait for TTL.
    await response.body?.cancel().catch(() => {})
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
    // 能力与定价随条目一起进磁盘缓存与 models.updated —— 解析只认有证据的
    // 字段，拿不到就是 undefined（不编），归一化形态在缓存回放时原样穿透。
    const capabilities = parseCatalogEntryCapabilities(item)
    const pricing = parseCatalogEntryPricing(item)
    return {
      id,
      ...(maxOutput ? { maxOutputTokens: maxOutput } : {}),
      ...(supported ? { supportedParameters: supported } : {}),
      ...(item.display_name || item.displayName ? { displayName: item.display_name || item.displayName } : {}),
      ...(item.owned_by || item.ownedBy ? { ownedBy: item.owned_by || item.ownedBy } : {}),
      ...(item.created_at || item.created ? { created: item.created_at || item.created } : {}),
      ...(contextLength ? { contextLength } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(pricing ? { pricing } : {})
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
      await response.body?.cancel().catch(() => {})
      throw new ProviderError(`model discovery failed for provider "${connection.name}": HTTP ${response.status}`, {
        provider: connection.name,
        status: response.status,
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
        models: withOrigin(offlineModels.map((id) => ({ id })), "manual"),
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
    assertProviderDataPolicy(configState, { providerName: connection.name, baseUrl: connection.modelsUrl })
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
        models: withOrigin(cached.models, "auto"),
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
        models: withOrigin(live.models, "auto"),
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
          models: withOrigin(offlineModels.map((id) => ({ id })), "manual"),
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
        models: withOrigin(cached.models, "auto"),
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

/**
 * 只读发现缓存（内存 → 磁盘），绝不触网。
 *
 * 请求路径上的能力解析用它：每条消息都要过这一关，绝不能为「顺便看看有
 * 没有新能力」去发请求。缓存没有就是 null —— 调用方按「未知」放行。
 * 配置残缺（provider 不存在、URL 非法）也折成 null：请求路径会在后面的
 * 环节用更具体的错误失败，能力解析不该抢先。
 */
export async function readCachedModelCatalog(configState, providerName = null) {
  try {
    const connection = resolveProviderConnection(configState, providerName)
    const cached = await readDiskCache(modelCacheKey(connection))
    if (!cached) return null
    return { provider: connection.name, models: cached.models, fetchedAt: cached.fetchedAt }
  } catch {
    return null
  }
}

/**
 * 解析一个模型的有效能力标记：配置 → 发现缓存 → 名字族启发式，逐键取第一个
 * 确知值。reasoning 额外认 `provider.model_thinking`（/provider add 的既有
 * 落点，语义与 capabilities.reasoning 相同）。
 *
 * 返回 `{ capabilities, sources }`：capabilities 只含确知（布尔）键，
 * sources 逐键标记来源（"config" | "discovered" | "heuristic"）—— 「探测不
 * 到回退手动/默认值并明确标记」的「标记」就落在 sources 上，UI 可以据此
 * 区分「API 说的」与「我们猜的」。
 *
 * 永不抛错、永不触网：这是每条模型请求都要走的热路径，解析失败必须等价于
 * 「未知」而不是把请求弄挂。
 */
export async function resolveModelCapabilities(configState, providerName, modelId) {
  const capabilities = {}
  const sources = {}
  try {
    const id = String(modelId || "").trim()
    if (!id) return { capabilities, sources }
    const config = configRoot(configState)

    const configured = normalizeCapabilities(config?.provider?.model_capabilities?.[id])
    for (const key of MODEL_CAPABILITY_KEYS) {
      if (configured[key] !== undefined) {
        capabilities[key] = configured[key]
        sources[key] = "config"
      }
    }
    const configuredThinking = config?.provider?.model_thinking?.[id]
    if (capabilities.reasoning === undefined && typeof configuredThinking === "boolean") {
      capabilities.reasoning = configuredThinking
      sources.reasoning = "config"
    }

    const missing = MODEL_CAPABILITY_KEYS.filter((key) => capabilities[key] === undefined)
    if (missing.length) {
      const cached = await readCachedModelCatalog(configState, providerName)
      const entry = cached?.models?.find((model) => model?.id === id)
      const discovered = normalizeCapabilities(entry?.capabilities)
      for (const key of missing) {
        if (discovered[key] !== undefined) {
          capabilities[key] = discovered[key]
          sources[key] = "discovered"
        }
      }
    }

    if (capabilities.image === undefined) {
      const heuristic = inferCapabilitiesFromName(id)
      if (typeof heuristic.image === "boolean") {
        capabilities.image = heuristic.image
        sources.image = "heuristic"
      }
    }
    if (capabilities.reasoning === undefined) {
      const thinking = supportsThinking({ modelId: id })
      if (typeof thinking === "boolean") {
        capabilities.reasoning = thinking
        sources.reasoning = "heuristic"
      }
    }
  } catch {
    // 见上：解析失败 = 未知。
  }
  return { capabilities, sources }
}
