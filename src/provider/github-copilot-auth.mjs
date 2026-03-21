import path from "node:path"
import { mkdir } from "node:fs/promises"
import { readJson, writeJson } from "../storage/json-store.mjs"
import { userRootDir } from "../storage/paths.mjs"

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
const DEVICE_CODE_URL = "https://github.com/login/device/code"
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com"

function cachePath() {
  return path.join(userRootDir(), "provider-token-cache", "github-copilot.json")
}

function isTokenUsable(cache, now = Date.now()) {
  return Number(cache?.expiresAt || 0) - now > 5 * 60 * 1000
}

export function deriveCopilotApiBaseUrlFromToken(token = "") {
  const trimmed = String(token || "").trim()
  if (!trimmed) return null
  const match = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)
  const proxyEp = match?.[1]?.trim()
  if (!proxyEp) return null
  const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.")
  if (!host) return null
  return `https://${host}`
}

async function ensureCacheDir() {
  await mkdir(path.dirname(cachePath()), { recursive: true })
}

function parseCopilotTokenResponse(value) {
  if (!value || typeof value !== "object") {
    throw new Error("unexpected response from GitHub Copilot token endpoint")
  }
  const token = String(value.token || "").trim()
  const expiresAtRaw = value.expires_at
  if (!token) throw new Error("copilot token response missing token")
  let expiresAtMs = 0
  if (typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw)) {
    expiresAtMs = expiresAtRaw > 10_000_000_000 ? expiresAtRaw : expiresAtRaw * 1000
  } else if (typeof expiresAtRaw === "string" && expiresAtRaw.trim()) {
    const parsed = Number.parseInt(expiresAtRaw, 10)
    if (!Number.isFinite(parsed)) throw new Error("copilot token response has invalid expires_at")
    expiresAtMs = parsed > 10_000_000_000 ? parsed : parsed * 1000
  } else {
    throw new Error("copilot token response missing expires_at")
  }
  return { token, expiresAt: expiresAtMs }
}

export async function resolveGitHubCopilotRuntimeAuth({ githubToken, fetchImpl = fetch } = {}) {
  const rawToken = String(githubToken || "").trim()
  if (!rawToken) {
    throw new Error("missing GitHub token for github-copilot provider")
  }

  const cached = await readJson(cachePath(), null)
  if (cached && isTokenUsable(cached)) {
    return {
      apiKey: cached.token,
      baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) || DEFAULT_COPILOT_API_BASE_URL
    }
  }

  const response = await fetchImpl(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${rawToken}`
    }
  })

  if (!response.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${response.status}`)
  }

  const parsed = parseCopilotTokenResponse(await response.json())
  await ensureCacheDir()
  await writeJson(cachePath(), {
    token: parsed.token,
    expiresAt: parsed.expiresAt,
    updatedAt: Date.now()
  })

  return {
    apiKey: parsed.token,
    baseUrl: deriveCopilotApiBaseUrlFromToken(parsed.token) || DEFAULT_COPILOT_API_BASE_URL
  }
}

export async function requestGitHubDeviceCode({ scope = "read:user" } = {}) {
  const body = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    scope
  })
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  })
  if (!response.ok) {
    throw new Error(`GitHub device code failed: HTTP ${response.status}`)
  }
  const json = await response.json()
  if (!json?.device_code || !json?.user_code || !json?.verification_uri) {
    throw new Error("GitHub device code response missing fields")
  }
  return json
}

export async function pollGitHubAccessToken({ deviceCode, intervalMs, expiresAt }) {
  const body = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code"
  })

  while (Date.now() < expiresAt) {
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    })
    if (!response.ok) {
      throw new Error(`GitHub device token failed: HTTP ${response.status}`)
    }
    const json = await response.json()
    if (typeof json?.access_token === "string" && json.access_token.trim()) {
      return json.access_token.trim()
    }
    const err = String(json?.error || "unknown")
    if (err === "authorization_pending") {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      continue
    }
    if (err === "slow_down") {
      await new Promise((resolve) => setTimeout(resolve, intervalMs + 2000))
      continue
    }
    if (err === "expired_token") throw new Error("GitHub device code expired; run login again")
    if (err === "access_denied") throw new Error("GitHub login cancelled")
    throw new Error(`GitHub device flow error: ${err}`)
  }

  throw new Error("GitHub device code expired; run login again")
}

export async function loginGitHubCopilot() {
  if (!process.stdin.isTTY) {
    throw new Error("github-copilot login requires an interactive TTY")
  }
  const device = await requestGitHubDeviceCode({ scope: "read:user" })
  return {
    verificationUri: device.verification_uri,
    userCode: device.user_code,
    accessToken: await pollGitHubAccessToken({
      deviceCode: device.device_code,
      intervalMs: Math.max(1000, Number(device.interval || 5) * 1000),
      expiresAt: Date.now() + Number(device.expires_in || 900) * 1000
    })
  }
}
