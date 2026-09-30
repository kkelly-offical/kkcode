import test from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "../src/kernel/tool/registry.mjs"

const testConfig = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }

test("tool registry exposes task tool in agent mode", async () => {
  const tools = await ToolRegistry.list({ mode: "agent", cwd: process.cwd(), agents: ["explore", "general"], config: testConfig })
  assert.ok(tools.some((tool) => tool.name === "task"))
  for (const name of ["task_list", "task_get", "task_stop", "task_output"]) {
    assert.ok(tools.some((tool) => tool.name === name))
  }
})

test("tool registry hides project mutations but exposes guarded exploration and delegation in Plan", async () => {
  const tools = await ToolRegistry.list({ mode: "plan", cwd: process.cwd(), agents: [], config: testConfig })
  assert.equal(tools.some((tool) => tool.name === "write"), false)
  for (const name of ['bash', 'todo_read', 'todowrite', 'task', 'task_group', 'agent_list', 'agent_wait', 'agent_followup', 'agent_interrupt']) assert.ok(tools.some(tool => tool.name === name), name)
  for (const name of ['edit', 'git_restore', 'git_apply_patch']) assert.ok(!tools.some(tool => tool.name === name), name)
})
