export function parseProviderTarget(rawValue, defaultProviderType) {
  const raw = String(rawValue || "").trim()
  if (!raw) return null
  const split = raw.split("::", 2)
  if (split.length === 2 && split[0].trim() && split[1].trim()) {
    return { providerType: split[0].trim(), model: split[1].trim() }
  }
  return {
    providerType: defaultProviderType,
    model: raw
  }
}

export function resolveProviderAttemptTargets(configState, providerType, model) {
  const llm = configState?.config?.provider || {}
  const defaults = llm[providerType] || {}
  const primaryModel = String(model || defaults.default_model || "").trim()
  const targets = []
  if (primaryModel) {
    targets.push({ providerType, model: primaryModel, source: "primary" })
  }
  for (const fallback of Array.isArray(defaults.fallback_models) ? defaults.fallback_models : []) {
    const parsed = parseProviderTarget(fallback, providerType)
    if (!parsed) continue
    targets.push({ ...parsed, source: "fallback" })
  }
  const deduped = []
  const seen = new Set()
  for (const target of targets) {
    const key = `${target.providerType}::${target.model}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(target)
  }
  return deduped
}

export async function createProviderAttemptChain({
  configState,
  providerType,
  model,
  baseUrl = null,
  apiKeyEnv = null,
  system,
  messages,
  tools,
  signal = null,
  compaction = null,
  stream = false,
  resolveSettings,
  getProvider
}) {
  const attempts = resolveProviderAttemptTargets(configState, providerType, model)
  const hasFallbackChain = attempts.length > 1

  return Promise.all(attempts.map(async (attempt, index) => {
    const settings = await resolveSettings(configState, attempt.providerType, {
      model: attempt.model,
      baseUrl,
      apiKeyEnv
    })
    const providerCfg = configState.config.provider[settings.configKey] || configState.config.provider[settings.providerType] || {}
    const retryAttempts = (hasFallbackChain && index < attempts.length - 1)
      ? 1
      : Number(providerCfg.retry_attempts || 3)
    const input = {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      apiKeyEnv: settings.apiKeyEnv,
      model: settings.model,
      system,
      messages,
      tools,
      timeoutMs: Number(providerCfg.timeout_ms || 120000),
      maxTokens: Number(providerCfg.max_tokens || 16384),
      headers: settings.headers,
      retry: {
        attempts: retryAttempts,
        baseDelayMs: Number(providerCfg.retry_base_delay_ms || 800)
      },
      thinking: providerCfg.thinking || null,
      ...(stream ? {
        streamIdleTimeoutMs: Number(providerCfg.stream_idle_timeout_ms || 120000),
        signal,
        compaction
      } : {})
    }

    return {
      index,
      target: attempt,
      settings,
      providerCfg,
      provider: getProvider(settings.providerType),
      input
    }
  }))
}
