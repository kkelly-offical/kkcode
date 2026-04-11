import test from "node:test"
import assert from "node:assert/strict"
import { createTaskTool } from "../src/tool/task-tool.mjs"

test("task tool exposes delegation-focused schema fields", () => {
  const tool = createTaskTool()
  const props = tool.inputSchema.properties

  assert.equal(tool.name, "task")
  assert.ok(props.prompt)
  assert.ok(props.objective)
  assert.ok(props.why)
  assert.ok(props.write_scope)
  assert.ok(props.starting_points)
  assert.ok(props.constraints)
  assert.ok(props.deliverable)
  assert.ok(props.subagent_type)
  assert.ok(props.execution_mode)
  assert.ok(props.run_in_background)
  assert.ok(props.session_id)
  assert.ok(props.stage_id)
  assert.ok(props.task_id)
  assert.ok(props.planned_files)
  assert.ok(props.allow_question)
})

test("task tool returns error when delegateTask is unavailable", async () => {
  const tool = createTaskTool()
  const result = await tool.execute({ prompt: "do work" }, {})
  assert.deepEqual(result, { error: "task delegate unavailable" })
})

test("task tool forwards arguments to delegateTask unchanged", async () => {
  const tool = createTaskTool()
  const args = {
    objective: "audit routing heuristics",
    why: "need a bounded sidecar review",
    write_scope: "read-only",
    starting_points: ["src/session/engine.mjs"],
    constraints: ["no edits"],
    deliverable: "findings summary",
    subagent_type: "explore",
    execution_mode: "fork_context",
    run_in_background: true,
    session_id: "sub-session",
    stage_id: "stage-1",
    task_id: "task-1",
    planned_files: ["src/a.mjs"],
    allow_question: true
  }

  let received = null
  const result = await tool.execute(args, {
    delegateTask: async (payload) => {
      received = payload
      return { ok: true, session_id: "sub-session" }
    }
  })

  assert.deepEqual(received, args)
  assert.deepEqual(result, { ok: true, session_id: "sub-session" })
})
