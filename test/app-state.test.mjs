import test from "node:test"
import assert from "node:assert/strict"
import { createAppState, reduceAppState, responsiveTier } from "../src/ui/app-state.mjs"

test("app state follows turn and tool lifecycle", () => {
  let state = createAppState()
  state = reduceAppState(state, { type: "turn.start", sessionId: "s1", turnId: "t1" })
  assert.equal(state.phase, "connecting")
  state = reduceAppState(state, { type: "stream.thinking.delta", payload: { text: "inspect" } })
  state = reduceAppState(state, { type: "tool.start", payload: { tool: "read" } })
  assert.equal(state.phase, "tool_running")
  state = reduceAppState(state, { type: "tool.finish", payload: { tool: "read", status: "completed" } })
  assert.equal(state.phase, "thinking")
  assert.equal(state.transcript[0].text, "inspect")
})

test("stream chunks are invariant under chunking", () => {
  const reduceChunks = (chunks) => chunks.reduce(
    (state, text) => reduceAppState(state, { type: "stream.text.delta", payload: { text } }),
    createAppState()
  )
  assert.equal(reduceChunks(["hello"]).transcript[0].text, reduceChunks(["he", "ll", "o"]).transcript[0].text)
})

test("retrying returns to thinking and reaches terminal phases", () => {
  let state = reduceAppState(createAppState(), {
    type: "provider.retry",
    payload: { retryAttempt: 1, maxRetries: 5 }
  })
  assert.equal(state.phase, "retrying")
  state = reduceAppState(state, { type: "turn.step.start", payload: { step: 1 } })
  assert.equal(state.phase, "thinking")
  state = reduceAppState(state, { type: "turn.error", payload: { error: "offline" } })
  assert.equal(state.phase, "failed")
})

test("responsive tiers protect narrow terminals", () => {
  assert.equal(responsiveTier(120), "full")
  assert.equal(responsiveTier(80), "compact")
  assert.equal(responsiveTier(40), "minimal")
})
