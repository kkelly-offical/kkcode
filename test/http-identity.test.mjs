import test from "node:test"
import assert from "node:assert/strict"
import {
  KKCODE_USER_AGENT,
  buildRequestHeaders,
  createRequestContext,
  redactHeaders,
  redactSensitive
} from "../src/http/identity.mjs"
import { PACKAGE_VERSION } from "../src/version.mjs"

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
  assert.equal(headers["User-Agent"], `KK-Code/${PACKAGE_VERSION} (+https://github.com/kkelly-offical/kkcode)`)
  assert.equal(headers["X-KK-Code-Version"], PACKAGE_VERSION)
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
    "User-Agent": `KK-Code/${PACKAGE_VERSION}`
  }), {
    Authorization: "[REDACTED]",
    "X-Api-Key": "[REDACTED]",
    "User-Agent": `KK-Code/${PACKAGE_VERSION}`
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
  assert.equal(redacted["X-KK-Code-Version"], PACKAGE_VERSION)
})

test("request context correlates protocol identity and OpenAI client request id", () => {
  const context = createRequestContext()
  const headers = buildRequestHeaders({
    target: "model-discovery",
    provider: "gateway",
    protocol: "openai",
    requestId: context.requestId,
    openAIClientRequestId: true,
    customHeaders: {
      "X-KK-Code-Protocol": "spoofed",
      "X-KK-Code-Request-Id": "spoofed",
      "X-Client-Request-Id": "spoofed"
    }
  })

  assert.match(context.traceId, /^[0-9a-f-]{36}$/)
  assert.match(context.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(headers["X-KK-Code-Protocol"], "openai")
  assert.equal(headers["X-KK-Code-Request-Id"], context.requestId)
  assert.equal(headers["X-Client-Request-Id"], context.requestId)
})

test("recursive redaction removes secrets embedded in strings", () => {
  assert.deepEqual(redactSensitive({
    nested: {
      header: "Bearer abc.def-123",
      detail: "upstream returned " + "sk-kimi-" + "abcdefghijklmnopqrstuvwxyz"
    }
  }), {
    nested: {
      header: "Bearer [REDACTED]",
      detail: "upstream returned [REDACTED]"
    }
  })
})

test("recursive redaction preserves token metrics but removes token credentials", () => {
  assert.deepEqual(redactSensitive({
    tokenCount: 17,
    input_tokens: 10,
    max_tokens: 100,
    accessToken: "secret-access",
    github_token: "secret-github"
  }), {
    tokenCount: 17,
    input_tokens: 10,
    max_tokens: 100,
    accessToken: "[REDACTED]",
    github_token: "[REDACTED]"
  })
})
