import test from "node:test"
import assert from "node:assert/strict"
import { renderPublicModeContract, resolveMode, routeMode } from "../src/session/engine.mjs"
import { classifyTaskMode } from "../src/session/longagent-utils.mjs"

test("routing keeps long narrative local when the task is a single command check", () => {
  const prompt = [
    "Context: the repo recently had CI noise across several packages, but I do not need a rewrite or deep refactor.",
    "I only want one bounded step right now: run `npm test -- --help` and tell me whether the CLI accepts passthrough args.",
    "Do not redesign anything, just inspect that single command outcome and summarize it."
  ].join(" ")
  const result = classifyTaskMode(prompt.repeat(3))
  assert.notEqual(result.mode, "longagent")
  assert.ok(["local_lookup_task", "short_local_task_protected", "local_transaction_task", "single_path_or_command_task"].includes(result.reason))
})

test("routing treats single-directory inspection as assistant work instead of longagent", () => {
  const classification = classifyTaskMode("Check the logs under ./logs and summarize the most recent failure signatures.")
  assert.equal(classification.mode, "assistant")
  assert.notEqual(classification.reason, "multi_file_or_system_task")
})

test("resolveMode defaults to assistant and keeps code aliases on the coding lane", () => {
  assert.equal(resolveMode(), "assistant")
  assert.equal(resolveMode("unknown"), "assistant")
  assert.equal(resolveMode("assistant"), "assistant")
  assert.equal(resolveMode("code"), "agent")
  assert.equal(resolveMode("coding"), "agent")
})

test("routeMode routes default assistant coding work to agent", () => {
  const route = routeMode("Fix the failing tests in ./test/mode-routing.test.mjs and verify npm test.", "assistant")
  assert.equal(route.mode, "agent")
  assert.equal(route.changed, true)
  assert.match(route.reason, /(local_transaction_task|short_local_task_protected|simple_action_task)/)
})

test("routeMode keeps bounded terminal assistant work in assistant", () => {
  const route = routeMode("Check ./logs and summarize the latest errors.", "assistant")
  assert.equal(route.mode, "assistant")
  assert.equal(route.changed, false)
  assert.match(route.reason, /(local_lookup_task|single_path_or_command_task)/)
})

test("routeMode suggests longagent for cross-file implementation while preserving current agent mode", () => {
  const route = routeMode(
    "Implement a full end-to-end billing subsystem across checkout, invoicing, and reporting modules.",
    "agent"
  )

  assert.equal(route.mode, "agent")
  assert.equal(route.changed, false)
  assert.equal(route.suggestion, "longagent")
  assert.equal(route.reason, "multi_file_or_system_task")
  assert.equal(route.upgradePath, "agent->longagent")
  assert.match(route.evidenceSummary, /cross_file_scope/)
})

test("routeMode auto-switches short explain questions from agent to assistant", () => {
  const route = routeMode("What does src/session/engine.mjs do?", "agent")
  assert.equal(route.mode, "assistant")
  assert.equal(route.changed, true)
  assert.match(route.reason, /(question_with_explain_intent|short_question)/)
})

test("routeMode keeps inspect + patch + verify loops in agent with evidence categories", () => {
  const route = routeMode(
    "Check ./logs/app.log, patch README.md with the right command, and verify `npm test -- --help` still works.",
    "agent"
  )

  assert.equal(route.mode, "agent")
  assert.equal(route.changed, false)
  assert.equal(route.reason, "short_local_task_protected")
  assert.ok(route.evidence.includes("inspect_patch_verify_loop"))
  assert.ok(route.evidence.includes("bounded_local_scope"))
  assert.match(route.topologySummary, /bounded_local_transaction/)
  assert.match(route.evidenceSummary, /inspect_patch_verify_loop/)
})

test("routeMode keeps plan explicit and mutation-free as a public contract", () => {
  const route = routeMode("Plan a safe refactor for the tool registry.", "plan")
  assert.equal(route.mode, "plan")
  assert.equal(route.changed, false)
  assert.equal(route.reason, "plan_mode_exempt")
  assert.equal(route.continuity, "new_transaction")
})

test("renderPublicModeContract keeps public lanes aligned", () => {
  const text = renderPublicModeContract()
  assert.match(text, /`assistant`: default CLI personal assistant lane/i)
  assert.doesNotMatch(text, /`ask`:/i)
  assert.match(text, /`plan`: produce a spec\/plan only/i)
  assert.match(text, /`agent` \/ `code` \/ `coding`: dedicated coding lane/i)
  assert.match(text, /`longagent`: heavyweight staged multi-file delivery lane/i)
})
