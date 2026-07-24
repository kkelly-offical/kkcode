import test from "node:test"
import assert from "node:assert/strict"
import { resolveRoleModel, hasFastModel, providerDefaultModel, MODEL_ROLES } from "../src/provider/model-roles.mjs"
import { requestFast, fastModelId, isFastModelConfigured } from "../src/provider/fast-model.mjs"
import { resetDeprecations } from "../src/core/deprecations.mjs"

function makeConfig(overrides = {}) {
  return {
    provider: {
      default: "openai",
      openai: { default_model: "gpt-main" }
    },
    ...overrides
  }
}

test("model roles are the three-key set", () => {
  assert.deepEqual(MODEL_ROLES, ["main", "fast", "subagent"])
})

test("main falls back to the provider default model", () => {
  assert.equal(resolveRoleModel(makeConfig(), "main"), "gpt-main")
  assert.equal(resolveRoleModel(makeConfig({ models: { main: "gpt-explicit" } }), "main"), "gpt-explicit")
  assert.equal(providerDefaultModel(makeConfig()), "gpt-main")
})

test("subagent falls back to main, fast deliberately does not", () => {
  const config = makeConfig()
  assert.equal(resolveRoleModel(config, "subagent"), "gpt-main")
  // an unset fast model must stay empty so callers disable the feature
  // rather than silently spending the expensive main model on completions
  assert.equal(resolveRoleModel(config, "fast"), "")
  assert.equal(hasFastModel(config), false)

  const withFast = makeConfig({ models: { fast: "gpt-tiny" } })
  assert.equal(resolveRoleModel(withFast, "fast"), "gpt-tiny")
  assert.equal(hasFastModel(withFast), true)
})

test("legacy longagent model overrides still resolve into the new roles", (t) => {
  t.after(resetDeprecations)
  resetDeprecations()

  const legacy = makeConfig({
    agent: {
      longagent: {
        hybrid: {
          degradation: { fallback_model: "gpt-cheap" },
          adaptive_models: { high: "gpt-big" }
        }
      }
    }
  })
  assert.equal(resolveRoleModel(legacy, "fast"), "gpt-cheap")
  assert.equal(resolveRoleModel(legacy, "main"), "gpt-big")
})

test("blank and whitespace-only values are treated as unset", () => {
  const config = makeConfig({ models: { main: "   ", fast: "", subagent: null } })
  assert.equal(resolveRoleModel(config, "main"), "gpt-main")
  assert.equal(resolveRoleModel(config, "fast"), "")
  assert.equal(resolveRoleModel(config, "subagent"), "gpt-main")
})

test("requestFast returns null when no fast model is configured", async () => {
  const configState = { config: makeConfig() }
  assert.equal(isFastModelConfigured(configState), false)
  assert.equal(fastModelId(configState), "")

  let called = false
  const out = await requestFast({
    configState,
    prompt: "hello",
    deps: { requestProvider: async () => { called = true; return { text: "x" } } }
  })
  assert.equal(out, null)
  assert.equal(called, false, "must not reach the provider at all")
})

test("requestFast uses the non-streaming path with a bounded maxTokens and no audit", async () => {
  const configState = { config: makeConfig({ models: { fast: "gpt-tiny" } }) }
  const seen = []
  const out = await requestFast({
    configState,
    prompt: "complete this",
    system: "predict",
    maxTokens: 24,
    deps: {
      requestProvider: async (input) => {
        seen.push(input)
        return { text: "  predicted text  " }
      }
    }
  })

  assert.equal(out, "predicted text")
  assert.equal(seen.length, 1)
  assert.equal(seen[0].model, "gpt-tiny")
  assert.equal(seen[0].maxTokens, 24)
  // audit must be bypassed: a keystroke-triggered call would otherwise flood
  // the kk.audit.v1 chain with provider.request entries
  assert.equal(seen[0].audit, false)
  assert.deepEqual(seen[0].tools, [])
  assert.deepEqual(seen[0].messages, [{ role: "user", content: "complete this" }])
})

test("requestFast swallows provider failures so callers never break", async () => {
  const configState = { config: makeConfig({ models: { fast: "gpt-tiny" } }) }
  const out = await requestFast({
    configState,
    prompt: "hi",
    deps: { requestProvider: async () => { throw new Error("rate limited") } }
  })
  assert.equal(out, null)
})

test("requestFast returns null for an empty prompt or an already-aborted signal", async () => {
  const configState = { config: makeConfig({ models: { fast: "gpt-tiny" } }) }
  const deps = { requestProvider: async () => ({ text: "should not happen" }) }

  assert.equal(await requestFast({ configState, prompt: "   ", deps }), null)

  const controller = new AbortController()
  controller.abort()
  assert.equal(await requestFast({ configState, prompt: "hi", signal: controller.signal, deps }), null)
})

test("an outer abort cancels the in-flight fast request", async () => {
  const configState = { config: makeConfig({ models: { fast: "gpt-tiny" } }) }
  const controller = new AbortController()

  const pending = requestFast({
    configState,
    prompt: "hi",
    signal: controller.signal,
    deps: {
      requestProvider: (input) => new Promise((resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    }
  })

  controller.abort()
  assert.equal(await pending, null)
})

test("an empty model reply becomes null instead of an empty suggestion", async () => {
  const configState = { config: makeConfig({ models: { fast: "gpt-tiny" } }) }
  const out = await requestFast({
    configState,
    prompt: "hi",
    deps: { requestProvider: async () => ({ text: "   " }) }
  })
  assert.equal(out, null)
})
