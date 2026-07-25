import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { modelContextLimit, shouldCompact, contextUtilization } from "../src/session/compaction.mjs"
import { applyDiscoveredContextLimits } from "../src/provider/model-catalog.mjs"
import { formatTokenCount } from "../src/theme/status-bar.mjs"

/**
 * 0.6.0 阶段 6：模型与上下文自治。
 * 三个此前的行为缺陷：上限读错 provider、消息数阈值架空比例阈值、
 * 目录发现丢弃上下文长度。
 */

describe("modelContextLimit 跟随活跃 provider", () => {
  const configState = {
    config: {
      provider: {
        default: "alpha",
        alpha: { context_limit: 100000 },
        beta: { context_limit: 900000 }
      }
    }
  }

  it("传入 providerType 时用它，而不是配置里的 default", () => {
    assert.equal(modelContextLimit("some-model", configState, "beta"), 900000)
    assert.equal(modelContextLimit("some-model", configState, "alpha"), 100000)
  })

  it("不传时保持旧行为（default provider）", () => {
    assert.equal(modelContextLimit("some-model", configState), 100000)
  })

  it("model_context 精确映射仍然最高优先", () => {
    const withMc = { config: { provider: { ...configState.config.provider, model_context: { "some-model": 42000 } } } }
    assert.equal(modelContextLimit("some-model", withMc, "beta"), 42000)
  })
})

describe("85% 阈值真的能触发", () => {
  const configState = { config: { provider: { default: "p", p: { context_limit: 100000 } } } }
  const messagesOf = (n) => Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }))

  it("60 条消息不再直接触发压缩（0.5.x 会在 50 条短路）", () => {
    assert.equal(
      shouldCompact({ messages: messagesOf(60), model: "m", configState, providerType: "p", realTokenCount: 1000 }),
      false,
      "消息数不该在比例远未到时抢跑"
    )
  })

  it("token 到 85% 触发，84% 不触发", () => {
    const base = { messages: messagesOf(10), model: "m", configState, providerType: "p" }
    assert.equal(shouldCompact({ ...base, realTokenCount: 84999 }), false)
    assert.equal(shouldCompact({ ...base, realTokenCount: 85000 }), true)
  })

  it("消息数高位安全网（200 条）仍然兜底", () => {
    assert.equal(
      shouldCompact({ messages: messagesOf(200), model: "m", configState, providerType: "p", realTokenCount: 1000 }),
      true
    )
  })

  it("contextUtilization 也跟随活跃 provider", () => {
    const meter = contextUtilization(messagesOf(3), "m", configState, "p")
    assert.equal(meter.limit, 100000)
  })
})

describe("目录发现的上下文长度合并", () => {
  it("API 自报的长度写进内存 model_context，用户显式配置不被覆盖", () => {
    const configState = {
      config: { provider: { default: "p", p: {}, model_context: { "manual-model": 5000 } } }
    }
    const added = applyDiscoveredContextLimits(configState, [
      { id: "auto-model", contextLength: 262144 },
      { id: "manual-model", contextLength: 999999 },
      { id: "no-ctx-model" }
    ])
    assert.equal(added, 1)
    assert.equal(configState.config.provider.model_context["auto-model"], 262144)
    assert.equal(configState.config.provider.model_context["manual-model"], 5000, "手工配置优先")
    // 合并后 modelContextLimit 直接吃到
    assert.equal(modelContextLimit("auto-model", configState), 262144)
  })

  it("没有 provider 段时安静返回 0", () => {
    assert.equal(applyDiscoveredContextLimits({ config: {} }, [{ id: "x", contextLength: 9999 }]), 0)
  })
})

test("formatTokenCount 的三个量级", () => {
  assert.equal(formatTokenCount(950), "950")
  assert.equal(formatTokenCount(193400), "193.4K")
  assert.equal(formatTokenCount(1250000), "1.3M")
  assert.equal(formatTokenCount(0), "0")
})
