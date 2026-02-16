export function renderTemplate(input, variables = {}) {
  let result = input
  for (const [key, value] of Object.entries(variables)) {
    const tokens = [new RegExp(`\\$\\{${key}\\}`, "g"), new RegExp(`\\{\\{${key}\\}\\}`, "g"), new RegExp(`\\{${key}\\}`, "g")]
    for (const token of tokens) {
      result = result.replace(token, String(value))
    }
  }
  return result
}
