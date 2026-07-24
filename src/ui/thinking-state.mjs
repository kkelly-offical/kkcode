const THINKING_PHASES = new Set(["idle", "waiting", "streaming"])

function timestamp(value, fallback = Date.now()) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeState(input = {}) {
  const phase = THINKING_PHASES.has(input?.phase) ? input.phase : "idle"
  return {
    phase,
    startedAt: phase === "idle" ? 0 : timestamp(input.startedAt, 0),
    raw: phase === "streaming" ? String(input.raw || "") : ""
  }
}

function idleState() {
  return {
    phase: "idle",
    startedAt: 0,
    raw: ""
  }
}

function completedThinking(state, finishedAt) {
  if (state.phase !== "streaming") return null
  return {
    raw: state.raw,
    startedAt: state.startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - state.startedAt)
  }
}

export function createThinkingState(overrides = {}) {
  return normalizeState(overrides)
}

/**
 * Start the visible waiting spinner for a step. A prior real reasoning stream
 * is completed, while a prior waiting-only phase remains ephemeral.
 */
export function startThinkingWait(input, { now = Date.now() } = {}) {
  const state = normalizeState(input)
  const startedAt = timestamp(now)
  return {
    state: {
      phase: "waiting",
      startedAt,
      raw: ""
    },
    completed: completedThinking(state, startedAt)
  }
}

/**
 * Promote the waiting spinner to a real reasoning stream without closing it
 * or resetting its elapsed timer.
 */
export function startThinkingStream(input, { now = Date.now() } = {}) {
  const state = normalizeState(input)
  const startedAt = timestamp(now)
  return {
    state: {
      phase: "streaming",
      startedAt: state.phase === "waiting" ? state.startedAt : startedAt,
      raw: ""
    },
    completed: completedThinking(state, startedAt)
  }
}

export function appendThinkingDelta(input, text, { now = Date.now() } = {}) {
  const state = normalizeState(input)
  const startedAt = timestamp(now)
  return {
    state: {
      phase: "streaming",
      startedAt: state.phase === "idle" ? startedAt : state.startedAt,
      raw: `${state.raw}${String(text || "")}`
    },
    completed: null
  }
}

/**
 * Finish the current phase. Only a real reasoning stream produces a
 * transcript completion; waiting-only spinner time is discarded.
 */
export function finishThinking(input, { now = Date.now() } = {}) {
  const state = normalizeState(input)
  const finishedAt = timestamp(now)
  return {
    state: idleState(),
    completed: completedThinking(state, finishedAt)
  }
}

export function formatThinkingDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

export function buildThinkingTranscriptItem(completed = {}) {
  const durationMs = Math.max(0, Number(completed.durationMs) || 0)
  const raw = String(completed.raw || "").trim()
  const details = raw ? raw.split(/\r?\n/) : []
  return {
    kind: "thinking",
    summary: `Thinking · ${formatThinkingDuration(durationMs)}`,
    details,
    collapsible: details.length > 0,
    expanded: false,
    metadata: { durationMs }
  }
}
