import test from "node:test"
import assert from "node:assert/strict"
import { renderBackgroundSummaryPanel } from "../src/ui/repl-background-panel.mjs"

test("renderBackgroundSummaryPanel formats active and terminal counts", () => {
  const lines = renderBackgroundSummaryPanel({
    active: 2,
    counts: { pending: 1, running: 1, completed: 3, interrupted: 1, error: 0 }
  })
  assert.deepEqual(lines, [
    "background=2 active (pending:1, running:1)",
    "background.terminal=completed:3 interrupted:1 error:0"
  ])
})
