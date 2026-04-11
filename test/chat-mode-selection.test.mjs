import test from "node:test"
import assert from "node:assert/strict"
import { resolveChatExecutionMode } from "../src/commands/chat.mjs"

test("resolveChatExecutionMode auto-routes clear questions into ask mode", () => {
  const resolved = resolveChatExecutionMode("What files handle routing in this project?", "agent")
  assert.equal(resolved.requestedMode, "agent")
  assert.equal(resolved.effectiveMode, "ask")
  assert.equal(resolved.route.changed, true)
  assert.ok(["question_with_explain_intent", "short_question"].includes(resolved.route.reason))
  assert.match(resolved.route.explanation, /问答|解释/)
})

test("resolveChatExecutionMode keeps agent mode for bounded local edits and carries explanation", () => {
  const resolved = resolveChatExecutionMode("Update README.md with one extra example and verify the command still works.", "agent")
  assert.equal(resolved.effectiveMode, "agent")
  assert.equal(resolved.route.changed, false)
  assert.ok(["short_local_task_protected", "local_transaction_task", "single_path_or_command_task"].includes(resolved.route.reason))
  assert.match(resolved.route.explanation, /本地事务|轻量|longagent/)
})
