import { randomUUID } from "node:crypto"
import { authProfileStorePath, ensureUserRoot } from "../storage/paths.mjs"
import { readJson, writeJson } from "../storage/json-store.mjs"

const STORE_VERSION = 1
const VALID_AUTH_MODES = new Set(["api_key", "token", "oauth"])

function generateProfileId() {
  return `auth_${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {}
  const next = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && key) next[key] = value
  }
  return next
}

function normalizeProfile(raw = {}) {
  const authMode = VALID_AUTH_MODES.has(raw.authMode) ? raw.authMode : "api_key"
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : generateProfileId(),
    providerId: String(raw.providerId || "").trim(),
    displayName: String(raw.displayName || raw.name || "").trim() || "Unnamed Profile",
    authMode,
    credential: String(raw.credential || "").trim(),
    credentialEnv: String(raw.credentialEnv || "").trim(),
    accessToken: String(raw.accessToken || "").trim(),
    refreshToken: String(raw.refreshToken || "").trim(),
    baseUrlOverride: String(raw.baseUrlOverride || "").trim(),
    headers: normalizeHeaders(raw.headers),
    expiresAt: Number.isFinite(Number(raw.expiresAt)) ? Number(raw.expiresAt) : null,
    isDefault: raw.isDefault === true,
    status: String(raw.status || "unknown").trim() || "unknown",
    lastVerifiedAt: Number.isFinite(Number(raw.lastVerifiedAt)) ? Number(raw.lastVerifiedAt) : null
  }
}

function normalizeStore(raw) {
  const store = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  const profiles = Array.isArray(store.profiles) ? store.profiles.map(normalizeProfile) : []
  return {
    version: STORE_VERSION,
    profiles
  }
}

function profileSort(a, b) {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
  return a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" })
}

export async function loadAuthProfileStore() {
  const store = await readJson(authProfileStorePath(), null)
  return normalizeStore(store)
}

export async function saveAuthProfileStore(store) {
  await ensureUserRoot()
  const normalized = normalizeStore(store)
  await writeJson(authProfileStorePath(), normalized)
  return normalized
}

export async function listAuthProfiles({ providerId = null } = {}) {
  const store = await loadAuthProfileStore()
  const profiles = providerId
    ? store.profiles.filter((profile) => profile.providerId === providerId)
    : store.profiles
  return profiles.sort(profileSort)
}

export async function getAuthProfile(profileId) {
  if (!profileId) return null
  const store = await loadAuthProfileStore()
  return store.profiles.find((profile) => profile.id === profileId) || null
}

export function resolveAuthProfileCredential(profile, env = process.env) {
  if (!profile) return ""
  if (profile.authMode === "oauth" && profile.accessToken) return profile.accessToken
  if (profile.credential) return profile.credential
  if (profile.credentialEnv) return String(env[profile.credentialEnv] || "").trim()
  return ""
}

export function resolveAuthProfileStatus(profile, env = process.env) {
  if (!profile) return "missing"
  if (profile.expiresAt && profile.expiresAt < Date.now()) return "expired"
  if (!resolveAuthProfileCredential(profile, env)) return "missing_credential"
  return "ready"
}

export async function upsertAuthProfile(input) {
  const next = normalizeProfile(input)
  if (!next.providerId) {
    throw new Error("auth profile providerId is required")
  }
  const store = await loadAuthProfileStore()
  const existing = store.profiles.filter((profile) => profile.id !== next.id)
  const sameProvider = existing.filter((profile) => profile.providerId === next.providerId)
  const shouldBeDefault = next.isDefault || sameProvider.length === 0
  const profiles = existing.map((profile) => {
    if (profile.providerId !== next.providerId) return profile
    if (!shouldBeDefault) return profile
    return { ...profile, isDefault: false }
  })
  profiles.push({
    ...next,
    isDefault: shouldBeDefault,
    status: resolveAuthProfileStatus(next)
  })
  await saveAuthProfileStore({ version: STORE_VERSION, profiles })
  return next.id
}

export async function removeAuthProfile(profileId) {
  const store = await loadAuthProfileStore()
  const target = store.profiles.find((profile) => profile.id === profileId)
  if (!target) return false
  let profiles = store.profiles.filter((profile) => profile.id !== profileId)
  const providerProfiles = profiles.filter((profile) => profile.providerId === target.providerId)
  if (target.isDefault && providerProfiles.length > 0 && !providerProfiles.some((profile) => profile.isDefault)) {
    const [first] = providerProfiles.sort(profileSort)
    profiles = profiles.map((profile) => profile.id === first.id ? { ...profile, isDefault: true } : profile)
  }
  await saveAuthProfileStore({ version: STORE_VERSION, profiles })
  return true
}

export async function setDefaultAuthProfile(providerId, profileId) {
  const store = await loadAuthProfileStore()
  let found = false
  const profiles = store.profiles.map((profile) => {
    if (profile.providerId !== providerId) return profile
    if (profile.id === profileId) {
      found = true
      return { ...profile, isDefault: true }
    }
    return { ...profile, isDefault: false }
  })
  if (!found) return false
  await saveAuthProfileStore({ version: STORE_VERSION, profiles })
  return true
}

export async function resolveProviderAuthProfile({
  providerId,
  explicitProfileId = null,
  env = process.env
}) {
  const store = await loadAuthProfileStore()
  let profile = null
  if (explicitProfileId) {
    profile = store.profiles.find((item) => item.id === explicitProfileId) || null
    if (profile && providerId && profile.providerId !== providerId) {
      profile = null
    }
  }
  if (!profile && providerId) {
    const sameProvider = store.profiles.filter((item) => item.providerId === providerId).sort(profileSort)
    profile = sameProvider.find((item) => item.isDefault) || sameProvider[0] || null
  }
  return {
    profile,
    credential: resolveAuthProfileCredential(profile, env),
    headers: profile?.headers || {},
    baseUrlOverride: profile?.baseUrlOverride || null,
    readyState: resolveAuthProfileStatus(profile, env)
  }
}
