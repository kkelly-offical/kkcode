import { ProviderError } from "../core/errors.mjs"
import { checkWorkspaceTrust } from "../permission/workspace-trust.mjs"

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)

function sourceProviderEntries(configState, providerName) {
  const source = configState?.source || {}
  const entries = []
  const projectEntry = source.projectRaw?.provider?.[providerName]
  if (projectEntry && typeof projectEntry === "object") {
    entries.push({ scope: "project config", entry: projectEntry })
  }
  const envEntry = source.envOverlay?.provider?.[providerName]
  // Old/synthetic ConfigState objects may not carry envScope. Treat a non-empty
  // overlay as project-controlled unless it is explicitly attributed to the
  // user-level ~/.kkcode/.env source.
  if (envEntry && typeof envEntry === "object" && source.envScope !== "user") {
    entries.push({ scope: "project .env", entry: envEntry })
  }
  return entries
}

function comparableUrl(value, relativeTo = null) {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    return relativeTo ? new URL(value, relativeTo) : new URL(value)
  } catch {
    return null
  }
}

function sameNetworkAuthority(left, right) {
  const a = comparableUrl(left)
  const b = comparableUrl(right)
  return Boolean(a && b && a.origin === b.origin)
}

function sourceEndpoint(entry, protocol, effectiveProvider) {
  const endpoint = entry.endpoints?.[protocol]
  if (typeof endpoint !== "string" || !endpoint.trim()) return null
  const base = entry.base_url || effectiveProvider?.base_url
  return comparableUrl(endpoint, base ? `${String(base).replace(/\/+$/, "")}/` : null)?.toString() || endpoint
}

function baseFieldIsEffective(entry, protocol, effectiveProvider, baseUrlOverride) {
  const candidates = [
    own(entry, "base_url") ? entry.base_url : null,
    sourceEndpoint(entry, protocol, effectiveProvider)
  ].filter(Boolean)
  if (!candidates.length) return []
  if (!baseUrlOverride) return candidates
  return candidates.filter((candidate) =>
    String(candidate).replace(/\/+$/, "") === String(baseUrlOverride).replace(/\/+$/, "") ||
    sameNetworkAuthority(candidate, baseUrlOverride)
  )
}

function credentialEnvIsEffective(entry, apiKeyEnvOverride) {
  if (!own(entry, "api_key_env")) return false
  if (!apiKeyEnvOverride) return true
  return String(entry.api_key_env || "") === String(apiKeyEnvOverride || "")
}

export function projectProviderControlReasons(configState, {
  providerName,
  protocol,
  operation = "inference",
  baseUrlOverride = null,
  apiKeyEnvOverride = null
}) {
  const effectiveProvider = configState?.config?.provider?.[providerName] || {}
  const reasons = []
  for (const { scope, entry } of sourceProviderEntries(configState, providerName)) {
    if (own(entry, "type")) reasons.push(`${scope}: provider.${providerName}.type`)
    if (own(entry, "protocol")) reasons.push(`${scope}: provider.${providerName}.protocol`)
    if (own(entry, "api_key")) reasons.push(`${scope}: provider.${providerName}.api_key`)
    if (credentialEnvIsEffective(entry, apiKeyEnvOverride)) {
      reasons.push(`${scope}: provider.${providerName}.api_key_env`)
    }
    if (baseFieldIsEffective(entry, protocol, effectiveProvider, baseUrlOverride).length) {
      if (own(entry, "base_url")) reasons.push(`${scope}: provider.${providerName}.base_url`)
      if (own(entry.endpoints, protocol)) {
        reasons.push(`${scope}: provider.${providerName}.endpoints.${protocol}`)
      }
    }
    if (operation === "model discovery" && own(entry.endpoints, "models")) {
      reasons.push(`${scope}: provider.${providerName}.endpoints.models`)
    }
  }
  return [...new Set(reasons)]
}

function workspaceCwd(configState) {
  return configState?.source?.cwd || process.cwd()
}

export async function assertProviderOutboundAllowed(configState, options) {
  const reasons = projectProviderControlReasons(configState, options)
  if (!reasons.length) return
  const cwd = workspaceCwd(configState)
  const trust = await checkWorkspaceTrust({ cwd, isTTY: false })
  if (trust.trusted) return
  const operation = options.operation || "provider request"
  throw new ProviderError(
    `refusing ${operation}: this untrusted workspace controls the provider endpoint or credential source (${reasons.join(", ")}). ` +
    "Review the project configuration, then run `kkcode --trust` in this workspace or use `/trust` before retrying.",
    {
      provider: options.providerName,
      reason: "workspace_untrusted",
      operation,
      fields: reasons
    }
  )
}

function urlCarriesCredential(url) {
  if (url.username || url.password) return true
  for (const key of url.searchParams.keys()) {
    if (/(?:api[_-]?key|token|secret|password|authorization|credential)/i.test(key)) return true
  }
  return false
}

export function assertCredentialTransport({ baseUrl, apiKey = "", providerName, operation = "provider request" }) {
  let url
  try {
    url = new URL(String(baseUrl || ""))
  } catch {
    return
  }
  if (url.protocol !== "http:" || (!apiKey && !urlCarriesCredential(url))) return
  throw new ProviderError(
    `refusing ${operation} for provider "${providerName}" because credentials would be sent over plain HTTP. ` +
    "Use an HTTPS Base URL or remove the credential for an authless local endpoint.",
    {
      provider: providerName,
      reason: "insecure_transport",
      operation,
      origin: url.origin
    }
  )
}
