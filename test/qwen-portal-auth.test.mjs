import test from "node:test"
import assert from "node:assert/strict"
import { pollQwenPortalAccessToken, refreshQwenPortalToken, requestQwenPortalDeviceCode } from "../src/provider/qwen-portal-auth.mjs"

test("requestQwenPortalDeviceCode returns verifier and normalized fields", async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      device_code: "dev_123",
      user_code: "USER-CODE",
      verification_uri_complete: "https://chat.qwen.ai/verify?code=USER-CODE",
      interval: 2,
      expires_in: 900
    })
  })

  try {
    const result = await requestQwenPortalDeviceCode()
    assert.equal(result.deviceCode, "dev_123")
    assert.equal(result.userCode, "USER-CODE")
    assert.equal(result.verificationUri.includes("chat.qwen.ai/verify"), true)
    assert.equal(typeof result.verifier, "string")
    assert.equal(result.verifier.length > 20, true)
  } finally {
    global.fetch = originalFetch
  }
})

test("pollQwenPortalAccessToken handles pending state and returns token set", async () => {
  const originalFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return {
        ok: true,
        json: async () => ({ error: "authorization_pending" })
      }
    }
    return {
      ok: true,
      json: async () => ({
        access_token: "qwen-access",
        refresh_token: "qwen-refresh",
        expires_in: 3600
      })
    }
  }

  try {
    const tokenSet = await pollQwenPortalAccessToken({
      deviceCode: "dev_123",
      verifier: "verifier_123",
      intervalMs: 1,
      expiresAt: Date.now() + 1000
    })
    assert.equal(tokenSet.accessToken, "qwen-access")
    assert.equal(tokenSet.refreshToken, "qwen-refresh")
    assert.equal(tokenSet.expiresAt > Date.now(), true)
  } finally {
    global.fetch = originalFetch
  }
})

test("refreshQwenPortalToken exchanges refresh token", async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      access_token: "next-access",
      refresh_token: "next-refresh",
      expires_in: 1800
    })
  })

  try {
    const tokenSet = await refreshQwenPortalToken({ refreshToken: "old-refresh" })
    assert.equal(tokenSet.accessToken, "next-access")
    assert.equal(tokenSet.refreshToken, "next-refresh")
    assert.equal(tokenSet.expiresAt > Date.now(), true)
  } finally {
    global.fetch = originalFetch
  }
})
