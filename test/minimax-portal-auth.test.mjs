import test from "node:test"
import assert from "node:assert/strict"
import {
  pollMiniMaxPortalAccessToken,
  refreshMiniMaxPortalToken,
  requestMiniMaxPortalCode
} from "../src/provider/minimax-portal-auth.mjs"

test("requestMiniMaxPortalCode returns verifier and normalized fields", async () => {
  const device = await requestMiniMaxPortalCode({
    stateOverride: "teststate",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        user_code: "ABCD-EFGH",
        verification_uri: "https://platform.minimax.io/activate",
        expired_in: 900,
        state: "teststate"
      })
    })
  })
  assert.equal(device.userCode, "ABCD-EFGH")
  assert.equal(device.verificationUri, "https://platform.minimax.io/activate")
  assert.ok(device.verifier)
})

test("pollMiniMaxPortalAccessToken returns normalized token set", async () => {
  const tokenSet = await pollMiniMaxPortalAccessToken({
    userCode: "ABCD",
    verifier: "verifier",
    expiresAt: Date.now() + 60000,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        access_token: "tok_minimax",
        refresh_token: "ref_minimax",
        expired_in: 3600,
        resource_url: "https://api.minimax.io/anthropic"
      })
    })
  })
  assert.equal(tokenSet.accessToken, "tok_minimax")
  assert.equal(tokenSet.refreshToken, "ref_minimax")
  assert.equal(tokenSet.baseUrl, "https://api.minimax.io/anthropic")
})

test("refreshMiniMaxPortalToken exchanges refresh token", async () => {
  const tokenSet = await refreshMiniMaxPortalToken({
    refreshToken: "refresh_123",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        access_token: "tok_refresh",
        refresh_token: "ref_refresh",
        expired_in: 7200,
        resource_url: "https://api.minimax.io/anthropic"
      })
    })
  })
  assert.equal(tokenSet.accessToken, "tok_refresh")
  assert.equal(tokenSet.refreshToken, "ref_refresh")
})
