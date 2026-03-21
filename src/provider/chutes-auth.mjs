const CHUTES_OAUTH_ISSUER = "https://api.chutes.ai"

export const CHUTES_AUTHORIZE_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/authorize`
export const CHUTES_TOKEN_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/token`
export const CHUTES_DEFAULT_SCOPES = ["openid", "profile", "chutes:invoke"]

export async function refreshChutesToken({
  refreshToken,
  clientId = process.env.CHUTES_CLIENT_ID,
  clientSecret = process.env.CHUTES_CLIENT_SECRET,
  fetchImpl = fetch
} = {}) {
  const refresh = String(refreshToken || "").trim()
  const resolvedClientId = String(clientId || "").trim()
  const resolvedClientSecret = String(clientSecret || "").trim()
  if (!refresh) {
    throw new Error("Chutes OAuth credential is missing refresh token")
  }
  if (!resolvedClientId) {
    throw new Error("Missing CHUTES_CLIENT_ID for Chutes OAuth refresh")
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: resolvedClientId,
    refresh_token: refresh
  })
  if (resolvedClientSecret) {
    body.set("client_secret", resolvedClientSecret)
  }
  const response = await fetchImpl(CHUTES_TOKEN_ENDPOINT, {
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
    throw new Error(payload?.error_description || payload?.error || `Chutes token refresh failed: HTTP ${response.status}`)
  }
  const refreshTokenNext = String(payload?.refresh_token || "").trim() || refresh
  const expiresAt = Number(payload?.expires_at || 0) > 0
    ? Number(payload.expires_at)
    : Number(payload?.expires_in || 0) > 0
      ? Date.now() + Number(payload.expires_in) * 1000
      : null
  return {
    accessToken,
    refreshToken: refreshTokenNext,
    expiresAt
  }
}
