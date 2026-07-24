import test from "node:test"
import assert from "node:assert/strict"
import {
  KKCODE_USER_AGENT,
  buildRequestHeaders,
  redactHeaders,
  redactSensitive
} from "../src/http/identity.mjs"

test("request identity uses KK Code version and cannot be overridden", () => {
  const headers = buildRequestHeaders({
    target: "test",
    provider: "kimi-code",
    accept: "application/json",
    authorization: "Bearer secret",
    customHeaders: {
      "user-agent": "node",
      "X-KK-Code-Version": "0.0.0",
      "X-Gateway": "edge"
    }
  })

  assert.equal(headers["User-Agent"], KKCODE_USER_AGENT)
  assert.match(headers["User-Agent"], /^KK-Code\/0\.3\.1 /)
  assert.equal(headers["X-KK-Code-Version"], "0.3.1")
  assert.equal(headers["X-KK-Code-Client"], "cli")
  assert.equal(headers["X-KK-Code-Provider"], "kimi-code")
  assert.equal(headers["X-KK-Code-Target"], "test")
  assert.equal(headers["X-Gateway"], "edge")
  assert.equal(Object.keys(headers).filter((name) => name.toLowerCase() === "user-agent").length, 1)
})

test("header and nested diagnostic redaction never expose credentials", () => {
  assert.deepEqual(redactHeaders({
    Authorization: "Bearer secret",
    "x-api-key": "sk-secret",
    "User-Agent": "KK-Code/0.3.1"
  }), {
    Authorization: "[REDACTED]",
    "X-Api-Key": "[REDACTED]",
    "User-Agent": "KK-Code/0.3.1"
  })

  assert.deepEqual(redactSensitive({
    provider: { api_key: "sk-secret", model: "k3" },
    token: "secret"
  }), {
    provider: { api_key: "[REDACTED]", model: "k3" },
    token: "[REDACTED]"
  })
})

test("diagnostics preserve the KK Code identity casing", () => {
  const redacted = redactHeaders(buildRequestHeaders({
    target: "doctor",
    provider: "kimi-code"
  }))
  assert.equal(redacted["X-KK-Code-Target"], "doctor")
  assert.equal(redacted["X-KK-Code-Provider"], "kimi-code")
  assert.equal(redacted["X-KK-Code-Version"], "0.3.1")
})
