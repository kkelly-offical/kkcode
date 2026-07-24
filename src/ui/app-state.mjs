export const TURN_PHASES = Object.freeze([
  "idle",
  "connecting",
  "thinking",
  "awaiting_approval",
  "tool_running",
  "responding",
  "compacting",
  "retrying",
  "paused",
  "succeeded",
  "failed",
  "cancelled"
])

export const TRANSCRIPT_BLOCK_TYPES = Object.freeze([
  "user",
  "thinking",
  "assistant",
  "tool",
  "diff",
  "approval",
  "error",
  "task",
  "system"
])

const TERMINAL_PHASES = new Set(["succeeded", "failed", "cancelled"])

export function createAppState(overrides = {}) {
  return {
    phase: "idle",
    sessionId: null,
    turnId: null,
    transcript: [],
    tasks: [],
    overlay: null,
    activeTool: null,
    error: null,
    ...overrides
  }
}

function appendBlock(state, block) {
  if (!TRANSCRIPT_BLOCK_TYPES.includes(block?.type)) return state
  return { ...state, transcript: [...state.transcript, block] }
}

function appendDelta(state, type, text) {
  if (!text) return state
  const transcript = [...state.transcript]
  const last = transcript.at(-1)
  if (last?.type === type && last?.streaming === true) {
    transcript[transcript.length - 1] = { ...last, text: `${last.text || ""}${text}` }
  } else {
    transcript.push({ type, text, streaming: true })
  }
  return { ...state, transcript }
}

function closeStreamingBlocks(transcript) {
  return transcript.map((block) => block?.streaming ? { ...block, streaming: false } : block)
}

export function reduceAppState(state, event) {
  const current = state || createAppState()
  const type = event?.type
  const payload = event?.payload || {}

  switch (type) {
    case "turn.start":
      return {
        ...current,
        phase: "connecting",
        sessionId: event.sessionId ?? current.sessionId,
        turnId: event.turnId ?? current.turnId,
        activeTool: null,
        error: null
      }
    case "turn.step.start":
    case "stream.thinking.start":
      return { ...current, phase: "thinking" }
    case "provider.retry":
      return { ...current, phase: "retrying" }
    case "stream.thinking.delta":
      return appendDelta({ ...current, phase: "thinking" }, "thinking", payload.text || payload.content || "")
    case "stream.text.start":
      return { ...current, phase: "responding" }
    case "stream.text.delta":
      return appendDelta({ ...current, phase: "responding" }, "assistant", payload.text || payload.content || "")
    case "permission.asked":
      return {
        ...appendBlock(current, { type: "approval", ...payload }),
        phase: "awaiting_approval",
        overlay: "permission"
      }
    case "permission.decided":
      return { ...current, phase: "thinking", overlay: null }
    case "tool.start":
      return {
        ...appendBlock(current, { type: "tool", status: "running", ...payload }),
        phase: "tool_running",
        activeTool: payload.tool || null
      }
    case "tool.finish":
    case "tool.error":
      return {
        ...appendBlock(current, {
          type: "tool",
          status: payload.status || (type === "tool.error" ? "error" : "completed"),
          ...payload
        }),
        phase: payload.status === "cancelled" ? "cancelled" : "thinking",
        activeTool: null
      }
    case "session.compacted":
      return appendBlock({ ...current, phase: "compacting" }, { type: "system", kind: "compaction", ...payload })
    case "turn.finish":
      {
        const next = payload.reply && current.transcript.at(-1)?.type !== "assistant"
          ? appendBlock(current, { type: "assistant", text: payload.reply })
          : current
        return {
        ...next,
        transcript: closeStreamingBlocks(next.transcript),
        phase: "succeeded",
        activeTool: null
      }
      }
    case "turn.error":
      return {
        ...appendBlock(current, { type: "error", ...payload }),
        phase: payload.status === "cancelled" ? "cancelled" : "failed",
        activeTool: null,
        error: payload
      }
    case "turn.cancelled":
      return { ...current, phase: "cancelled", activeTool: null }
    default:
      return current
  }
}

export function isTerminalPhase(phase) {
  return TERMINAL_PHASES.has(phase)
}

export function responsiveTier(width) {
  const columns = Number(width) || 80
  if (columns >= 100) return "full"
  if (columns >= 60) return "compact"
  return "minimal"
}
