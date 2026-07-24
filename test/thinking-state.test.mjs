import test from "node:test"
import assert from "node:assert/strict"
import {
  appendThinkingDelta,
  buildThinkingTranscriptItem,
  createThinkingState,
  finishThinking,
  startThinkingStream,
  startThinkingWait
} from "../src/ui/thinking-state.mjs"

test("waiting promotes to reasoning without an empty completion or timer reset", () => {
  let transition = startThinkingWait(createThinkingState(), { now: 1_000 })
  assert.equal(transition.completed, null)
  assert.deepEqual(transition.state, {
    phase: "waiting",
    startedAt: 1_000,
    raw: ""
  })

  transition = startThinkingStream(transition.state, { now: 1_400 })
  assert.equal(transition.completed, null)
  assert.equal(transition.state.phase, "streaming")
  assert.equal(transition.state.startedAt, 1_000)

  transition = appendThinkingDelta(transition.state, "inspect\nfiles", { now: 1_500 })
  transition = finishThinking(transition.state, { now: 2_500 })

  assert.deepEqual(transition.completed, {
    raw: "inspect\nfiles",
    startedAt: 1_000,
    finishedAt: 2_500,
    durationMs: 1_500
  })
  assert.equal(transition.state.phase, "idle")

  const item = buildThinkingTranscriptItem(transition.completed)
  assert.equal(item.summary, "Thinking · 1.5s")
  assert.deepEqual(item.details, ["inspect", "files"])
  assert.equal(item.collapsible, true)
  assert.equal(item.expanded, false)
})

test("waiting-only spinner state never produces a transcript completion", () => {
  const waiting = startThinkingWait(createThinkingState(), { now: 2_000 }).state
  const finished = finishThinking(waiting, { now: 3_000 })

  assert.equal(finished.completed, null)
  assert.deepEqual(finished.state, createThinkingState())
})

test("a repeated reasoning start closes the real stream and starts a new timer", () => {
  let transition = startThinkingStream(createThinkingState(), { now: 5_000 })
  transition = appendThinkingDelta(transition.state, "first", { now: 5_100 })
  transition = startThinkingStream(transition.state, { now: 5_600 })

  assert.equal(transition.completed.raw, "first")
  assert.equal(transition.completed.durationMs, 600)
  assert.deepEqual(transition.state, {
    phase: "streaming",
    startedAt: 5_600,
    raw: ""
  })
})
