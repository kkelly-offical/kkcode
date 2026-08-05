import test from "node:test"
import assert from "node:assert/strict"

import { loadPricing, calculateCost } from "../src/usage/pricing.mjs"

/** 没有配置 usage.pricing_file 时 loadPricing 返回内置表。 */
async function defaultPricing() {
  const { pricing, source } = await loadPricing({ source: {} })
  assert.equal(source, "default", "这组用例针对的是内置价目表")
  return pricing
}

/** 单价换算成「一百万 input token 的钱」，便于直接和表里的数字比。 */
function inputUnitPrice(pricing, model) {
  const { amount } = calculateCost(pricing, model, { input: 1_000_000 })
  return amount
}

test("Claude 5 家族在表里，不会落到 default 单价上", async () => {
  const pricing = await defaultPricing()

  // 落到 default（3/15）时 amount 恰好等于 Sonnet 单价，光看数字分不出来 ——
  // 所以 unknown 标记要一起断言。
  for (const [model, expected] of [
    ["claude-fable-5", 10],
    ["claude-opus-5", 5],
    ["claude-sonnet-5", 3],
    ["claude-opus-4-8", 5]
  ]) {
    const { unknown } = calculateCost(pricing, model, { input: 1 })
    assert.equal(unknown, false, `${model} 不该被当成未知模型`)
    assert.equal(inputUnitPrice(pricing, model), expected, `${model} 的 input 单价`)
  }
})

test("前缀回落取最长匹配 —— 互为前缀的键不会串价", async () => {
  const pricing = await defaultPricing()
  const keys = Object.keys(pricing.models)

  // 这条用例的前提是表里真的存在互为前缀的键。哪天不存在了，用例就变成
  // 对着空气成立 —— 先把前提钉死。
  const nested = keys.filter((k) => keys.some((other) => other !== k && k.startsWith(other)))
  assert.ok(
    nested.length > 0,
    "价目表里已经没有互为前缀的键了 —— 这条用例失去了意义，要么删掉要么换个更长的键来测"
  )

  for (const long of nested) {
    const short = keys.find((other) => other !== long && long.startsWith(other))
    const longPrice = inputUnitPrice(pricing, long)
    const shortPrice = inputUnitPrice(pricing, short)
    if (longPrice === shortPrice) continue // 两者同价，串了也看不出来，跳过

    // 带后缀的变体必须落在长键上，而不是被短键截胡。
    assert.equal(
      inputUnitPrice(pricing, `${long}-20260101`),
      longPrice,
      `${long}-20260101 应按 ${long} 计价，不是 ${short}`
    )
  }
})

test("带日期后缀的模型 id 仍然能回落到别名单价", async () => {
  const pricing = await defaultPricing()
  assert.equal(
    inputUnitPrice(pricing, "claude-haiku-4-5-20251001"),
    inputUnitPrice(pricing, "claude-haiku-4-5")
  )
})

test("表里没有的模型标记为 unknown 并走 default", async () => {
  const pricing = await defaultPricing()
  const { unknown, amount } = calculateCost(pricing, "totally-made-up-model", { input: 1_000_000 })
  assert.equal(unknown, true)
  assert.equal(amount, pricing.default.input)
})
