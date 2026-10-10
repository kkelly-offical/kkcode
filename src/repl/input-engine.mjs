const readlineStates = new WeakMap()

function readlineState(rl) {
  let state = readlineStates.get(rl)
  if (state) return state

  state = { lines: [], waiters: [], closed: Boolean(rl.closed) }
  readlineStates.set(rl, state)
  rl.on("line", (line) => {
    if (state.waiters.length) state.waiters.shift()(line)
    else state.lines.push(line)
  })
  rl.on("close", () => {
    state.closed = true
    while (state.waiters.length) state.waiters.shift()(null)
  })
  return state
}

async function nextInputLine(rl, promptStr) {
  // Lightweight mocks and other hosts can keep the original question-based contract.
  if (typeof rl.on !== "function") return rl.question(promptStr)

  const state = readlineState(rl)
  if (!state.closed) {
    rl.setPrompt(promptStr)
    rl.prompt()
  }
  if (state.lines.length) return state.lines.shift()
  if (state.closed) return null
  return await new Promise((resolve) => state.waiters.push(resolve))
}

export async function closeLineInput(renderer, rl, saveHistory) {
  try {
    renderer?.stop()
  } finally {
    try {
      rl.close()
    } finally {
      await saveHistory()
    }
  }
}

export function shouldSubmitInput(line, busy) {
  return Boolean(line.trim()) && !busy
}

export async function collectInput(rl, promptStr) {
  const answer = await nextInputLine(rl, promptStr)
  if (answer === null) return null
  const first = answer.trim()
  if (!first) return ""

  if (first === '"""' || first.startsWith('"""')) {
    const lines = []
    if (first !== '"""') lines.push(first.slice(3))
    while (true) {
      const next = await nextInputLine(rl, "... ")
      if (next === null) return lines.join("\n").trim()
      if (next.trim() === '"""') break
      lines.push(next)
    }
    return lines.join("\n").trim()
  }

  if (first.endsWith("\\")) {
    const lines = [first.slice(0, -1)]
    while (true) {
      const next = await nextInputLine(rl, "... ")
      if (next === null) return lines.join("\n").trim()
      if (next.endsWith("\\")) lines.push(next.slice(0, -1))
      else {
        lines.push(next)
        break
      }
    }
    return lines.join("\n").trim()
  }

  return first
}

export function resolveHistoryNavigation(history, historyIndex, keyName) {
  if (!Array.isArray(history) || history.length === 0) {
    return { historyIndex, value: "", changed: false }
  }

  if (keyName === "up") {
    const nextIndex = Math.max(0, historyIndex - 1)
    return {
      historyIndex: nextIndex,
      value: history[nextIndex] || "",
      changed: nextIndex !== historyIndex
    }
  }

  if (historyIndex < history.length - 1) {
    const nextIndex = historyIndex + 1
    return {
      historyIndex: nextIndex,
      value: history[nextIndex] || "",
      changed: true
    }
  }

  return {
    historyIndex: history.length,
    value: "",
    changed: historyIndex !== history.length
  }
}

export function shouldApplySuggestionOnEnter(input, suggestions, selectedSuggestion) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return false
  const value = String(input || "")
  if (!value.startsWith("/") && !value.startsWith("$")) return false

  const body = value.slice(1)
  const firstSpace = body.indexOf(" ")
  if (firstSpace >= 0) return false

  const token = body.trim()
  if (!token) return true

  const idx = Math.max(0, Math.min(selectedSuggestion || 0, suggestions.length - 1))
  const chosen = suggestions[idx]
  return Boolean(chosen && chosen.name !== token)
}
