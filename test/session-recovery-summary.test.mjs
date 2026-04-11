import test from "node:test"
import assert from "node:assert/strict"
import { summarizeResumeContext } from "../src/session/recovery.mjs"

test("summarizeResumeContext reports in-progress sessions clearly", () => {
  const summary = summarizeResumeContext({
    lastPrompt: "Continue the interrupted transaction with one more verification pass.",
    messageCount: 12,
    retryMeta: {
      inProgress: true,
      turnId: "turn_123",
      step: 3
    },
    canResume: true,
    canRetry: false
  })

  assert.equal(summary.status, "in-progress")
  assert.equal(summary.retryStep, 3)
  assert.equal(summary.turnId, "turn_123")
  assert.match(summary.lastPromptPreview, /Continue the interrupted transaction/)
})

test("summarizeResumeContext reports retryable errors distinctly", () => {
  const summary = summarizeResumeContext({
    lastPrompt: "Retry the failed turn.",
    messageCount: 8,
    retryMeta: {
      inProgress: false,
      failedAt: Date.now()
    },
    canResume: true,
    canRetry: true
  })

  assert.equal(summary.status, "retryable-error")
  assert.equal(summary.canRetry, true)
})
