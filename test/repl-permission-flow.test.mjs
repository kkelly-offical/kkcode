import test from "node:test"
import assert from "node:assert/strict"
import { POLICY_CHOICES, createPolicyPickerState, applyPolicyChoice, applyPermissionLevel, nextPermissionLevel } from "../src/repl/permission-flow.mjs"

test("policy picker offers the four approval levels plus session clear", () => {
  assert.deepEqual(POLICY_CHOICES.map((c) => c.value), [
    "readonly",
    "manual",
    "accept-edits",
    "yolo",
    "session-clear"
  ])
})

test("createPolicyPickerState selects the current approval level", () => {
  assert.deepEqual(createPolicyPickerState({ level: "yolo" }), { selected: 3 })
  assert.deepEqual(createPolicyPickerState({ level: "manual" }), { selected: 1 })
})

test("createPolicyPickerState maps legacy levels onto the new cycle", () => {
  // 0.3.x `auto` meant edits still ask → new `manual`
  assert.deepEqual(createPolicyPickerState({ level: "auto" }), { selected: 1 })
  assert.deepEqual(createPolicyPickerState({ level: "review" }), { selected: 1 })
  assert.deepEqual(createPolicyPickerState({ level: "edit" }), { selected: 2 })
  assert.deepEqual(createPolicyPickerState({ level: "full-auto" }), { selected: 2 })
})

test("createPolicyPickerState falls back through legacy mode and default_policy", () => {
  assert.deepEqual(createPolicyPickerState({ mode: "yolo" }), { selected: 3 })
  assert.deepEqual(createPolicyPickerState({ default_policy: "deny" }), { selected: 0 })
  assert.deepEqual(createPolicyPickerState({}), { selected: 1 })
})

test("applyPolicyChoice updates permission level", () => {
  const result = applyPolicyChoice(POLICY_CHOICES[2], { permissionConfig: { default_policy: "ask" } })
  assert.equal(result.message, "permission level → accept-edits")
  assert.equal(result.permissionConfig.level, "accept-edits")
})

test("applying a level drops the superseded mode and default_policy keys", () => {
  const next = applyPermissionLevel("yolo", { level: "auto", mode: "auto", default_policy: "ask", rules: [] })
  assert.equal(next.level, "yolo")
  assert.equal(next.mode, undefined)
  assert.equal(next.default_policy, undefined)
  assert.deepEqual(next.rules, [])
})

test("nextPermissionLevel cycles through the fixed permission order", () => {
  assert.equal(nextPermissionLevel({ level: "readonly" }), "manual")
  assert.equal(nextPermissionLevel({ level: "manual" }), "accept-edits")
  assert.equal(nextPermissionLevel({ level: "accept-edits" }), "yolo")
  assert.equal(nextPermissionLevel({ level: "yolo" }), "readonly")
})

test("nextPermissionLevel accepts legacy level names", () => {
  assert.equal(nextPermissionLevel({ level: "full-auto" }), "yolo")
  assert.equal(nextPermissionLevel("review"), "accept-edits")
})

test("applyPolicyChoice clears session grants", () => {
  let cleared = null
  const result = applyPolicyChoice(POLICY_CHOICES[4], {
    sessionId: "sid_1",
    clearSession(id) {
      cleared = id
    }
  })
  assert.equal(cleared, "sid_1")
  assert.equal(result.message, "permission session cache cleared")
})
