import { requestAnthropic, requestAnthropicStream, countTokensAnthropic } from "./anthropic.mjs"
import { requestOpenAI, requestOpenAIStream, countTokensOpenAI } from "./openai.mjs"
import { request as requestOAICompat, requestStream as requestStreamOAICompat } from "./openai-compatible.mjs"
import { requestOllama, requestOllamaStream } from "./ollama.mjs"
import { resolveProviderAuthProfile, upsertAuthProfile } from "./auth-profiles.mjs"
import { resolveGitHubCopilotRuntimeAuth } from "./github-copilot-auth.mjs"
import { refreshQwenPortalToken } from "./qwen-portal-auth.mjs"
import { createProviderAttemptChain } from "./runtime-factory.mjs"
import { ProviderError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

// --- Provider Registry ---
const registry = new Map()

export function registerProvider(name, mod) {
  if (!mod || typeof mod.request !== "function" || typeof mod.requestStream !== "function") {
    throw new Error(`provider "${name}" must export request() and requestStream()`)
  }
  registry.set(name, mod)
}

export function listProviders() {
  return [...registry.keys()]
}

export function getProvider(name) {
  return registry.get(name) || null
}

// Built-in providers
registerProvider("openai", { request: requestOpenAI, requestStream: requestOpenAIStream, countTokens: countTokensOpenAI })
registerProvider("anthropic", { request: requestAnthropic, requestStream: requestAnthropicStream, countTokens: countTokensAnthropic })
registerProvider("openai-compatible", { request: requestOAICompat, requestStream: requestStreamOAICompat, countTokens: countTokensOpenAI })
registerProvider("ollama", { request: requestOllama, requestStream: requestOllamaStream })

// --- Settings Resolution ---
async function resolveSettings(configState, providerType, overrides = {}) {
  const llm = configState.config.provider

  // Resolve registry key: direct match → config type field → fallback to openai
  let resolvedType = providerType
  if (!registry.has(providerType)) {
    const providerConfig = llm[providerType]
    if (providerConfig?.type && registry.has(providerConfig.type)) {
      resolvedType = providerConfig.type
    } else {
      if (llm.strict_mode) {
        throw new ProviderError(
          `unknown provider "${providerType}". registered: ${listProviders().join(", ")}`,
          { provider: providerType, reason: "unknown_provider" }
        )
      }
      console.warn(`[kkcode] unknown provider "${providerType}", falling back to openai`)
      EventBus.emit({
        type: EVENT_TYPES.PROVIDER_FALLBACK,
        payload: { requested: providerType, resolved: "openai" }
      }).catch(() => {})
      resolvedType = "openai"
    }
  }

  // Read config from original provider name (e.g. "deepseek"), not resolved type
  const defaults = llm[providerType] || llm[resolvedType] || {}
  let auth = await resolveProviderAuthProfile({
    providerId: providerType,
    explicitProfileId: defaults.auth_profile || null
  })
  if (
    auth.readyState === "expired" &&
    auth.profile?.providerId === "qwen-portal" &&
    auth.profile?.refreshToken
  ) {
    try {
      const refreshed = await refreshQwenPortalToken({ refreshToken: auth.profile.refreshToken })
      await upsertAuthProfile({
        ...auth.profile,
        authMode: "oauth",
        credential: refreshed.accessToken,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        lastVerifiedAt: Date.now(),
        status: "ready"
      })
      auth = await resolveProviderAuthProfile({
        providerId: providerType,
        explicitProfileId: defaults.auth_profile || auth.profile.id || null
      })
    } catch {
      // Keep the expired auth state and allow env/config credentials to win.
    }
  }
  const rawModel = String(overrides.model || defaults.default_model || "")
  const normalizedModel = normalizeModelId(rawModel, {
    providerType,
    resolvedType,
    providerConfigType: defaults.type || null
  })
  const envOverride = overrides.apiKeyEnv || null
  const configEnv = defaults.api_key_env || ""
  const explicitEnvCredential = envOverride ? String(process.env[envOverride] || "").trim() : ""
  const configEnvCredential = !envOverride && configEnv ? String(process.env[configEnv] || "").trim() : ""
  const authCredential = auth.readyState === "ready" ? auth.credential : ""
  const rawCredential = explicitEnvCredential || authCredential || defaults.api_key || configEnvCredential || ""
  const authProjection = await resolveProviderAuthProjection({
    providerId: providerType,
    resolvedType,
    credential: rawCredential,
    headers: {
      ...(defaults.headers || {}),
      ...(auth.headers || {})
    }
  })
  return {
    providerType: resolvedType,
    configKey: providerType,
    model: normalizedModel,
    baseUrl: overrides.baseUrl || authProjection.baseUrl || auth.baseUrlOverride || defaults.base_url,
    apiKeyEnv: envOverride || configEnv,
    apiKey: authProjection.apiKey,
    headers: authProjection.headers,
    authProfileId: auth.profile?.id || null,
    authReadyState: auth.readyState
  }
}

async function emitProviderFallbackEvent(payload) {
  await EventBus.emit({
    type: EVENT_TYPES.PROVIDER_FALLBACK,
    payload
  }).catch(() => {})
}

function normalizeModelId(model, { providerType, resolvedType, providerConfigType } = {}) {
  const raw = String(model || "").trim()
  if (!raw.includes("/")) return raw
  const [prefix, ...rest] = raw.split("/")
  if (!prefix || rest.length === 0) return raw
  const providerPrefixes = new Set(
    [providerType, resolvedType, providerConfigType]
      .filter(Boolean)
      .map((item) => String(item).trim().toLowerCase())
  )
  return providerPrefixes.has(prefix.toLowerCase()) ? rest.join("/") : raw
}

async function resolveProviderAuthProjection({ providerId, resolvedType, credential, headers = {} } = {}) {
  const providerKey = String(providerId || "").trim().toLowerCase()
  const providerRuntime = String(resolvedType || "").trim().toLowerCase()
  const rawCredential = String(credential || "").trim()
  const baseHeaders = { ...(headers || {}) }

  if (!rawCredential) {
    return { apiKey: "", headers: baseHeaders }
  }

  if (providerKey === "gemini" || providerRuntime === "gemini") {
    if (rawCredential.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawCredential)
        const token = String(parsed?.token || "").trim()
        const projectId = String(parsed?.projectId || "").trim()
        if (token) {
          return {
            apiKey: "",
            headers: {
              ...baseHeaders,
              Authorization: `Bearer ${token}`,
              ...(projectId ? { "x-goog-user-project": projectId } : {})
            }
          }
        }
      } catch {
        // Fall back to API-key style auth below.
      }
    }
    return {
      apiKey: "",
      headers: {
        ...baseHeaders,
        "x-goog-api-key": rawCredential
      }
    }
  }

  if (providerKey === "github-copilot") {
    const runtimeAuth = await resolveGitHubCopilotRuntimeAuth({ githubToken: rawCredential })
    return {
      apiKey: runtimeAuth.apiKey,
      baseUrl: runtimeAuth.baseUrl,
      headers: baseHeaders
    }
  }

  return {
    apiKey: rawCredential,
    headers: baseHeaders
  }
}

