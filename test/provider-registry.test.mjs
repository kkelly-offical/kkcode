import test from "node:test"
import assert from "node:assert/strict"
import { registerProvider, listProviders, getProvider } from "../src/provider/router.mjs"

test("listProviders includes built-in openai and anthropic", () => {
  const providers = listProviders()
  assert.ok(providers.includes("openai"))
  assert.ok(providers.includes("anthropic"))
})

test("registerProvider adds a new provider", () => {
  registerProvider("test-custom", {
    request: async () => ({ text: "ok", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: [] }),
    requestStream: async function* () { yield { type: "text", content: "ok" } }
  })
  assert.ok(listProviders().includes("test-custom"))
  assert.ok(getProvider("test-custom"))
})

test("registerProvider rejects invalid module", () => {
  assert.throws(() => registerProvider("bad", {}), /must export request/)
  assert.throws(() => registerProvider("bad2", { request: () => {} }), /must export request/)
})

test("getProvider returns null for unknown", () => {
  assert.equal(getProvider("nonexistent"), null)
})
