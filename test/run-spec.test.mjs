import test from "node:test"
import assert from "node:assert/strict"
import { createRunSpec, runSpecRole } from "../src/orchestration/run-spec.mjs"

test("RunSpec is immutable and normalizes role execution fields", () => {
  const spec = createRunSpec({
    sessionId: "child",
    parentSessionId: "parent",
    role: { name: "review", prompt: "Review.", tools: ["read"], permission: "readonly", maxTurns: 4 },
    workspace: { root: "/repo", writeScope: "read-only" }
  })
  assert.equal(spec.role.maxSteps, 4)
  assert.equal(runSpecRole(spec).maxTurns, 4)
  assert.equal(Object.isFrozen(spec), true)
  assert.equal(Object.isFrozen(spec.role), true)
  assert.throws(() => { spec.role.name = "changed" }, TypeError)
})
