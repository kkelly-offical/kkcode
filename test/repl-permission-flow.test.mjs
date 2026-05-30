import test from "node:test"
import assert from "node:assert/strict"
import { POLICY_CHOICES, createPolicyPickerState, applyPolicyChoice, nextPermissionLevel } from "../src/repl/permission-flow.mjs"

test("createPolicyPickerState selects current permission mode", () => {
  assert.deepEqual(createPolicyPickerState({ level: "yolo", mode: "yolo", default_policy: "ask" }), { selected: 5 })
})

test("applyPolicyChoice updates permission level", () => {
  const result = applyPolicyChoice(POLICY_CHOICES[2], { permissionConfig: { default_policy: "ask" } })
  assert.equal(result.message, "permission level → auto")
  assert.equal(result.permissionConfig.level, "auto")
  assert.equal(result.permissionConfig.mode, "auto")
})

test("nextPermissionLevel cycles through the fixed permission order", () => {
  assert.equal(nextPermissionLevel({ level: "readonly" }), "review")
  assert.equal(nextPermissionLevel({ level: "yolo" }), "readonly")
})

test("applyPolicyChoice clears session grants", () => {
  let cleared = null
  const result = applyPolicyChoice(POLICY_CHOICES[6], {
    sessionId: "sid_1",
    clearSession(id) {
      cleared = id
    }
  })
  assert.equal(cleared, "sid_1")
  assert.equal(result.message, "permission session cache cleared")
})
