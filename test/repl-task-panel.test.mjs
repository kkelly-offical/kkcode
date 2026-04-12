import test from "node:test"
import assert from "node:assert/strict"
import { renderTaskProgressPanel } from "../src/ui/repl-task-panel.mjs"

test("renderTaskProgressPanel delegates to formatter", () => {
  const lines = renderTaskProgressPanel({ a: { status: "completed" } }, () => ["ok"])
  assert.deepEqual(lines, ["ok"])
})
