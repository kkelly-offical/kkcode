import test from "node:test"
import assert from "node:assert/strict"
import { redactAuthProfile, redactAuthProfiles } from "../src/commands/auth.mjs"

test("redactAuthProfile masks sensitive fields by default", () => {
  const redacted = redactAuthProfile({
    id: "auth_123",
    providerId: "openai",
    displayName: "primary",
    credential: "sk-secret-123456",
    accessToken: "oauth-access-abcdef",
    refreshToken: "oauth-refresh-uvwxyz"
  })

  assert.equal(redacted.credential, "sk-s...3456")
  assert.equal(redacted.accessToken, "oaut...cdef")
  assert.equal(redacted.refreshToken, "oaut...wxyz")
})

test("redactAuthProfile preserves secrets when reveal=true", () => {
  const profile = {
    id: "auth_123",
    providerId: "openai",
    displayName: "primary",
    credential: "sk-secret-123456",
    accessToken: "oauth-access-abcdef",
    refreshToken: "oauth-refresh-uvwxyz"
  }

  assert.deepEqual(redactAuthProfile(profile, { reveal: true }), profile)
})

test("redactAuthProfiles masks each profile in JSON list output", () => {
  const profiles = [
    {
      id: "auth_123",
      providerId: "openai",
      displayName: "primary",
      credential: "sk-secret-123456",
      accessToken: "oauth-access-abcdef",
      refreshToken: "oauth-refresh-uvwxyz"
    },
    {
      id: "auth_456",
      providerId: "qwen-portal",
      displayName: "secondary",
      credential: "token-12345678",
      accessToken: "",
      refreshToken: ""
    }
  ]

  const redacted = redactAuthProfiles(profiles)

  assert.equal(redacted[0].credential, "sk-s...3456")
  assert.equal(redacted[0].accessToken, "oaut...cdef")
  assert.equal(redacted[0].refreshToken, "oaut...wxyz")
  assert.equal(redacted[1].credential, "toke...5678")
})
