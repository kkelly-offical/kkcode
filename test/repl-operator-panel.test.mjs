import test from "node:test"
import assert from "node:assert/strict"
import { renderOperatorPanel } from "../src/ui/repl-operator-panel.mjs"

test("renderOperatorPanel formats operator actions", () => {
  const lines = renderOperatorPanel({
    recoverableCount: 2,
    activeBackground: 1,
    actions: ["bg_1: inspect output"]
  })
  assert.deepEqual(lines, [
    "operator surface:",
    "  recoverable=2",
    "  background.active=1",
    "  next: bg_1: inspect output"
  ])
})
