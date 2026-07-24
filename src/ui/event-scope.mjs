import { EVENT_TYPES } from "../core/constants.mjs"

const ACTIVE_TURN_EVENT_TYPES = new Set([
  EVENT_TYPES.TURN_START,
  EVENT_TYPES.TURN_STEP_START,
  EVENT_TYPES.TURN_STEP_FINISH,
  EVENT_TYPES.TOOL_START,
  EVENT_TYPES.TOOL_FINISH,
  EVENT_TYPES.TOOL_ERROR,
  EVENT_TYPES.STREAM_TEXT_START,
  EVENT_TYPES.STREAM_TEXT_DELTA,
  EVENT_TYPES.STREAM_THINKING_START,
  EVENT_TYPES.STREAM_THINKING_DELTA,
  EVENT_TYPES.TURN_USAGE_UPDATE,
  EVENT_TYPES.PROVIDER_RETRY,
  EVENT_TYPES.TURN_FINISH,
  EVENT_TYPES.TURN_ERROR
])

/**
 * Keep foreground transcript state isolated from background/subagent sessions
 * and from late events belonging to an earlier turn in the same session.
 * Non-turn events remain visible to the general activity renderer.
 */
export function shouldApplyActiveTurnEvent(event, {
  sessionId = null,
  turnId = null
} = {}) {
  if (!ACTIVE_TURN_EVENT_TYPES.has(event?.type)) return true

  // Turn-scoped events are security and state-isolation boundaries. Missing
  // correlation IDs must not be treated as a wildcard because that lets late
  // or background events mutate the foreground transcript.
  if (!sessionId || !event?.sessionId || event.sessionId !== sessionId) return false
  if (!event?.turnId) return false

  if (event.type === EVENT_TYPES.TURN_START) {
    // A start may establish the first active turn. While a turn is active,
    // only an idempotent duplicate start for that same turn is accepted;
    // overlapping starts cannot steal the foreground UI.
    return !turnId || event.turnId === turnId
  }

  // Once the active turn has finished and its id is cleared, every late
  // turn-scoped event fails closed until a correlated TURN_START arrives.
  return Boolean(turnId) && event.turnId === turnId
}
