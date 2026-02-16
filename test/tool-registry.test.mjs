import test from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "../src/tool/registry.mjs"

test("tool registry exposes task tool in agent mode", async () => {
  const tools = await ToolRegistry.list({ mode: "agent", cwd: process.cwd(), agents: ["explore", "general"] })
  assert.ok(tools.some((tool) => tool.name === "task"))
})

test("tool registry hides mutation and task tools in plan mode", async () => {
  const tools = await ToolRegistry.list({ mode: "plan", cwd: process.cwd(), agents: [] })
  assert.equal(tools.some((tool) => tool.name === "write"), false)
  assert.equal(tools.some((tool) => tool.name === "task"), false)
})
