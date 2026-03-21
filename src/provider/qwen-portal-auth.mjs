import { webcrypto } from "node:crypto"

const DEVICE_CODE_URL = "https://chat.qwen.ai/api/v1/oauth2/device/code"
const TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token"
const CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56"
const SCOPE = "openid profile email model.completion"
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

function randomVerifier() {
  return webcrypto.getRandomValues(new Uint8Array(32))
}

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(text)
  const digest = await webcrypto.subtle.digest("SHA-256", data)
  return toBase64Url(new Uint8Array(digest))
}

function buildForm(params) {
  return new URLSearchParams(params)
}

export async function requestQwenPortalDeviceCode() {
  const verifier = toBase64Url(randomVerifier())
  const challenge = await sha256Base64Url(verifier)
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: buildForm({
      client_id: CLIENT_ID,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256"
    })
  })
  if (!response.ok) {
    throw new Error(`Qwen Portal device auth failed: HTTP ${response.status}`)
  }
  const payload = await response.json()
  const deviceCode = String(payload?.device_code || "").trim()
  const verificationUri = String(payload?.verification_uri_complete || payload?.verification_uri || "").trim()
  if (!deviceCode || !verificationUri) {
    throw new Error("Qwen Portal device auth returned incomplete payload")
  }
  return {
    deviceCode,
    userCode: String(payload?.user_code || "").trim(),
    verificationUri,
    intervalMs: Math.max(2000, Number(payload?.interval || 2) * 1000),
    expiresAt: Date.now() + Math.max(60, Number(payload?.expires_in || 900)) * 1000,
    verifier
  }
}

export async function pollQwenPortalAccessToken({ deviceCode, verifier, intervalMs = 2000, expiresAt }) {
  const configuredIntervalMs = Number(intervalMs || 2000)
  let nextIntervalMs = Number.isFinite(configuredIntervalMs)
    ? Math.max(100, configuredIntervalMs)
    : 2000
  while (Date.now() < expiresAt) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: buildForm({
        grant_type: GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: deviceCode,
        code_verifier: verifier
      })
    })
    const payload = await response.json().catch(() => ({}))
    const accessToken = String(payload?.access_token || "").trim()
    if (response.ok && accessToken) {
      return {
        accessToken,
        refreshToken: String(payload?.refresh_token || "").trim(),
        expiresAt: Number(payload?.expires_in || 0) > 0 ? Date.now() + Number(payload.expires_in) * 1000 : null
      }
    }
    const error = String(payload?.error || "").trim()
    if (error === "authorization_pending") {
      await new Promise((resolve) => setTimeout(resolve, nextIntervalMs))
      continue
    }
    if (error === "slow_down") {
      nextIntervalMs = Math.min(10000, Math.round(nextIntervalMs * 1.5))
      await new Promise((resolve) => setTimeout(resolve, nextIntervalMs))
      continue
    }
    if (error === "access_denied") throw new Error("Qwen Portal login was denied")
    if (error === "expired_token") throw new Error("Qwen Portal device code expired")
    throw new Error(payload?.error_description || error || `Qwen Portal token polling failed: HTTP ${response.status}`)
  }
  throw new Error("Qwen Portal login timed out")
}

export async function refreshQwenPortalToken({ refreshToken }) {
  const rawRefreshToken = String(refreshToken || "").trim()
  if (!rawRefreshToken) throw new Error("Qwen Portal refresh token missing")
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: buildForm({
      grant_type: "refresh_token",
      refresh_token: rawRefreshToken,
      client_id: CLIENT_ID
    })
  })
  const payload = await response.json().catch(() => ({}))
  const accessToken = String(payload?.access_token || "").trim()
  if (!response.ok || !accessToken) {
    throw new Error(payload?.error_description || payload?.error || `Qwen Portal refresh failed: HTTP ${response.status}`)
  }
  return {
    accessToken,
    refreshToken: String(payload?.refresh_token || "").trim() || rawRefreshToken,
    expiresAt: Number(payload?.expires_in || 0) > 0 ? Date.now() + Number(payload.expires_in) * 1000 : null
  }
}
