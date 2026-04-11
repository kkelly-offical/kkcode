import test from "node:test"
import assert from "node:assert/strict"
import { buildRouteFeedback } from "../src/ui/repl-route-feedback.mjs"

test("buildRouteFeedback renders the changed-lane message", () => {
  const feedback = buildRouteFeedback({
    currentMode: "agent",
    routeSummary: "topology=bounded_lookup; evidence=question_intent",
    route: {
      mode: "ask",
      changed: true,
      reason: "short_question",
      explanation: "检测到简短问答"
    }
  })

  assert.match(feedback.changedMessage, /自动切换到 ask（问答） 模式/)
  assert.match(feedback.summaryMessage, /topology=bounded_lookup/)
})

test("buildRouteFeedback renders the longagent suggestion message without changing mode", () => {
  const feedback = buildRouteFeedback({
    currentMode: "agent",
    routeSummary: "topology=heavy_multi_file_delivery; evidence=cross_file_scope",
    route: {
      mode: "agent",
      changed: false,
      suggestion: "longagent",
      reason: "multi_file_or_system_task",
      explanation: "检测到跨文件 / 系统级任务"
    }
  })

  assert.equal(feedback.changedMessage, null)
  assert.match(feedback.suggestionMessage, /可以用 \/longagent 切换到 longagent 模式/)
  assert.equal(feedback.stayedMessage, null)
})
