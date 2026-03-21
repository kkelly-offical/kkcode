import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { upsertAuthProfile } from "../src/provider/auth-profiles.mjs"
import { hasAnyProviderCredential } from "../src/commands/chat.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"

let home = ""

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-chat-command-"))
  process.env.KKCODE_HOME = home
})

test.afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("chat command preflight accepts fallback provider credentials", async () => {
  await upsertAuthProfile({
    providerId: "secondary",
    displayName: "secondary profile",
    credential: "sk-secondary",
    isDefault: true
  })

  const config = {
    ...DEFAULT_CONFIG,
    provider: {
      ...DEFAULT_CONFIG.provider,
      primaryfallback: {
        type: "openai-compatible",
        base_url: "https://api.example.com/v1",
        default_model: "primary-model",
        fallback_models: ["secondary::secondary-model"]
      },
      secondary: {
        type: "openai-compatible",
        base_url: "https://api.example.com/v1",
        default_model: "secondary-model"
      }
    }
  }

  const ok = await hasAnyProviderCredential(config, "primaryfallback", config.provider.primaryfallback, null)
  assert.equal(ok, true)
})