function classifyProviderFailure(error) {
  const cls = String(error?.errorClass || "").toLowerCase()
  if (["auth", "authentication"].includes(cls)) return "auth"
  if (["rate_limit"].includes(cls)) return "rate_limit"
  if (["context_overflow", "bad_response"].includes(cls)) return "bad_response"
  if (["server", "transient"].includes(cls)) return "bad_response"

  const status = Number(error?.status || error?.httpStatus || 0)
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status >= 400 && status < 500) return "bad_response"
  if (status >= 500) return "bad_response"

  const code = String(error?.code || "").toUpperCase()
  const msg = String(error?.message || "").toLowerCase()
  if (code === "ABORT_ERR" || msg.includes("timeout") || msg.includes("timed out")) return "timeout"
  if (code === "ETIMEDOUT" || code === "ECONNRESET") return "timeout"
  if (msg.includes("invalid json") || msg.includes("parse")) return "bad_response"
  return "unknown"
}

function normalizeProviderError(error, providerType, model) {
  const reason = classifyProviderFailure(error)
  if (error instanceof ProviderError) {
    error.reason = error.reason || reason
    error.details = {
      ...(error.details || {}),
      provider: providerType,
      model,
      reason: error.reason
    }
    return error
  }
  const wrapped = new ProviderError(error?.message || "provider request failed", {
    provider: providerType,
    model,
    reason
  })
  wrapped.reason = reason
  wrapped.cause = error
  return wrapped
}

