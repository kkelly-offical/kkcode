import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  THINKING_TIERS,
  normalizeThinkingTier,
  resolveThinkingParams,
  thinkingBudgetTokens,
  supportsThinking
} from "../src/provider/thinking-effort.mjs"
import { applyDiscoveredCapabilities } from "../src/provider/model-catalog.mjs"

/**
 * 0.6.2：思考强度分四档，预算按模型自身能力推算而不是写死。
 *
 * 此前 Anthropic 侧的 budget_tokens 硬编码 10000 —— 对 200K 上下文的模型
 * 太保守，对小模型又可能超过它的输出上限。配置里该写的是意图（"想深一点"），
 * 不是一个跟着模型走的数字。
 */

describe("档位归一", () => {
  it("五个档位 + off", () => {
    assert.deepEqual([...THINKING_TIERS], ["off", "low", "medium", "high", "max"])
  })

  it("大小写与空白容错", () => {
    assert.equal(normalizeThinkingTier(" HIGH "), "high")
    assert.equal(normalizeThinkingTier("Medium"), "medium")
  })

  it('0.5.x 的 "none" 映射到 off', () => {
    assert.equal(normalizeThinkingTier("none"), "off")
  })

  it("无法识别时回落到给定缺省", () => {
    assert.equal(normalizeThinkingTier("wat"), "high")
    assert.equal(normalizeThinkingTier(undefined, "low"), "low")
  })
})

describe("预算随模型能力变化，而不是常数", () => {
  it("同一档位下，输出上限越大预算越大", () => {
    const small = thinkingBudgetTokens({ tier: "high", maxOutputTokens: 4096 })
    const large = thinkingBudgetTokens({ tier: "high", maxOutputTokens: 65536 })
    assert.ok(large > small * 4, `大模型应拿到更多预算: ${small} vs ${large}`)
  })

  it("档位越高预算越大", () => {
    const at = (tier) => thinkingBudgetTokens({ tier, maxOutputTokens: 32768 })
    assert.ok(at("low") < at("medium"))
    assert.ok(at("medium") < at("high"))
    assert.ok(at("high") < at("max"))
  })

  it("永远给正文留余量 —— 思考预算不吃满输出上限", () => {
    const budget = thinkingBudgetTokens({ tier: "max", maxOutputTokens: 8192 })
    assert.ok(budget < 8192, `max 档也不该吃满: ${budget}`)
  })

  it("小模型也不会低于可用下限", () => {
    assert.ok(thinkingBudgetTokens({ tier: "low", maxOutputTokens: 512 }) >= 1024)
  })

  it("拿不到输出上限时按上下文推算", () => {
    const byContext = thinkingBudgetTokens({ tier: "high", contextLimit: 200000 })
    const fallback = thinkingBudgetTokens({ tier: "high" })
    assert.ok(byContext > fallback, "有上下文信息时应当比兜底更大")
  })

  it("off 档不产生预算", () => {
    assert.equal(thinkingBudgetTokens({ tier: "off", maxOutputTokens: 32768 }), 0)
  })
})

describe("按协议翻译成对应参数", () => {
  it("anthropic 得到 budget_tokens", () => {
    const params = resolveThinkingParams({ tier: "high", protocol: "anthropic", maxOutputTokens: 32768 })
    assert.equal(params.thinking.type, "enabled")
    assert.ok(params.thinking.budget_tokens > 1024)
    assert.equal(params.reasoningEffort, undefined)
  })

  it("openai 得到 reasoning_effort 字符串", () => {
    const params = resolveThinkingParams({ tier: "medium", protocol: "openai" })
    assert.equal(params.reasoningEffort, "medium")
    assert.equal(params.thinking, undefined)
  })

  it("off 档两种协议都不带参数", () => {
    assert.deepEqual(resolveThinkingParams({ tier: "off", protocol: "anthropic" }), {})
    assert.deepEqual(resolveThinkingParams({ tier: "off", protocol: "openai" }), {})
  })
})

describe("能力探测", () => {
  it("目录自报的 supported_parameters 优先", () => {
    assert.equal(supportsThinking({ supportedParameters: ["reasoning", "tools"] }), true)
    assert.equal(supportsThinking({ supportedParameters: ["tools"] }), false)
  })

  it("拿不准时返回 null，而不是猜一个布尔", () => {
    assert.equal(supportsThinking({ modelId: "some-unknown-model" }), null)
    assert.equal(supportsThinking({}), null)
  })

  it("已知的推理模型族识别为支持", () => {
    for (const id of ["gpt-5", "claude-opus-4", "k3", "deepseek-r1"]) {
      assert.equal(supportsThinking({ modelId: id }), true, id)
    }
  })
})

describe("能力自动回写配置", () => {
  it("把当前模型的输出上限与上下文写进 provider 配置", () => {
    const configState = { config: { provider: { p: { default_model: "m1" } } } }
    const changed = applyDiscoveredCapabilities(configState, "p", [
      { id: "m1", maxOutputTokens: 65536, contextLength: 1048576 }
    ])
    assert.equal(changed, true)
    assert.equal(configState.config.provider.p.max_output_tokens, 65536)
    assert.equal(configState.config.provider.p.context_limit, 1048576)
  })

  it("用户显式写过的值不被覆盖", () => {
    const configState = { config: { provider: { p: { default_model: "m1", max_output_tokens: 4096 } } } }
    applyDiscoveredCapabilities(configState, "p", [{ id: "m1", maxOutputTokens: 65536 }])
    assert.equal(configState.config.provider.p.max_output_tokens, 4096)
  })

  it("目录里没有当前模型时安静返回", () => {
    const configState = { config: { provider: { p: { default_model: "missing" } } } }
    assert.equal(applyDiscoveredCapabilities(configState, "p", [{ id: "other" }]), false)
  })
})

test("端到端：换模型不用改数字", () => {
  // 同一个 high 档，跟着模型能力自动变化
  const onSmall = resolveThinkingParams({ tier: "high", protocol: "anthropic", maxOutputTokens: 8192 })
  const onLarge = resolveThinkingParams({ tier: "high", protocol: "anthropic", maxOutputTokens: 65536 })
  assert.notEqual(onSmall.thinking.budget_tokens, onLarge.thinking.budget_tokens)
  assert.ok(onSmall.thinking.budget_tokens < onLarge.thinking.budget_tokens)
})
