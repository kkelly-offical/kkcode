import path from "node:path"
import { randomUUID, webcrypto } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { getProviderSpec } from "./catalog.mjs"
import { readJson, writeJson } from "../storage/json-store.mjs"
import { userRootDir } from "../storage/paths.mjs"

function pendingPath() {
  return path.join(userRootDir(), "oauth", "pending.json")
}

async function ensurePendingDir() {
  await mkdir(path.dirname(pendingPath()), { recursive: true })
}

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function randomVerifier() {
  return toBase64Url(webcrypto.getRandomValues(new Uint8Array(32)))
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(text)
  const digest = await webcrypto.subtle.digest("SHA-256", data)
  return toBase64Url(new Uint8Array(digest))
}

function parseFragmentParams(hash = "") {
  const raw = String(hash || "").replace(/^#/, "")
  return new URLSearchParams(raw)
}

function buildAuthorizeUrl(url, {
  providerId,
  state,
  redirectUri,
  clientId,
  scopes = [],
  codeChallenge = null
}) {
  const uri = new URL(url)
  uri.searchParams.set("provider", providerId)
  uri.searchParams.set("redirect_uri", redirectUri)
  uri.searchParams.set("state", state)
  if (clientId && !uri.searchParams.get("client_id")) uri.searchParams.set("client_id", clientId)
  if (codeChallenge) {
    uri.searchParams.set("response_type", "code")
    uri.searchParams.set("code_challenge_method", "S256")
    uri.searchParams.set("code_challenge", codeChallenge)
  }
  if (scopes.length && !uri.searchParams.get("scope")) uri.searchParams.set("scope", scopes.join(" "))
  return uri.toString()
}

export async function loadPendingOAuthSession() {
  return readJson(pendingPath(), null)
}

export async function clearPendingOAuthSession() {
  await ensurePendingDir()
  await writeJson(pendingPath(), null)
}

export async function beginProviderOAuth({
  providerId,
  authUrl = "",
  clientId = "",
  tokenUrl = "",
  scopes = [],
  redirectUri = "kkcode://oauth"
}) {
  const spec = getProviderSpec(providerId)
  const authorizeUrl = String(authUrl || spec?.oauth_authorize_url || spec?.auth_docs_url || "").trim()
  if (!authorizeUrl) {
    throw new Error(`OAuth authorize URL is not configured for provider: ${providerId}`)
  }
  const state = `oauth_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  const resolvedClientId = String(clientId || spec?.oauth_client_id || "").trim()
  const resolvedTokenUrl = String(tokenUrl || spec?.oauth_token_url || "").trim()
  const resolvedScopes = Array.isArray(scopes) && scopes.length ? scopes : (spec?.oauth_scopes || [])
  const codeVerifier = resolvedTokenUrl && resolvedClientId ? randomVerifier() : null
  const codeChallenge = codeVerifier ? await sha256Base64Url(codeVerifier) : null
  const launchUrl = buildAuthorizeUrl(authorizeUrl, {
    providerId,
    state,
    redirectUri,
    clientId: resolvedClientId || null,
    scopes: resolvedScopes,
    codeChallenge
  })
  const pending = {
    providerId,
    state,
    authUrl: launchUrl,
    redirectUri,
    tokenUrl: resolvedTokenUrl || null,
    clientId: resolvedClientId || null,
    codeVerifier,
    startedAt: Date.now()
  }
  await ensurePendingDir()
  await writeJson(pendingPath(), pending)
  return pending
}

async function exchangeCodeForToken({
  tokenUrl,
  clientId,
  code,
  redirectUri,
  codeVerifier,
  fetchImpl = fetch
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  })
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  })
  const payload = await response.json().catch(() => ({}))
  const accessToken = String(payload?.access_token || "").trim()
  if (!response.ok || !accessToken) {
    throw new Error(payload?.error_description || payload?.error || `OAuth token exchange failed: HTTP ${response.status}`)
  }
  return {
    accessToken,
    refreshToken: String(payload?.refresh_token || "").trim(),
    expiresAt: Number(payload?.expires_at || 0) > 0
      ? Number(payload.expires_at)
      : Number(payload?.expires_in || 0) > 0
        ? Date.now() + Number(payload.expires_in) * 1000
        : null
  }
}

export async function importProviderOAuthCallback({
  providerId,
  callbackUrl,
  fetchImpl = fetch
}) {
  const pending = await loadPendingOAuthSession()
  const uri = new URL(callbackUrl)
  const fragment = parseFragmentParams(uri.hash)
  if (pending?.providerId === providerId) {
    const returnedState = uri.searchParams.get("state") || fragment.get("state")
    if (returnedState && returnedState !== pending.state) {
      throw new Error("OAuth state mismatch. Please retry login.")
    }
  }
  let accessToken = uri.searchParams.get("access_token")
    || uri.searchParams.get("token")
    || uri.searchParams.get("api_key")
    || fragment.get("access_token")
    || fragment.get("token")
    || fragment.get("api_key")
  let refreshToken = uri.searchParams.get("refresh_token") || fragment.get("refresh_token") || ""
  let expiresAt = Number(uri.searchParams.get("expires_at") || fragment.get("expires_at") || 0) || null
  if (!expiresAt) {
    const expiresIn = Number(uri.searchParams.get("expires_in") || fragment.get("expires_in") || 0)
    if (expiresIn > 0) expiresAt = Date.now() + expiresIn * 1000
  }
  if (!accessToken) {
    const code = uri.searchParams.get("code") || fragment.get("code")
    if (code && pending?.tokenUrl && pending?.clientId && pending?.codeVerifier) {
      const exchanged = await exchangeCodeForToken({
        tokenUrl: pending.tokenUrl,
        clientId: pending.clientId,
        code,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier,
        fetchImpl
      })
      accessToken = exchanged.accessToken
      refreshToken = exchanged.refreshToken || refreshToken
      expiresAt = exchanged.expiresAt || expiresAt
    } else if (code) {
      throw new Error("Received authorization code, but this provider is missing token exchange configuration")
    }
  }
  if (!accessToken) {
    throw new Error("OAuth callback did not contain a usable token")
  }
  return {
    accessToken,
    refreshToken,
    expiresAt
  }
}