// --- Non-streaming Request ---
export async function requestProvider({
  configState,
  providerType,
  model,
  system,
  messages,
  tools,
  baseUrl = null,
  apiKeyEnv = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const attempts = await createProviderAttemptChain({
    configState,
    providerType: resolvedProviderType,
    model,
    baseUrl,
    apiKeyEnv,
    system,
    messages,
    tools,
    stream: false,
    resolveSettings,
    getProvider
  })
  let lastError = null

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    const { settings, provider, input } = attempt
    if (!provider) {
      throw new Error(`unknown provider: ${settings.providerType}. registered: ${listProviders().join(", ")}`)
    }
    try {
      if (index > 0) {
        await emitProviderFallbackEvent({
          requested: resolvedProviderType,
          resolved: attempt.target.providerType,
          runtime: settings.providerType,
          model: settings.model,
          reason: lastError?.message || null
        })
      }
      return await provider.request(input)
    } catch (error) {
      lastError = normalizeProviderError(error, settings.providerType, settings.model)
    }
  }
  throw lastError || new ProviderError("provider request failed", { provider: resolvedProviderType, reason: "unknown" })
}

// --- Streaming Request ---
export async function* requestProviderStream({
  configState,
  providerType,
  model,
  system,
  messages,
  tools,
  baseUrl = null,
  apiKeyEnv = null,
  signal = null,
  compaction = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const attempts = await createProviderAttemptChain({
    configState,
    providerType: resolvedProviderType,
    model,
    baseUrl,
    apiKeyEnv,
    system,
    messages,
    tools,
    signal,
    compaction,
    stream: true,
    resolveSettings,
    getProvider
  })
  let lastError = null

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    const { settings, providerCfg, provider, input } = attempt

    if (providerCfg.stream === false) {
      try {
        if (index > 0) {
          await emitProviderFallbackEvent({
            requested: resolvedProviderType,
            resolved: attempt.target.providerType,
            runtime: settings.providerType,
            model: settings.model,
            reason: lastError?.message || null
          })
        }
        const result = await requestProvider({
          configState, providerType: attempt.target.providerType, model: attempt.target.model, system, messages, tools, baseUrl, apiKeyEnv
        })
        if (result.text) yield { type: "text", content: result.text }
        for (const call of result.toolCalls) yield { type: "tool_call", call }
        yield { type: "usage", usage: result.usage }
        return
      } catch (error) {
        lastError = normalizeProviderError(error, settings.providerType, settings.model)
        continue
      }
    }

    if (!provider) {
      throw new Error(`unknown provider: ${settings.providerType}. registered: ${listProviders().join(", ")}`)
    }

    let emitted = false
    try {
      if (index > 0) {
        await emitProviderFallbackEvent({
          requested: resolvedProviderType,
          resolved: attempt.target.providerType,
          runtime: settings.providerType,
          model: settings.model,
          reason: lastError?.message || null
        })
      }
      for await (const chunk of provider.requestStream(input)) {
        emitted = true
        yield chunk
      }
      return
    } catch (error) {
      lastError = normalizeProviderError(error, settings.providerType, settings.model)
      if (emitted || index === attempts.length - 1) throw lastError
    }
  }
  throw lastError || new ProviderError("provider request failed", { provider: resolvedProviderType, reason: "unknown" })
}

// --- Token Counting (Anthropic only, returns null for other providers) ---
export async function countTokensProvider({
  configState, providerType, model, system, messages, tools,
  baseUrl = null, apiKeyEnv = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const settings = await resolveSettings(configState, resolvedProviderType, { model, baseUrl, apiKeyEnv })
  const provider = registry.get(settings.providerType)
  if (!provider?.countTokens) return null
  return provider.countTokens({
    apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model,
    system, messages, tools, headers: settings.headers
  })
}
