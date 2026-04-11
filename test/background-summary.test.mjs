import test from "node:test"
import assert from "node:assert/strict"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"

test("background summary exposes next action and concise preview for completed tasks", () => {
  const summary = BackgroundManager.summarize({
    id: "bg_done",
    description: "verify delegated slice",
    status: "completed",
    attempt: 2,
    backgroundMode: "worker_process",
    payload: {
      subagent: "reviewer",
      executionMode: "fresh_agent",
      subSessionId: "sub_123",
      parentSessionId: "ses_parent",
      stageId: "stage_2",
      logicalTaskId: "task_9"
    },
    logs: ["started", "finished"],
    result: {
      reply: "Completed the delegated review and found one follow-up change in src/tool/task-tool.mjs."
    }
  })

  assert.equal(summary.status, "completed")
  assert.equal(summary.subagent, "reviewer")
  assert.equal(summary.execution_mode, "fresh_agent")
  assert.equal(summary.log_lines, 2)
  assert.equal(summary.log_tail.length, 2)
  assert.match(summary.next_action, /background_output/i)
  assert.match(summary.result_preview, /Completed the delegated review/i)
})

test("background summary surfaces interruption guidance", () => {
  const summary = BackgroundManager.summarize({
    id: "bg_interrupted",
    description: "run sidecar verification",
    status: "interrupted",
    attempt: 1,
    backgroundMode: "worker_process",
    payload: {},
    logs: [],
    interruptionReason: "timeout",
    error: "background worker heartbeat timeout"
  })

  assert.equal(summary.interruption_reason, "timeout")
  assert.match(summary.next_action, /background retry/i)
  assert.match(summary.result_preview, /background worker heartbeat timeout/i)
})
