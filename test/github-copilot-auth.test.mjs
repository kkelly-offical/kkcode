import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { deriveCopilotApiBaseUrlFromToken, resolveGitHubCopilotRuntimeAuth } from "../src/provider/github-copilot-auth.mjs"

let home = ""

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-copilot-auth-"))
  process.env.KKCODE_HOME = home
})

test.afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("deriveCopilotApiBaseUrlFromToken extracts api host from proxy endpoint", () => {
  assert.equal(
    deriveCopilotApiBaseUrlFromToken("foo=1; proxy-ep=https://proxy.business.githubcopilot.com ; bar=2"),
    "https://api.business.githubcopilot.com"
  )
})

test("resolveGitHubCopilotRuntimeAuth exchanges GitHub token and returns runtime token", async () => {
  const calls = []
  const runtime = await resolveGitHubCopilotRuntimeAuth({
    githubToken: "ghu_test",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options })
      return {
        ok: true,
        json: async () => ({
          token: "tid=1; proxy-ep=https://proxy.individual.githubcopilot.com",
          expires_at: Math.floor(Date.now() / 1000) + 3600
        })
      }
    }
  })

  assert.equal(runtime.apiKey.includes("proxy-ep="), true)
  assert.equal(runtime.baseUrl, "https://api.individual.githubcopilot.com")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.headers.Authorization, "Bearer ghu_test")
})
