import test from "node:test"
import assert from "node:assert/strict"
import { resolveRoleModel, hasFastModel, providerDefaultModel, MODEL_ROLES } from "../src/provider/model-roles.mjs"
import {
  requestFast, fastModelId, isFastModelConfigured, fastModelIssues, resetFastModelHealth
} from "../src/provider/fast-model.mjs"
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

test("models.fast accepts a provider/model qualifier for cross-channel fast models", async () => {
  // 快模型经常不在主渠道上：主渠道是 kimi（coding 模型全是 thinking-only，
  // 小 token 预算下正文为空），而即答的便宜模型在 qwen 渠道。
  const configState = {
    config: makeConfig({
      models: { fast: "aliyun/qwen-flash" },
      provider: { default: "kimi", kimi: { default_model: "k3" }, aliyun: { default_model: "qwen-plus" } }
    })
  }
  const seen = []
  const out = await requestFast({
    configState,
    prompt: "x",
    deps: { requestProvider: async (args) => { seen.push(args); return { text: "ok" } } }
  })
  assert.equal(out, "ok")
  assert.equal(seen[0].providerType, "aliyun", "前缀命中已配置 provider 时切换渠道")
  assert.equal(seen[0].model, "qwen-flash", "模型名剥掉前缀")

  // 前缀不是已配置的 provider → 按字面模型名走默认渠道（不误拆 org/model 形态的 id）
  const literal = { config: makeConfig({ models: { fast: "org/some-model" }, provider: { default: "kimi", kimi: {} } }) }
  const seen2 = []
  await requestFast({ configState: literal, prompt: "x", deps: { requestProvider: async (a) => { seen2.push(a); return { text: "y" } } } })
  assert.equal(seen2[0].providerType, "kimi")
  assert.equal(seen2[0].model, "org/some-model")
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
  resetFastModelHealth()
  const configState = { config: makeConfig({ models: { fast: "gpt-tiny" } }) }
  const out = await requestFast({
    configState,
    prompt: "hi",
    deps: { requestProvider: async () => ({ text: "   " }) }
  })
  assert.equal(out, null)
  resetFastModelHealth()
})

// 0.5.6：thinking-only 模型（kimi coding 系列、各家 reasoning 模型）会把
// 32 token 的预算全花在思考上，正文恒为空。ghost text 每次打字停顿都会
// 再发一次 —— 用户什么都看不到，而调用刻意不进审计与成本统计，于是成为
// 一条无声的烧钱通道。断路器让它自己停下来并可被 preflight 看见。
test("a thinking-only fast model is disabled after repeated empty replies", async () => {
  resetFastModelHealth()
  const configState = { config: makeConfig({ models: { fast: "thinker" } }) }
  let calls = 0
  const deps = {
    requestProvider: async () => {
      calls += 1
      return { text: "", reasoning: "推理内容把预算烧光了" }
    }
  }

  for (let i = 0; i < 3; i++) {
    assert.equal(await requestFast({ configState, prompt: "hi", deps }), null)
  }
  assert.equal(calls, 3)

  // 第四次不该再发出请求
  assert.equal(await requestFast({ configState, prompt: "hi", deps }), null)
  assert.equal(calls, 3, "停用后必须短路，不再发请求")

  const issues = fastModelIssues()
  assert.equal(issues.length, 1)
  assert.match(issues[0].model, /thinker/)
  assert.match(issues[0].reason, /thinking-only/)
  resetFastModelHealth()
})

test("network failures do not trip the breaker, and a good reply resets it", async () => {
  resetFastModelHealth()
  const configState = { config: makeConfig({ models: { fast: "flaky" } }) }
  let calls = 0

  // 连续失败：暂时性问题，不该判模型死刑
  for (let i = 0; i < 5; i++) {
    await requestFast({
      configState,
      prompt: "hi",
      deps: { requestProvider: async () => { calls += 1; throw new Error("ETIMEDOUT") } }
    })
  }
  assert.equal(calls, 5, "网络失败不进断路器")
  assert.deepEqual(fastModelIssues(), [])

  // 两次空回复后来了一次正常回复 → 计数清零
  const empty = { requestProvider: async () => ({ text: "" }) }
  await requestFast({ configState, prompt: "hi", deps: empty })
  await requestFast({ configState, prompt: "hi", deps: empty })
  assert.equal(
    await requestFast({ configState, prompt: "hi", deps: { requestProvider: async () => ({ text: "ok" }) } }),
    "ok"
  )
  await requestFast({ configState, prompt: "hi", deps: empty })
  assert.deepEqual(fastModelIssues(), [], "一次成功即清零，不该被历史空回复拖垮")
  resetFastModelHealth()
})
