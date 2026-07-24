import test from "node:test"
import assert from "node:assert/strict"
import { EVENT_TYPES } from "../src/core/constants.mjs"
import { shouldApplyActiveTurnEvent } from "../src/ui/event-scope.mjs"

test("foreign session streams cannot mutate the foreground transcript", () => {
  const active = { sessionId: "ses_main", turnId: "turn_main" }
  for (const type of [
    EVENT_TYPES.STREAM_TEXT_START,
    EVENT_TYPES.STREAM_TEXT_DELTA,
    EVENT_TYPES.STREAM_THINKING_START,
    EVENT_TYPES.STREAM_THINKING_DELTA,
    EVENT_TYPES.TURN_FINISH,
    EVENT_TYPES.TURN_ERROR
  ]) {
    assert.equal(
      shouldApplyActiveTurnEvent({
        type,
        sessionId: "ses_subagent",
        turnId: "turn_subagent"
      }, active),
      false
    )
  }
})

test("late events from an older turn in the same session are ignored", () => {
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.STREAM_TEXT_DELTA,
      sessionId: "ses_main",
      turnId: "turn_old"
    }, {
      sessionId: "ses_main",
      turnId: "turn_current"
    }),
    false
  )
})

test("turn events fail closed while there is no active turn", () => {
  const idle = { sessionId: "ses_main", turnId: null }
  for (const type of [
    EVENT_TYPES.TURN_STEP_START,
    EVENT_TYPES.TURN_STEP_FINISH,
    EVENT_TYPES.TOOL_START,
    EVENT_TYPES.TOOL_FINISH,
    EVENT_TYPES.STREAM_TEXT_START,
    EVENT_TYPES.STREAM_TEXT_DELTA,
    EVENT_TYPES.STREAM_THINKING_START,
    EVENT_TYPES.STREAM_THINKING_DELTA,
    EVENT_TYPES.TURN_USAGE_UPDATE,
    EVENT_TYPES.PROVIDER_RETRY,
    EVENT_TYPES.TURN_FINISH,
    EVENT_TYPES.TURN_ERROR
  ]) {
    assert.equal(
      shouldApplyActiveTurnEvent({
        type,
        sessionId: "ses_main",
        turnId: "turn_late"
      }, idle),
      false,
      type
    )
  }
})

test("a correlated turn start establishes an idle foreground turn", () => {
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.TURN_START,
      sessionId: "ses_main",
      turnId: "turn_next"
    }, {
      sessionId: "ses_main",
      turnId: null
    }),
    true
  )
})

test("an overlapping turn start cannot replace the active turn", () => {
  const active = { sessionId: "ses_main", turnId: "turn_current" }
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.TURN_START,
      sessionId: "ses_main",
      turnId: "turn_overlap"
    }, active),
    false
  )
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.TURN_START,
      sessionId: "ses_main",
      turnId: "turn_current"
    }, active),
    true
  )
})

test("turn events with missing correlation ids fail closed", () => {
  const active = { sessionId: "ses_main", turnId: "turn_main" }
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.STREAM_TEXT_DELTA,
      turnId: "turn_main"
    }, active),
    false
  )
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.STREAM_TEXT_DELTA,
      sessionId: "ses_main"
    }, active),
    false
  )
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.STREAM_TEXT_DELTA,
      sessionId: "ses_main",
      turnId: "turn_main"
    }),
    false
  )
})

test("the active turn and general activity events remain visible", () => {
  const active = { sessionId: "ses_main", turnId: "turn_main" }
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.STREAM_TEXT_DELTA,
      sessionId: "ses_main",
      turnId: "turn_main"
    }, active),
    true
  )
  assert.equal(
    shouldApplyActiveTurnEvent({
      type: EVENT_TYPES.LONGAGENT_STAGE_STARTED,
      sessionId: "ses_subagent"
    }, active),
    true
  )
})
