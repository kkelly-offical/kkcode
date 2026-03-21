const GLOBAL_BASE = "https://api.minimax.io"
const CN_BASE = "https://api.minimaxi.com"
const CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113"
const SCOPE = "group_id profile model.completion"
const USER_CODE_GRANT = "urn:ietf:params:oauth:grant-type:user_code"

function resolveBaseUrl(region = "global") {
  return region === "cn" ? CN_BASE : GLOBAL_BASE
}

function randomVerifier() {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(32)))
    .toString("base64url")
}

async function sha256Base64Url(text) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Buffer.from(digest).toString("base64url")
}

function buildBody(params) {
  return new URLSearchParams(params)
}

export async function requestMiniMaxPortalCode({ region = "global", fetchImpl = fetch, stateOverride = null } = {}) {
  const verifier = randomVerifier()
  const challenge = await sha256Base64Url(verifier)
  const state = stateOverride || Math.random().toString(36).slice(2, 14)
  const baseUrl = resolveBaseUrl(region)
  const response = await fetchImpl(`${baseUrl}/oauth/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-request-id": randomUUID()
    },
    body: buildBody({
      response_type: "code",
      client_id: CLIENT_ID,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state
    })
  })
  if (!response.ok) {
    throw new Error(`MiniMax portal authorization failed: HTTP ${response.status}`)
  }
  const payload = await response.json().catch(() => ({}))
  if (!payload?.user_code || !payload?.verification_uri || payload?.state !== state) {
    throw new Error("MiniMax portal authorization returned invalid payload")
  }
  return {
    region,
    verifier,
    userCode: String(payload.user_code).trim(),
    verificationUri: String(payload.verification_uri).trim(),
    expiresAt: Date.now() + Math.max(60, Number(payload.expired_in || 900)) * 1000
  }
}

export async function pollMiniMaxPortalAccessToken({ region = "global", userCode, verifier, expiresAt, fetchImpl = fetch }) {
  const baseUrl = resolveBaseUrl(region)
  while (Date.now() < expiresAt) {
    const response = await fetchImpl(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: buildBody({
        grant_type: USER_CODE_GRANT,
        client_id: CLIENT_ID,
        user_code: userCode,
        code_verifier: verifier
      })
    })
    const payload = await response.json().catch(() => ({}))
    if (response.ok && payload?.status === "success" && payload?.access_token) {
      return {
        accessToken: String(payload.access_token).trim(),
        refreshToken: String(payload.refresh_token || "").trim(),
        expiresAt: Number(payload.expired_in || 0) > 0 ? Date.now() + Number(payload.expired_in) * 1000 : null,
        baseUrl: String(payload.resource_url || "").trim() || `${baseUrl}/anthropic`
      }
    }
    if (response.ok) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      continue
    }
    throw new Error(payload?.base_resp?.status_msg || "MiniMax portal login failed")
  }
  throw new Error("MiniMax portal login timed out")
}

export async function refreshMiniMaxPortalToken({ refreshToken, region = "global", fetchImpl = fetch } = {}) {
  const rawRefreshToken = String(refreshToken || "").trim()
  if (!rawRefreshToken) throw new Error("MiniMax portal refresh token missing")
  const baseUrl = resolveBaseUrl(region)
  const response = await fetchImpl(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: buildBody({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: rawRefreshToken
    })
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.base_resp?.status_msg || payload?.error || `MiniMax portal refresh failed: HTTP ${response.status}`)
  }
  return {
    accessToken: String(payload.access_token).trim(),
    refreshToken: String(payload.refresh_token || "").trim() || rawRefreshToken,
    expiresAt: Number(payload.expired_in || 0) > 0 ? Date.now() + Number(payload.expired_in) * 1000 : null,
    baseUrl: String(payload.resource_url || "").trim() || `${baseUrl}/anthropic`
  }
}
import { randomUUID, webcrypto } from "node:crypto"
