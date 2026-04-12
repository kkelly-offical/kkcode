export async function collectInput(rl, promptStr) {
  const first = (await rl.question(promptStr)).trim()
  if (!first) return ""

  if (first === '"""' || first.startsWith('"""')) {
    const lines = []
    if (first !== '"""') lines.push(first.slice(3))
    while (true) {
      const next = await rl.question("... ")
      if (next.trim() === '"""') break
      lines.push(next)
    }
    return lines.join("\n").trim()
  }

  if (first.endsWith("\\")) {
    const lines = [first.slice(0, -1)]
    while (true) {
      const next = await rl.question("... ")
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
  if (!String(input || "").startsWith("/")) return false

  const body = String(input || "").slice(1)
  const firstSpace = body.indexOf(" ")
  if (firstSpace >= 0) return false

  const token = body.trim()
  if (!token) return true

  const idx = Math.max(0, Math.min(selectedSuggestion || 0, suggestions.length - 1))
  const chosen = suggestions[idx]
  return Boolean(chosen && chosen.name !== token)
}
