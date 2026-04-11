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
  assert.deepEqual(result, { error: "task.prompt or task.objective is required when session_id is not provided" })
})

test("task delegate requires write_scope and deliverable for synthesized briefs", async () => {
  const delegateTask = createTaskDelegate({
    config: {},
    parentSessionId: "parent_structured_validation",
    model: "gpt-test",
    providerType: "local",
    runSubtask: async () => {
      throw new Error("should not run")
    }
  })

  assert.deepEqual(
    await delegateTask({ objective: "Audit routing heuristics" }),
    { error: "task.write_scope is required when synthesizing a new delegation brief" }
  )

  assert.deepEqual(
    await delegateTask({ objective: "Audit routing heuristics", write_scope: "read-only" }),
    { error: "task.deliverable is required when synthesizing a new delegation brief" }
  )
})

test("task delegate synthesizes a directive brief from structured delegation fields", async () => {
  let received = null
  const delegateTask = createTaskDelegate({
    config: {},
    parentSessionId: "parent_structured",
    model: "gpt-parent",
    providerType: "local",
    runSubtask: async (payload) => {
      received = payload
      return { reply: "structured done", toolEvents: [] }
    }
  })

  const result = await delegateTask({
    objective: "Audit the routing heuristics",
    why: "Need a bounded sidecar review before changing the CLI routing layer",
    write_scope: "read-only",
    starting_points: ["src/session/engine.mjs", "test/longagent-utils.test.mjs"],
    constraints: ["Do not edit files", "Focus on ask/agent/longagent boundaries"],
    planned_files: ["src/session/engine.mjs"],
    deliverable: "Return a concise findings summary with recommended follow-ups",
    subagent_type: "explore"
  })

  assert.ok(received)
  assert.match(received.prompt, /Objective: Audit the routing heuristics/)
  assert.match(received.prompt, /Why: Need a bounded sidecar review before changing the CLI routing layer/)
  assert.match(received.prompt, /Write scope: read-only/)
  assert.match(received.prompt, /Starting points:\n- src\/session\/engine\.mjs\n- test\/longagent-utils\.test\.mjs/)
  assert.match(received.prompt, /Constraints:\n- Do not edit files\n- Focus on ask\/agent\/longagent boundaries/)
  assert.match(received.prompt, /Planned files:\n- src\/session\/engine\.mjs/)
  assert.match(received.prompt, /Deliverable: Return a concise findings summary with recommended follow-ups/)
  assert.match(received.prompt, /Execution contract:\n- Stay local instead of delegating if a direct read\/edit\/run action would finish the next step faster\./)
  assert.equal(received.subagent.name, "explore")
  assert.equal(result.reply, "structured done")
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
    prompt: "Continue the same delegated slice and return a concise update.",
    allow_question: true
  })

  assert.equal(received.sessionId, "sub_existing")
  assert.equal(received.prompt, "Continue the same delegated slice and return a concise update.")
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
    tool_events: 2,
    file_changes: [],
    edit_feedback: []
  })
})

test("task delegate rejects structured brief fields when continuing an existing sub-session", async () => {
  const delegateTask = createTaskDelegate({
    config: {},
    parentSessionId: "parent_cont_structured",
    model: "gpt-parent",
    providerType: "local",
    runSubtask: async () => {
      throw new Error("should not run")
    }
  })

  const result = await delegateTask({
    session_id: "sub_existing",
    objective: "Continue investigating the delegated slice"
  })

  assert.deepEqual(result, {
    error: "task.session_id cannot be combined with structured brief fields; use a short continuation prompt instead"
  })
})

test("task delegate rejects execution_mode when continuing an existing sub-session", async () => {
  const delegateTask = createTaskDelegate({
    config: {},
    parentSessionId: "parent_cont_mode",
    model: "gpt-parent",
    providerType: "local",
    runSubtask: async () => {
      throw new Error("should not run")
    }
  })

  const result = await delegateTask({
    session_id: "sub_existing",
    prompt: "Continue the delegated work.",
    execution_mode: "fork_context"
  })

  assert.deepEqual(result, {
    error: "task.execution_mode only applies when starting a new delegated session"
  })
})

test("task delegate reserves fork_context for read-only sidecar work", async () => {
  const delegateTask = createTaskDelegate({
    config: {},
    parentSessionId: "parent_fork_guard",
    model: "gpt-parent",
    providerType: "local",
    runSubtask: async () => {
      throw new Error("should not run")
    }
  })

  const result = await delegateTask({
    objective: "Implement the feature directly in the delegated slice",
    write_scope: "modify src/tool/task-tool.mjs",
    deliverable: "return a patch",
    execution_mode: "fork_context"
  })

  assert.deepEqual(result, {
    error: "task.execution_mode=fork_context is reserved for read-only sidecar work; use fresh_agent for implementation"
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
  assert.deepEqual(result.file_changes, [])
  assert.deepEqual(result.edit_feedback, [])
})

test("task delegate surfaces file_changes and edit_feedback from mutation tool events", async () => {
  const delegateTask = createTaskDelegate({
    config: {},
    parentSessionId: "parent_4",
    model: "gpt-parent",
    providerType: "local",
    runSubtask: async () => ({
      reply: "done",
      toolEvents: [{
        name: "edit",
        status: "completed",
        args: { path: "src/demo.mjs" },
        metadata: {
          fileChanges: [{
            path: "src/demo.mjs",
            addedLines: 2,
            removedLines: 1,
            stageId: "stage_1",
            taskId: "task_1"
          }],
          mutation: {
            operation: "edit",
            filePath: "src/demo.mjs",
            addedLines: 2,
            removedLines: 1
          },
          diagnostics: {
            contract: "kkcode/edit-diagnostics@1",
            files: ["src/demo.mjs"],
            summary: { status: "clean", text: "clean (no diagnostics before or after)" }
          }
        }
      }]
    })
  })

  const result = await delegateTask({
    prompt: "update file"
  })

  assert.deepEqual(result.file_changes, [{
    path: "src/demo.mjs",
    addedLines: 2,
    removedLines: 1,
    stageId: "stage_1",
    taskId: "task_1"
  }])
  assert.equal(result.edit_feedback.length, 1)
  assert.equal(result.edit_feedback[0].tool, "edit")
  assert.equal(result.edit_feedback[0].diagnostics.summary.status, "clean")
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
      allow_question: false
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
    assert.equal(launchArgs.payload.allowQuestion, false)
  } finally {
    BackgroundManager.launchDelegateTask = originalLaunchDelegateTask
  }
})

test("task delegate rejects interactive questions for background sidecar work", async () => {
  const delegateTask = createTaskDelegate({
    config: { background: { mode: "worker_process" } },
    parentSessionId: "parent_bg_question",
    model: "gpt-parent",
    providerType: "local",
    runSubtask: async () => {
      throw new Error("should not run")
    }
  })

  const result = await delegateTask({
    prompt: "run sidecar verification",
    run_in_background: true,
    allow_question: true
  })

  assert.deepEqual(result, {
    error: "task.run_in_background does not support allow_question=true"
  })
})
