import test from "node:test"
import assert from "node:assert/strict"
import { buildOperatorSnapshot } from "../src/repl/operator-surface.mjs"

test("buildOperatorSnapshot summarizes recoverable sessions and next actions", () => {
  const snapshot = buildOperatorSnapshot({
    runtimeSummary: { recoverableCount: 2 },
    backgroundSummary: {
      active: 1,
      recent_terminal: [
        { id: "bg_1", next_action: "inspect output" },
        { id: "bg_2", next_action: "retry later" }
      ]
    }
  })
  assert.deepEqual(snapshot, {
    recoverableCount: 2,
    activeBackground: 1,
    actions: ["recoverable sessions available: 2", "bg_1: inspect output", "bg_2: retry later"]
  })
})
