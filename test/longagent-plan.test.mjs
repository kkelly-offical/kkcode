import test from "node:test"
import assert from "node:assert/strict"
import { defaultStagePlan, validateAndNormalizeStagePlan } from "../src/session/longagent-plan.mjs"

test("defaultStagePlan returns single-stage executable plan", () => {
  const plan = defaultStagePlan("build a CLI")
  assert.ok(plan.planId)
  assert.equal(plan.objective, "build a CLI")
  assert.equal(plan.stages.length, 1)
  assert.equal(plan.stages[0].passRule, "all_success")
  assert.equal(plan.stages[0].tasks.length, 1)
  assert.equal(typeof plan.stages[0].tasks[0].prompt, "string")
})

test("validateAndNormalizeStagePlan falls back when invalid", () => {
  const { plan, errors } = validateAndNormalizeStagePlan(
    { planId: "x", objective: "", stages: [] },
    { objective: "ship feature" }
  )
  assert.ok(errors.length > 0)
  assert.equal(plan.objective, "ship feature")
  assert.equal(plan.stages.length, 1)
})

test("validateAndNormalizeStagePlan normalizes tasks", () => {
  const { plan, errors } = validateAndNormalizeStagePlan({
    planId: "p1",
    objective: "upgrade app",
    stages: [
      {
        id: "s1",
        name: "phase 1",
        tasks: [
          {
            id: "t1",
            prompt: "edit files",
            plannedFiles: ["a.ts", "a.ts", "b.ts"],
            acceptance: ["tests pass", ""]
          }
        ]
      }
    ]
  })
  assert.equal(errors.length, 0)
  assert.equal(plan.stages[0].tasks[0].taskId, "t1")
  assert.deepEqual(plan.stages[0].tasks[0].plannedFiles, ["a.ts", "b.ts"])
  assert.deepEqual(plan.stages[0].tasks[0].acceptance, ["tests pass"])
})

