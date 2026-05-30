import test from "node:test"
import assert from "node:assert/strict"
import { resolveChatExecutionMode } from "../src/commands/chat.mjs"

test("resolveChatExecutionMode treats agent as unified assistant compatibility", () => {
  const resolved = resolveChatExecutionMode("What files handle routing in this project?", "agent")
  assert.equal(resolved.requestedMode, "assistant")
  assert.equal(resolved.effectiveMode, "assistant")
  assert.equal(resolved.route.changed, false)
  assert.ok(["question_with_explain_intent", "short_question"].includes(resolved.route.reason))
  assert.match(resolved.route.explanation, /问答|解释/)
})

test("resolveChatExecutionMode keeps bounded local edits in unified assistant and carries explanation", () => {
  const resolved = resolveChatExecutionMode("Update README.md with one extra example and verify the command still works.", "agent")
  assert.equal(resolved.effectiveMode, "assistant")
  assert.equal(resolved.route.changed, false)
  assert.ok(["short_local_task_protected", "local_transaction_task", "single_path_or_command_task"].includes(resolved.route.reason))
  assert.match(resolved.route.explanation, /本地事务|轻量|longagent/)
})
