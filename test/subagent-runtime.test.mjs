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

test("a removed global level tightens from the default tier, not its old meaning", () => {
  // "edit" 曾映射到 accept-edits。0.6.0 移除后它不再有任何含义 ——
  // 收紧的起点是默认档，子智能体不会因为一个失效的旧名拿到更宽的权限。
  const base = { permission: { level: "edit", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(base, "yolo").permission.level, "manual")
})

test("agent permission vocabulary maps instead of collapsing to one level", () => {
  // 0.3.x normalizePermissionLevel did not recognise full/none and silently
  // degraded both to the same level.
  const wide = { permission: { level: "yolo", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(wide, "none").permission.level, "readonly")
  assert.equal(tightenPermissionConfig(wide, "default").permission.level, "manual")

  // tightening still only ever narrows relative to the global level
  const narrow = { permission: { level: "manual", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(narrow, "readonly").permission.level, "readonly")
})

test("an agent declaring full inherits the global level instead of capping it", () => {
  // assistant and ultra both declare permission: "full". Treating that as a
  // concrete level made YOLO a lie: min("accept-edits", "yolo") is
  // accept-edits, so shell commands were still refused in YOLO mode.
  const yolo = { permission: { level: "yolo", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(yolo, "full").permission.level, "yolo")

  const manual = { permission: { level: "manual", non_tty_default: "deny" } }
  assert.equal(tightenPermissionConfig(manual, "full").permission.level, "manual")

  // plan still pins itself to readonly regardless of the global level
  assert.equal(tightenPermissionConfig(yolo, "readonly").permission.level, "readonly")
})

test("inline subagent prompt is honored", async () => {
  assert.equal(await agentPrompt({ name: "reviewer", prompt: "Review only." }), "Review only.")
})
