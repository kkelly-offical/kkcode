import test from "node:test"
import assert from "node:assert/strict"
import { buildAgentContinuationPrompt, summarizeAgentTransaction } from "../src/session/agent-transaction.mjs"

test("summarizeAgentTransaction captures bounded task hints", () => {
  const summary = summarizeAgentTransaction({
    prompt: "Check ./logs/app.log, patch README.md with the right `npm test -- --help` example, then verify it.",
    route: {
      reason: "short_local_task_protected",
      explanation: "检测到短小本地事务，避免升级到 longagent",
      evidence: ["local_task_signal", "mutation_signal", "path_hint", "single_command", "inspect_patch_verify_loop"]
    }
  })

  assert.match(summary.objective, /Check \.\/logs\/app\.log/)
  assert.deepEqual(summary.paths, ["./logs/app.log", "README.md"])
  assert.deepEqual(summary.commands, ["npm test -- --help"])
  assert.equal(summary.routeReason, "short_local_task_protected")
  assert.match(summary.pendingNextStep, /npm test -- --help/)
})

test("buildAgentContinuationPrompt preserves transaction identity and supplement", () => {
  const prompt = buildAgentContinuationPrompt({
    prompt: "Inspect src/session/engine.mjs and update one route explanation.",
    objective: "Inspect src/session/engine.mjs and update one route explanation.",
    paths: ["src/session/engine.mjs"],
    commands: [],
    routeReason: "single_path_or_command_task",
    routeExplanation: "检测到单路径或单命令任务，适合保持在轻量路径",
    evidence: ["path_hint", "bounded_local_scope"],
    pendingNextStep: "Continue the interrupted local task around src/session/engine.mjs."
  }, "Also keep the output wording aligned with the prompt.")

  assert.match(prompt, /\[Interrupted agent transaction\]/)
  assert.match(prompt, /Paths: src\/session\/engine\.mjs/)
  assert.match(prompt, /Last route reason: single_path_or_command_task/)
  assert.match(prompt, /same bounded local agent transaction/)
  assert.match(prompt, /\[User continuation\]\nAlso keep the output wording aligned with the prompt\./)
})
