import test from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"

const TEST_CONFIG = {
  tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
  mcp: { auto_discover: false },
  runtime: {}
}

test("task lifecycle tools expose delegated background task summaries", async () => {
  const originalList = BackgroundManager.list
  const originalGet = BackgroundManager.get
  const originalCancel = BackgroundManager.cancel

  BackgroundManager.list = async () => [{
    id: "bg_1",
    description: "review delegated slice",
    status: "running",
    attempt: 1,
    payload: { subagent: "reviewer", executionMode: "fresh_agent", subSessionId: "sub_1" },
    logs: ["started"],
    result: null,
    error: null
  }]
  BackgroundManager.get = async () => ({
    id: "bg_1",
    description: "review delegated slice",
    status: "completed",
    attempt: 1,
    payload: { subagent: "reviewer", executionMode: "fresh_agent", subSessionId: "sub_1" },
    logs: ["started", "done"],
    result: { reply: "completed review" },
    error: null
  })
  BackgroundManager.cancel = async () => true

  try {
    await ToolRegistry.initialize({ config: TEST_CONFIG, cwd: process.cwd(), force: true })
    const byName = Object.fromEntries(await Promise.all(
      ["task_list", "task_get", "task_stop", "task_output"].map(async (name) => [name, await ToolRegistry.get(name)])
    ))

    const listed = await byName.task_list.execute({}, { cwd: process.cwd(), config: TEST_CONFIG })
    assert.equal(Array.isArray(listed), true)
    assert.equal(listed[0].id, "bg_1")
    assert.equal(listed[0].subagent, "reviewer")

    const got = await byName.task_get.execute({ task_id: "bg_1" }, { cwd: process.cwd(), config: TEST_CONFIG })
    assert.equal(got.id, "bg_1")
    assert.equal(got.result.reply, "completed review")

    const stopped = await byName.task_stop.execute({ task_id: "bg_1" }, { cwd: process.cwd(), config: TEST_CONFIG })
    assert.equal(stopped, "cancel requested")

    const output = await byName.task_output.execute({ task_id: "bg_1" }, { cwd: process.cwd(), config: TEST_CONFIG })
    assert.equal(output.id, "bg_1")
    assert.equal(output.result.reply, "completed review")
  } finally {
    BackgroundManager.list = originalList
    BackgroundManager.get = originalGet
    BackgroundManager.cancel = originalCancel
  }
})
