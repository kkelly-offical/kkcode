import test from "node:test"
import assert from "node:assert/strict"
import { createTaskDelegate } from "../src/orchestration/task-scheduler.mjs"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"

test("task delegate requires a prompt for new delegated sessions", async () => {
  const delegateTask = createTaskDelegate({
    config: {},
    parentSessionId: "parent_1",
    model: "gpt-test",
    providerType: "local",
    runSubtask: async () => {
      throw new Error("should not run")
    }
  })

  const result = await delegateTask({})
  assert.deepEqual(result, { error: "task.prompt is required when session_id is not provided" })
})

test("task delegate reuses an existing sub-session with continuation prompt", async () => {
  let received = null
  const delegateTask = createTaskDelegate({
    config: {},
    parentSessionId: "parent_2",
    model: "gpt-parent",
    providerType: "local",
    runSubtask: async (payload) => {
      received = payload
      return { reply: "continued", toolEvents: [{}, {}] }
    }
  })

  const result = await delegateTask({
    session_id: "sub_existing",
    allow_question: true
  })

  assert.equal(received.sessionId, "sub_existing")
  assert.equal(received.prompt, "Continue from existing sub-session context.")
  assert.equal(received.model, "gpt-parent")
  assert.equal(received.providerType, "local")
  assert.equal(received.subagent.name, "default-subagent")
  assert.equal(received.allowQuestion, true)
  assert.deepEqual(result, {
    session_id: "sub_existing",
    parent_session_id: "parent_2",
    subagent: "default-subagent",
    execution_mode: "fresh_agent",
    reply: "continued",
    tool_events: 2
  })
})

test("task delegate routes foreground work through resolved subagent config", async () => {
  let received = null
  const delegateTask = createTaskDelegate({
    config: {
      agent: {
        subagents: {
          reviewer: {
            model: "gpt-review",
            providerType: "mock-provider"
          }
        }
      }
    },
    parentSessionId: "parent_3",
    model: "gpt-parent",
    providerType: "local",
    runSubtask: async (payload) => {
      received = payload
      return { reply: "done", toolEvents: [{}] }
    }
  })

  const result = await delegateTask({
    prompt: "audit this change",
    subagent_type: "reviewer"
  })

  assert.equal(received.prompt, "audit this change")
  assert.equal(received.model, "gpt-review")
  assert.equal(received.providerType, "mock-provider")
  assert.equal(received.subagent.name, "reviewer")
  assert.equal(received.allowQuestion, false)
  assert.match(received.sessionId, /^sub_parent_3_\d+$/)
  assert.equal(result.subagent, "reviewer")
  assert.equal(result.reply, "done")
  assert.equal(result.tool_events, 1)
})

test("task delegate launches background tasks with deterministic payload metadata", async () => {
  const originalLaunchDelegateTask = BackgroundManager.launchDelegateTask
  let launchArgs = null

  BackgroundManager.launchDelegateTask = async (args) => {
    launchArgs = args
    return { id: "bg_123", status: "pending" }
  }

  try {
    const delegateTask = createTaskDelegate({
      config: { background: { mode: "worker_process" } },
      parentSessionId: "parent_bg",
      model: "gpt-parent",
      providerType: "local",
      runSubtask: async () => {
        throw new Error("background lane should not run inline")
      }
    })

    const result = await delegateTask({
      prompt: "run sidecar verification",
      description: "verify branch",
      subagent_type: "reviewer",
      run_in_background: true,
      stage_id: "stage_2",
      task_id: "task_99",
      planned_files: ["src/a.mjs", "test/a.test.mjs"],
      allow_question: true
    })

    assert.deepEqual(result, {
      background_task_id: "bg_123",
      status: "pending",
      session_id: result.session_id,
      execution_mode: "fresh_agent"
    })
    assert.match(result.session_id, /^sub_parent_bg_\d+$/)
    assert.equal(launchArgs.description, "verify branch")
    assert.equal(launchArgs.payload.parentSessionId, "parent_bg")
    assert.equal(launchArgs.payload.subSessionId, result.session_id)
    assert.equal(launchArgs.payload.prompt, "run sidecar verification")
    assert.equal(launchArgs.payload.model, "gpt-parent")
    assert.equal(launchArgs.payload.providerType, "local")
    assert.equal(launchArgs.payload.subagent, "reviewer")
    assert.equal(launchArgs.payload.subagentType, "reviewer")
    assert.equal(launchArgs.payload.stageId, "stage_2")
    assert.equal(launchArgs.payload.logicalTaskId, "task_99")
    assert.deepEqual(launchArgs.payload.plannedFiles, ["src/a.mjs", "test/a.test.mjs"])
    assert.equal(launchArgs.payload.allowQuestion, true)
  } finally {
    BackgroundManager.launchDelegateTask = originalLaunchDelegateTask
  }
})
