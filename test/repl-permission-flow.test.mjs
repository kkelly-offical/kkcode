import test from "node:test"
import assert from "node:assert/strict"
import { POLICY_CHOICES, createPolicyPickerState, applyPolicyChoice } from "../src/repl/permission-flow.mjs"

test("createPolicyPickerState selects current permission mode", () => {
  assert.deepEqual(createPolicyPickerState({ mode: "yolo", default_policy: "ask" }), { selected: 1 })
})

test("applyPolicyChoice updates permission mode", () => {
  const result = applyPolicyChoice(POLICY_CHOICES[0], { permissionConfig: { default_policy: "ask" } })
  assert.equal(result.message, "permission mode → auto")
  assert.equal(result.permissionConfig.mode, "auto")
})

test("applyPolicyChoice updates legacy default policy through manual mode", () => {
  const result = applyPolicyChoice(POLICY_CHOICES[3], { permissionConfig: { mode: "auto", default_policy: "ask" } })
  assert.equal(result.message, "permission policy → allow")
  assert.equal(result.permissionConfig.mode, "manual")
  assert.equal(result.permissionConfig.default_policy, "allow")
})

test("applyPolicyChoice clears session grants", () => {
  let cleared = null
  const result = applyPolicyChoice(POLICY_CHOICES[5], {
    sessionId: "sid_1",
    clearSession(id) {
      cleared = id
    }
  })
  assert.equal(cleared, "sid_1")
  assert.equal(result.message, "permission session cache cleared")
})
