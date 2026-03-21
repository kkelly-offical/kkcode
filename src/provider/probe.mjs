import { getProviderSpec } from "./catalog.mjs"
import { resolveProviderAuthProfile } from "./auth-profiles.mjs"
import { resolveProviderAttemptTargets } from "./runtime-factory.mjs"

const OAUTH_REFRESH_PROVIDERS = new Set(["qwen-portal", "minimax-portal", "chutes"])
const SUPPORTED_RUNTIME_TYPES = new Set(["openai", "anthropic", "openai-compatible", "ollama"])

function interactiveLoginSupportedFor(providerId, spec) {
  if (providerId === "github-copilot") return true
  if (providerId === "anthropic") return false
  if (!spec?.supports_oauth) return false
  if (spec.oauth_flow === "device_code") return true
  return spec.supports_oauth === true
}

function credentialSourceFor(profile, targetDefaults, env = process.env) {
  if (profile?.authMode === "oauth" && profile?.accessToken) return "auth_profile:oauth"
  if (profile?.credential) return "auth_profile:stored"
  if (profile?.credentialEnv && env[profile.credentialEnv]) return `auth_profile_env:${profile.credentialEnv}`
  if (targetDefaults?.api_key) return "config:api_key"
  if (targetDefaults?.api_key_env && env[targetDefaults.api_key_env]) return `env:${targetDefaults.api_key_env}`
  return "missing"
}

function providerNeedsCredential(spec, targetDefaults, providerId) {
  const type = String(targetDefaults?.type || spec?.type || providerId || "").trim().toLowerCase()
  return type !== "ollama"
}

async function inspectAttempt(configState, attempt, env = process.env) {
  const spec = getProviderSpec(attempt.providerType)
  const targetDefaults = configState?.config?.provider?.[attempt.providerType] || {}
  const auth = await resolveProviderAuthProfile({
    providerId: attempt.providerType,
    explicitProfileId: targetDefaults.auth_profile || null,
    env
  })
  return {
    providerId: attempt.providerType,
    label: spec?.label || attempt.providerType,
    source: attempt.source || "primary",
    model: attempt.model,
    configured: Boolean(spec) || Boolean(configState?.config?.provider?.[attempt.providerType]),
    runtimeType: targetDefaults.type || spec?.type || attempt.providerType,
    baseUrl: auth.baseUrlOverride || targetDefaults.base_url || spec?.base_url || "",
    authProfileId: auth.profile?.id || null,
    authProfileMode: auth.profile?.authMode || null,
    authReadyState: auth.readyState,
    credentialSource: credentialSourceFor(auth.profile, targetDefaults, env)
  }
}

export async function buildProviderProbeReport({
  configState,
  providerId,
  model = null,
  env = process.env
}) {
  const config = configState?.config || {}
  const providerDefaults = config.provider?.[providerId] || {}
  const spec = getProviderSpec(providerId)
  const effectiveModel = String(model || providerDefaults.default_model || spec?.default_model || "").trim()
  const auth = await resolveProviderAuthProfile({
    providerId,
    explicitProfileId: providerDefaults.auth_profile || null,
    env
  })
  const attempts = await Promise.all(
    resolveProviderAttemptTargets(configState, providerId, effectiveModel).map((attempt) => inspectAttempt(configState, attempt, env))
  )

  const warnings = []
  const interactiveLoginSupported = interactiveLoginSupportedFor(providerId, spec)
  const runtimeType = providerDefaults.type || spec?.type || providerId
  const runtimeAvailable = SUPPORTED_RUNTIME_TYPES.has(String(runtimeType || "").trim())
  if (!spec && !config.provider?.[providerId]) {
    warnings.push(`provider "${providerId}" is not defined in config or provider catalog`)
  }
  if (!runtimeAvailable) {
    warnings.push(`provider "${providerId}" maps to runtime "${runtimeType}", but that runtime is not implemented in kkcode yet`)
  }
  if (providerNeedsCredential(spec, providerDefaults, providerId) && credentialSourceFor(auth.profile, providerDefaults, env) === "missing") {
    warnings.push(`provider "${providerId}" has no ready credential source`)
  }
  if (auth.readyState === "expired" && !OAUTH_REFRESH_PROVIDERS.has(providerId)) {
    warnings.push(`oauth profile is expired and automatic refresh is not implemented for provider "${providerId}"`)
  }
  if (spec?.supports_oauth === true && !interactiveLoginSupported) {
    warnings.push(`provider "${providerId}" supports oauth-compatible credentials, but built-in interactive login is not implemented`)
  }
  for (const attempt of attempts) {
    if (!attempt.configured) {
      warnings.push(`fallback target "${attempt.providerId}::${attempt.model}" is not configured locally`)
    }
    if (providerNeedsCredential(getProviderSpec(attempt.providerId), config.provider?.[attempt.providerId], attempt.providerId) && attempt.credentialSource === "missing") {
      warnings.push(`attempt target "${attempt.providerId}::${attempt.model}" has no ready credential source`)
    }
  }

  return {
    providerId,
    label: spec?.label || providerId,
    configured: Boolean(spec) || Boolean(config.provider?.[providerId]),
    runtimeType,
    runtimeAvailable,
    model: effectiveModel,
    baseUrl: auth.baseUrlOverride || providerDefaults.base_url || spec?.base_url || "",
    authModes: spec?.auth_modes || ["api_key"],
    supportsOAuth: spec?.supports_oauth === true,
    auth: {
      profileId: auth.profile?.id || null,
      displayName: auth.profile?.displayName || null,
      mode: auth.profile?.authMode || null,
      readyState: auth.readyState,
      credentialSource: credentialSourceFor(auth.profile, providerDefaults, env),
      interactiveLoginSupported,
      refreshSupported: OAUTH_REFRESH_PROVIDERS.has(providerId),
      expiresAt: auth.profile?.expiresAt || null
    },
    attempts,
    warnings
  }
}
