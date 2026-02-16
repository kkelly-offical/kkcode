/**
 * Minimal YAML subset parser for agent definition files.
 * Supports: key: value, key: [array], key: | multiline, key: + indented - list
 */

export function parseYaml(text) {
  if (!text || typeof text !== "string") return {}
  const lines = text.split("\n")
  const result = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue }

    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!match) { i++; continue }

    const key = match[1]
    const rest = match[2].trim()

    // Multiline block scalar: key: |
    if (rest === "|" || rest === "|+" || rest === "|-") {
      i++
      const blockLines = []
      const indent = detectIndent(lines, i)
      while (i < lines.length) {
        const bl = lines[i]
        if (bl.trim() === "" && i + 1 < lines.length) {
          const nextLine = lines[i + 1]
          if (nextLine.match(/^[a-zA-Z_]/) || (nextLine.trim() && getIndent(nextLine) < indent)) break
        }
        if (bl.trim() !== "" && getIndent(bl) < indent) break
        blockLines.push(bl.length >= indent ? bl.slice(indent) : bl.trimStart())
        i++
      }
      // Trim trailing empty lines for |- mode
      if (rest === "|-") {
        while (blockLines.length && !blockLines[blockLines.length - 1].trim()) blockLines.pop()
      }
      result[key] = blockLines.join("\n").replace(/\n+$/, "\n")
      continue
    }

    // Inline array: key: [a, b, c]
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1)
      result[key] = inner.split(",").map((s) => castValue(s.trim())).filter((v) => v !== "")
      i++
      continue
    }

    // Check if next lines are indented list items: key:\n  - item
    if (rest === "") {
      const nextIdx = i + 1
      if (nextIdx < lines.length && lines[nextIdx].trim().startsWith("- ")) {
        i++
        const items = []
        while (i < lines.length && lines[i].trim().startsWith("- ")) {
          items.push(castValue(lines[i].trim().slice(2).trim()))
          i++
        }
        result[key] = items
        continue
      }
    }

    // Simple key: value
    result[key] = castValue(rest)
    i++
  }

  return result
}

function detectIndent(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim()) return getIndent(lines[i])
  }
  return 2
}

function getIndent(line) {
  const m = line.match(/^(\s*)/)
  return m ? m[1].length : 0
}

function castValue(s) {
  if (!s) return ""
  // Remove surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  if (s === "true") return true
  if (s === "false") return false
  if (s === "null" || s === "~") return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}
