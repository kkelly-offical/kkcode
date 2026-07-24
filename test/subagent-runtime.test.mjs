import test from "node:test"
import assert from "node:assert/strict"
import { tightenPermissionConfig } from "../src/session/loop.mjs"
import { agentPrompt } from "../src/session/system-prompt.mjs"

test("subagent permission may tighten but never elevate global permission", () => {
  const base = { permission: { level: "edit", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(base, "readonly").permission.level, "readonly")
  assert.equal(tightenPermissionConfig(base, "yolo").permission.level, "edit")
  assert.equal(base.permission.level, "edit")
})

test("inline subagent prompt is honored", async () => {
  assert.equal(await agentPrompt({ name: "reviewer", prompt: "Review only." }), "Review only.")
})
