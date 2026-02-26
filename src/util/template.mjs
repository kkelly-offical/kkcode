function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function renderTemplate(input, variables = {}) {
  let result = input
  for (const [key, value] of Object.entries(variables)) {
    const ek = escapeRegex(key)
    const tokens = [new RegExp(`\\$\\{${ek}\\}`, "g"), new RegExp(`\\{\\{${ek}\\}\\}`, "g"), new RegExp(`\\{${ek}\\}`, "g")]
    for (const token of tokens) {
      result = result.replace(token, String(value))
    }
  }
  return result
}
