import test from "node:test"
import assert from "node:assert/strict"
import { createRunSpec, runSpecRole } from "../src/kernel/orchestration/run-spec.mjs"

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

test('RunSpec preserves zero ceilings and rejects invalid/unbounded numeric limits', () => {
  assert.equal(createRunSpec({ limits: { budgetUsd: 0, deadlineAt: 0 } }).limits.budgetUsd, 0)
  assert.equal(createRunSpec({ limits: { budgetUsd: 0, deadlineAt: 0 } }).limits.deadlineAt, 0)
  for (const value of [NaN, Infinity, -1]) assert.throws(() => createRunSpec({ limits: { budgetUsd: value } }), /finite nonnegative/)
})
