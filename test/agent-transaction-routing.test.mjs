import test from "node:test"
import assert from "node:assert/strict"
import { classifyTaskMode, explainTaskModeReason } from "../src/session/longagent-utils.mjs"
import { routeMode } from "../src/session/engine.mjs"

test("transaction-aware routing keeps inspect + patch + verify work in agent", () => {
  const prompt = "Check ./logs/app.log, update README.md with the corrected npm command, then run npm test to verify the fix."
  const result = classifyTaskMode(prompt)

  assert.equal(result.mode, "agent")
  assert.equal(result.topology, "bounded_local_transaction")
  assert.ok(["local_transaction_task", "short_local_task_protected"].includes(result.reason))
  assert.ok(result.evidence.includes("inspect_patch_verify"))
  assert.ok(result.evidence.includes("single_command"))
  assert.ok(result.pathHints.includes("./logs/app.log"))
})

test("small tasks with planning language stay in agent when the topology is still bounded", () => {
  const prompt = "Plan the smallest README.md patch for the release note, apply it, and verify the command example still works."
  const result = classifyTaskMode(prompt)

  assert.equal(result.mode, "agent")
  assert.ok(["local_transaction_task", "short_local_task_protected"].includes(result.reason))
  assert.ok(result.evidence.includes("embedded_planning_language"))
  assert.match(explainTaskModeReason(result.reason), /本地事务|轻量/)
})

test("continuation context preserves the current transaction identity", () => {
  const route = routeMode(
    "Continue the same bounded local agent transaction unless new heavy cross-file evidence appears.\n\nCurrent objective:\nInspect README.md and package.json, then update the version note and re-run npm test.\n\nFollow-up from the user:\nAlso fix NOTICE.md while you are there.",
    "agent",
    {
      continuation: {
        objective: "Inspect README.md and package.json, then update the version note and re-run npm test."
      },
      continued: true
    }
  )

  assert.equal(route.mode, "agent")
  assert.equal(route.continuity, "continue_current_transaction")
  assert.ok(route.evidence.includes("continuation_context"))
  assert.equal(route.topology, "bounded_local_transaction")
})
