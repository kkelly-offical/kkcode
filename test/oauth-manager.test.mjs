import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  beginProviderOAuth,
  clearPendingOAuthSession,
  importProviderOAuthCallback,
  loadPendingOAuthSession
} from "../src/provider/oauth-manager.mjs"

let home = ""

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-oauth-manager-"))
  process.env.KKCODE_HOME = home
})

test.afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("beginProviderOAuth stores pending session and appends oauth params", async () => {
  const pending = await beginProviderOAuth({
    providerId: "openai-codex",
    clientId: "client_123"
  })

  assert.equal(pending.providerId, "openai-codex")
  assert.ok(pending.authUrl.includes("state="))
  assert.ok(pending.authUrl.includes("redirect_uri="))
  assert.ok(pending.authUrl.includes("code_challenge="))

  const saved = await loadPendingOAuthSession()
  assert.equal(saved.state, pending.state)
})

test("importProviderOAuthCallback accepts direct token callback from fragment", async () => {
  await beginProviderOAuth({
    providerId: "openai-codex"
  })
  const pending = await loadPendingOAuthSession()
  const imported = await importProviderOAuthCallback({
    providerId: "openai-codex",
    callbackUrl: `kkcode://oauth#state=${pending.state}&access_token=tok_123&refresh_token=ref_456&expires_in=3600`
  })

  assert.equal(imported.accessToken, "tok_123")
  assert.equal(imported.refreshToken, "ref_456")
  assert.ok(Number(imported.expiresAt) > Date.now())
})

test("importProviderOAuthCallback exchanges authorization code when token endpoint is configured", async () => {
  await beginProviderOAuth({
    providerId: "custom-oauth",
    authUrl: "https://auth.example.com/authorize",
    clientId: "client_123",
    tokenUrl: "https://auth.example.com/token"
  })
  const pending = await loadPendingOAuthSession()
  const imported = await importProviderOAuthCallback({
    providerId: "custom-oauth",
    callbackUrl: `kkcode://oauth?state=${pending.state}&code=abc123`,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        access_token: "tok_exchange",
        refresh_token: "ref_exchange",
        expires_in: 7200
      })
    })
  })

  assert.equal(imported.accessToken, "tok_exchange")
  assert.equal(imported.refreshToken, "ref_exchange")
})

test("clearPendingOAuthSession removes saved pending state", async () => {
  await beginProviderOAuth({
    providerId: "openai-codex"
  })
  await clearPendingOAuthSession()
  const pending = await loadPendingOAuthSession()
  assert.equal(pending, null)
})
