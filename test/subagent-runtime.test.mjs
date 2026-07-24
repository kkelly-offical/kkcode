import test from "node:test"
import assert from "node:assert/strict"
import { tightenPermissionConfig } from "../src/session/loop.mjs"
import { agentPrompt } from "../src/session/system-prompt.mjs"

test("subagent permission may tighten but never elevate global permission", () => {
  const base = { permission: { level: "accept-edits", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(base, "readonly").permission.level, "readonly")
  assert.equal(tightenPermissionConfig(base, "yolo").permission.level, "accept-edits")
  assert.equal(base.permission.level, "accept-edits")
})

test("legacy global levels are normalized before tightening", () => {
  const base = { permission: { level: "edit", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(base, "yolo").permission.level, "accept-edits")
})

test("agent permission vocabulary maps instead of collapsing to one level", () => {
  // 0.3.x normalizePermissionLevel did not recognise full/none and silently
  // degraded both to the same level.
  const wide = { permission: { level: "yolo", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(wide, "full").permission.level, "accept-edits")
  assert.equal(tightenPermissionConfig(wide, "none").permission.level, "readonly")
  assert.equal(tightenPermissionConfig(wide, "default").permission.level, "manual")

  // tightening still only ever narrows relative to the global level
  const narrow = { permission: { level: "manual", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(narrow, "full").permission.level, "manual")
})

test("inline subagent prompt is honored", async () => {
  assert.equal(await agentPrompt({ name: "reviewer", prompt: "Review only." }), "Review only.")
})
