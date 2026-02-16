import test from "node:test"
import assert from "node:assert/strict"
import { emptyUsage } from "../src/usage/usage-meter.mjs"
import { calculateCost } from "../src/usage/pricing.mjs"

test("empty usage shape", () => {
  const usage = emptyUsage()
  assert.deepEqual(usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0
  })
})

test("cost calculation honors model pricing", () => {
  const pricing = {
    per_tokens: 1000000,
    currency: "USD",
    models: {
      "anthropic/claude-sonnet-4.5": {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_write: 3.75
      }
    },
    default: { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  }
  const result = calculateCost(pricing, "anthropic/claude-sonnet-4.5", {
    input: 1000,
    output: 2000,
    cacheRead: 100,
    cacheWrite: 0
  })
  assert.ok(result.amount > 0)
  assert.equal(result.unknown, false)
})
