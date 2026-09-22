import test from "node:test"
import assert from "node:assert/strict"
import { emptyUsage, recordTurn, readUsageStore } from "../src/usage/usage-meter.mjs"
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
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

test('asynchronous title usage and concurrent turns never overwrite usage or add fake turns', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-usage-aux-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => recordTurn({ sessionId: 'session', usage: { input: 10, output: 2 }, cost: 1, countTurn: index % 2 === 0 })))
    const value = await readUsageStore()
    assert.equal(value.sessions.session.input, 200)
    assert.equal(value.sessions.session.output, 40)
    assert.equal(value.sessions.session.turns, 10)
    assert.equal(value.global.cost, 20)
    assert.equal(value.global.turns, 10)
  } finally { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) }
})
