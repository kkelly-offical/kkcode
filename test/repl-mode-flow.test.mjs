import test from "node:test"
import assert from "node:assert/strict"
import {
  MODE_PICKER_CHOICES,
  resolveModeId,
  applyModeSelection,
  cycleModeSelection,
  createModePickerState,
  formatModeBadge,
  restoreModeId
} from "../src/repl/mode-flow.mjs"

test("the picker lists all five modes with icon, label and hint", () => {
  assert.deepEqual(MODE_PICKER_CHOICES.map((c) => c.value), [
    "plan", "agent", "agent-auto", "ultra", "yolo"
  ])
  for (const choice of MODE_PICKER_CHOICES) {
    assert.ok(choice.label.length > 1, `${choice.value} needs a label`)
    assert.ok(choice.desc, `${choice.value} needs a hint`)
  }
})

test("selecting a mode writes both the lane and the approval level", () => {
  const plan = applyModeSelection("plan", { permissionConfig: { level: "yolo", rules: [] } })
  assert.equal(plan.modeId, "plan")
  assert.equal(plan.mode, "plan")
  assert.equal(plan.approval, "readonly")
  assert.equal(plan.permissionConfig.level, "readonly")
  // unrelated permission keys survive the switch
  assert.deepEqual(plan.permissionConfig.rules, [])

  const ultra = applyModeSelection("ultra", { permissionConfig: {} })
  assert.equal(ultra.mode, "longagent")
  assert.equal(ultra.permissionConfig.level, "accept-edits")

  const yolo = applyModeSelection("yolo", { permissionConfig: {} })
  assert.equal(yolo.mode, "assistant")
  assert.equal(yolo.permissionConfig.level, "yolo")
})

test("switching modes clears the superseded legacy permission keys", () => {
  const next = applyModeSelection("agent", {
    permissionConfig: { level: "full-auto", mode: "auto", default_policy: "ask" }
  })
  assert.equal(next.permissionConfig.level, "manual")
  assert.equal(next.permissionConfig.mode, undefined)
  assert.equal(next.permissionConfig.default_policy, undefined)
})

test("Shift+Tab cycling walks every mode and returns to the start", () => {
  const seen = []
  let current = "plan"
  for (let i = 0; i < 5; i++) {
    const next = cycleModeSelection(current, { permissionConfig: {} })
    seen.push(next.modeId)
    current = next.modeId
  }
  assert.deepEqual(seen, ["agent", "agent-auto", "ultra", "yolo", "plan"])
})

test("cycling from a legacy lane name lands on the mapped mode's successor", () => {
  assert.equal(cycleModeSelection("longagent", { permissionConfig: {} }).modeId, "yolo")
  assert.equal(cycleModeSelection("assistant", { permissionConfig: {} }).modeId, "agent-auto")
})

test("unknown input falls back to the default mode rather than throwing", () => {
  assert.equal(resolveModeId("nonsense"), "agent")
  assert.equal(applyModeSelection(undefined, {}).modeId, "agent")
})

test("picker state highlights the current mode", () => {
  assert.deepEqual(createModePickerState("ultra"), { selected: 3 })
  assert.deepEqual(createModePickerState("longagent"), { selected: 3 })
  assert.deepEqual(createModePickerState("nonsense"), { selected: 1 })
})

test("badges read as icon plus label", () => {
  assert.match(formatModeBadge("ultra"), /Ultra$/)
  assert.match(formatModeBadge("agent-auto"), /Agent · Auto$/)
})

test("resumed sessions rebuild the mode id from lane plus approval", () => {
  assert.equal(restoreModeId({ mode: "longagent", permissionConfig: { level: "accept-edits" } }), "ultra")
  assert.equal(restoreModeId({ mode: "assistant", permissionConfig: { level: "auto" } }), "agent")
  assert.equal(restoreModeId({ mode: "assistant", permissionConfig: { level: "full-auto" } }), "agent-auto")
  assert.equal(restoreModeId({ mode: "assistant", permissionConfig: { level: "yolo" } }), "yolo")
  assert.equal(restoreModeId({ mode: "plan", permissionConfig: {} }), "plan")
})
