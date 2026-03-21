import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  listAuthProfiles,
  removeAuthProfile,
  resolveProviderAuthProfile,
  setDefaultAuthProfile,
  upsertAuthProfile
} from "../src/provider/auth-profiles.mjs"

let home = ""

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-auth-"))
  process.env.KKCODE_HOME = home
  delete process.env.TEST_PROVIDER_TOKEN
})

test.afterEach(async () => {
  delete process.env.KKCODE_HOME
  delete process.env.TEST_PROVIDER_TOKEN
  await rm(home, { recursive: true, force: true })
})

test("auth profiles choose provider default profile", async () => {
  const firstId = await upsertAuthProfile({
    providerId: "openai",
    displayName: "primary",
    credential: "sk-primary",
    isDefault: true
  })
  const secondId = await upsertAuthProfile({
    providerId: "openai",
    displayName: "secondary",
    credential: "sk-secondary"
  })

  const profiles = await listAuthProfiles({ providerId: "openai" })
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0].id, firstId)
  assert.equal(profiles[0].isDefault, true)
  assert.equal(profiles[1].id, secondId)
})

test("auth profiles can resolve env-backed credentials", async () => {
  process.env.TEST_PROVIDER_TOKEN = "env-secret"
  await upsertAuthProfile({
    providerId: "deepseek",
    displayName: "env profile",
    credentialEnv: "TEST_PROVIDER_TOKEN",
    isDefault: true
  })
  const resolved = await resolveProviderAuthProfile({ providerId: "deepseek" })
  assert.equal(resolved.credential, "env-secret")
  assert.equal(resolved.readyState, "ready")
})

test("removing default profile promotes another profile", async () => {
  const firstId = await upsertAuthProfile({
    providerId: "groq",
    displayName: "one",
    credential: "one",
    isDefault: true
  })
  const secondId = await upsertAuthProfile({
    providerId: "groq",
    displayName: "two",
    credential: "two"
  })
  const removed = await removeAuthProfile(firstId)
  assert.equal(removed, true)
  const profiles = await listAuthProfiles({ providerId: "groq" })
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].id, secondId)
  assert.equal(profiles[0].isDefault, true)
})

test("setDefaultAuthProfile flips defaults within provider", async () => {
  const firstId = await upsertAuthProfile({
    providerId: "mistral",
    displayName: "one",
    credential: "one",
    isDefault: true
  })
  const secondId = await upsertAuthProfile({
    providerId: "mistral",
    displayName: "two",
    credential: "two"
  })
  assert.ok(firstId)
  const changed = await setDefaultAuthProfile("mistral", secondId)
  assert.equal(changed, true)
  const profiles = await listAuthProfiles({ providerId: "mistral" })
  assert.equal(profiles[0].id, secondId)
  assert.equal(profiles[0].isDefault, true)
  assert.equal(profiles[1].isDefault, false)
})
