import test from "node:test"
import assert from "node:assert/strict"
import { classifyTaskMode } from "../src/session/longagent-utils.mjs"
import { resolvePromptMode } from "../src/session/engine.mjs"

test("complex multi-file refactors still classify as longagent", () => {
  const prompt = "Refactor the routing, background orchestration, and plugin manifest flow across the entire repo, update tests, and deliver a staged migration plan."
  const classification = classifyTaskMode(prompt)

  assert.equal(classification.mode, "longagent")
  assert.equal(classification.reason, "multi_file_or_system_task")
})

test("long but bounded local tasks stay out of longagent when the work is still transactional", () => {
  const prompt = "Check ./logs/app.log, inspect package.json and README.md, summarize the latest release mismatch, then update NOTICE.md with the corrected version note."
  const resolved = resolvePromptMode(prompt, "agent")

  assert.equal(resolved.effectiveMode, "agent")
  assert.notEqual(resolved.route.reason, "multi_file_or_system_task")
})
