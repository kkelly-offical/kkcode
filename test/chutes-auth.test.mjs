import test from "node:test"
import assert from "node:assert/strict"
import { refreshChutesToken, CHUTES_TOKEN_ENDPOINT } from "../src/provider/chutes-auth.mjs"

test("refreshChutesToken exchanges refresh token with configured client id", async () => {
  let request = null
  const result = await refreshChutesToken({
    refreshToken: "refresh_demo",
    clientId: "cid_demo",
    clientSecret: "secret_demo",
    fetchImpl: async (url, options) => {
      request = { url, options }
      return {
        ok: true,
        json: async () => ({
          access_token: "access_demo",
          refresh_token: "refresh_next",
          expires_in: 3600
        })
      }
    }
  })

  assert.equal(request.url, CHUTES_TOKEN_ENDPOINT)
  assert.equal(request.options.method, "POST")
  assert.match(String(request.options.body), /grant_type=refresh_token/)
  assert.match(String(request.options.body), /client_id=cid_demo/)
  assert.match(String(request.options.body), /client_secret=secret_demo/)
  assert.equal(result.accessToken, "access_demo")
  assert.equal(result.refreshToken, "refresh_next")
  assert.equal(typeof result.expiresAt, "number")
})
