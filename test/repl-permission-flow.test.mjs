import test from "node:test"
import assert from "node:assert/strict"
import { POLICY_CHOICES, createPolicyPickerState, applyPolicyChoice } from "../src/repl/permission-flow.mjs"

test("createPolicyPickerState selects current policy", () => {
  assert.deepEqual(createPolicyPickerState("deny"), { selected: 2 })
})

test("applyPolicyChoice updates default policy", () => {
  const result = applyPolicyChoice(POLICY_CHOICES[1], { permissionConfig: { default_policy: "ask" } })
  assert.equal(result.message, "permission policy → allow")
  assert.equal(result.permissionConfig.default_policy, "allow")
})

test("applyPolicyChoice clears session grants", () => {
  let cleared = null
  const result = applyPolicyChoice(POLICY_CHOICES[3], {
    sessionId: "sid_1",
    clearSession(id) {
      cleared = id
    }
  })
  assert.equal(cleared, "sid_1")
  assert.equal(result.message, "permission session cache cleared")
})
