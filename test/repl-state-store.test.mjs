import test from "node:test"
import assert from "node:assert/strict"
import { collectMcpSummary, collectSkillSummary } from "../src/repl/state-store.mjs"

test("collectMcpSummary aggregates health and tool counts", () => {
  const summary = collectMcpSummary({
    healthSnapshot() {
      return [{ name: "alpha", ok: true }, { name: "beta", ok: false }]
    },
    listTools() {
      return [{ server: "alpha" }, { server: "alpha" }, { server: "beta" }]
    }
  })
  assert.equal(summary.configured, 2)
  assert.equal(summary.healthy, 1)
  assert.equal(summary.tools, 3)
  assert.deepEqual(summary.byServer, { alpha: 2, beta: 1 })
})

test("collectSkillSummary groups skill types", () => {
  const summary = collectSkillSummary({
    isReady() {
      return true
    },
    list() {
      return [
        { type: "template" },
        { type: "skill_md" },
        { type: "mcp_prompt" },
        { type: "mjs" },
        { type: "skill_md" }
      ]
    }
  })
  assert.deepEqual(summary, {
    total: 5,
    template: 1,
    skillMd: 2,
    mcpPrompt: 1,
    programmable: 1
  })
})
