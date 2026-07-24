import test from "node:test"
import assert from "node:assert/strict"
import {
  MODE_CYCLE,
  MODE_IDS,
  APPROVAL_LEVELS,
  DEFAULT_MODE_ID,
  getMode,
  isModeId,
  laneOf,
  approvalOf,
  nextModeId,
  prevModeId,
  modeIdFromLegacy,
  isLegacyModeName,
  approvalFromLegacy,
  isLegacyApprovalName,
  approvalFromAgentPermission,
  modeIndex,
  modeIdFromLaneAndApproval
} from "../src/core/modes.mjs"

test("mode cycle exposes the five public modes in order", () => {
  assert.deepEqual(MODE_IDS, ["plan", "agent", "agent-auto", "ultra", "yolo"])
  assert.equal(MODE_CYCLE.length, 5)
  for (const mode of MODE_CYCLE) {
    assert.ok(mode.label, `${mode.id} needs a label`)
    assert.ok(mode.icon, `${mode.id} needs an icon`)
    assert.ok(mode.hint, `${mode.id} needs a hint`)
    assert.ok(APPROVAL_LEVELS.includes(mode.approval), `${mode.id} approval must be a known level`)
  }
})

test("lanes stay on the 0.3.x execution vocabulary so the runtime is untouched", () => {
  assert.equal(laneOf("plan"), "plan")
  assert.equal(laneOf("agent"), "assistant")
  assert.equal(laneOf("agent-auto"), "assistant")
  assert.equal(laneOf("ultra"), "longagent")
  assert.equal(laneOf("yolo"), "assistant")

  const lanes = new Set(MODE_CYCLE.map((mode) => mode.lane))
  assert.deepEqual([...lanes].sort(), ["assistant", "longagent", "plan"])
})

test("approval levels map to the flattened cycle", () => {
  assert.equal(approvalOf("plan"), "readonly")
  assert.equal(approvalOf("agent"), "manual")
  assert.equal(approvalOf("agent-auto"), "accept-edits")
  assert.equal(approvalOf("ultra"), "accept-edits")
  assert.equal(approvalOf("yolo"), "yolo")
})

test("Shift+Tab cycles forward through all five modes and wraps", () => {
  assert.equal(nextModeId("plan"), "agent")
  assert.equal(nextModeId("agent"), "agent-auto")
  assert.equal(nextModeId("agent-auto"), "ultra")
  assert.equal(nextModeId("ultra"), "yolo")
  assert.equal(nextModeId("yolo"), "plan")
  assert.equal(nextModeId("unknown"), "plan")
})

test("reverse cycling wraps the other way", () => {
  assert.equal(prevModeId("plan"), "yolo")
  assert.equal(prevModeId("agent"), "plan")
  assert.equal(prevModeId("unknown"), "plan")
})

test("legacy mode names keep working and collapse onto the unified agent lane", () => {
  assert.equal(modeIdFromLegacy("assistant"), "agent")
  assert.equal(modeIdFromLegacy("agent"), "agent")
  assert.equal(modeIdFromLegacy("code"), "agent")
  assert.equal(modeIdFromLegacy("coding"), "agent")
  assert.equal(modeIdFromLegacy("ask"), "agent")
  assert.equal(modeIdFromLegacy("plan"), "plan")
  assert.equal(modeIdFromLegacy("longagent"), "ultra")
  assert.equal(modeIdFromLegacy("ULTRA"), "ultra")
  assert.equal(modeIdFromLegacy("agent-auto"), "agent-auto")
  assert.equal(modeIdFromLegacy(""), null)
  assert.equal(modeIdFromLegacy("nonsense"), null)
})

test("legacy detection only flags names that are not already current ids", () => {
  assert.equal(isLegacyModeName("longagent"), true)
  assert.equal(isLegacyModeName("assistant"), true)
  assert.equal(isLegacyModeName("agent"), false)
  assert.equal(isLegacyModeName("ultra"), false)
})

test("legacy `auto` maps to manual so upgrades never silently widen permissions", () => {
  // 0.3.x `auto` meant "safe tools automatic, edits still ask" — that is the new `manual`.
  assert.equal(approvalFromLegacy("auto"), "manual")
  assert.equal(approvalFromLegacy("review"), "manual")
  assert.equal(approvalFromLegacy("readonly"), "readonly")
  assert.equal(approvalFromLegacy("edit"), "accept-edits")
  assert.equal(approvalFromLegacy("full-auto"), "accept-edits")
  assert.equal(approvalFromLegacy("yolo"), "yolo")
  assert.equal(approvalFromLegacy("unknown"), null)
})

test("new approval names are never legacy aliases of themselves", () => {
  for (const level of APPROVAL_LEVELS) {
    assert.equal(approvalFromLegacy(level), level, `${level} must be stable`)
    assert.equal(isLegacyApprovalName(level), false, `${level} must not be flagged legacy`)
  }
  assert.equal(isLegacyApprovalName("full-auto"), true)
})

test("agent definition permission vocabulary maps instead of silently degrading", () => {
  // `full` means "no extra restriction", so it must not resolve to a concrete
  // level — otherwise min() against it would knock YOLO back down to
  // accept-edits, since assistant and ultra both declare `full`.
  assert.equal(approvalFromAgentPermission("full"), null)
  assert.equal(approvalFromAgentPermission(""), null)
  assert.equal(approvalFromAgentPermission("none"), "readonly")
  assert.equal(approvalFromAgentPermission("readonly"), "readonly")
  assert.equal(approvalFromAgentPermission("default"), "manual")
  assert.equal(approvalFromAgentPermission("review"), "manual")
})

test("mode lookup helpers behave for known and unknown ids", () => {
  assert.equal(isModeId("ultra"), true)
  assert.equal(isModeId("longagent"), false)
  assert.equal(getMode("nope"), null)
  assert.equal(getMode("plan").label, "Plan")
  assert.equal(modeIndex("ultra"), 3)
  assert.equal(modeIndex("nope"), -1)
  assert.equal(DEFAULT_MODE_ID, "agent")
})

test("lane plus approval reconstructs a mode id for resumed sessions", () => {
  assert.equal(modeIdFromLaneAndApproval("longagent", "edit"), "ultra")
  assert.equal(modeIdFromLaneAndApproval("assistant", "auto"), "agent")
  assert.equal(modeIdFromLaneAndApproval("assistant", "full-auto"), "agent-auto")
  assert.equal(modeIdFromLaneAndApproval("assistant", "yolo"), "yolo")
  assert.equal(modeIdFromLaneAndApproval("plan", "anything"), "plan")
  // lane wins when the approval has no exact pairing
  assert.equal(modeIdFromLaneAndApproval("longagent", "readonly"), "ultra")
  assert.equal(modeIdFromLaneAndApproval("bogus", "manual"), "agent")
})
