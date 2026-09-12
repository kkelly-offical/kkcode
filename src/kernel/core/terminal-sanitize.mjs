const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/g
const SGR_RE = /^\x1b\[[0-9;:]*m/

function visibleControl(code) {
  if (code >= 0 && code <= 0x1f) return String.fromCodePoint(0x2400 + code)
  if (code === 0x7f) return "\u2421"
  return `<0x${code.toString(16).toUpperCase().padStart(2, "0")}>`
}

/**
 * Convert untrusted model/tool text into inert terminal content. Newlines and
 * tabs remain useful; cursor movement, OSC clipboard commands, C1 controls,
 * and bidi overrides become visible text.
 */
export function sanitizeTerminalText(value) {
  const source = String(value ?? "").replace(/\r\n?/g, "\n")
  let output = ""
  for (const char of source) {
    const code = char.codePointAt(0)
    if (char === "\n" || char === "\t") {
      output += char
    } else if ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      output += visibleControl(code)
    } else {
      output += char
    }
  }
  return output.replace(BIDI_CONTROL_RE, (char) =>
    `\\u${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`
  )
}

/**
 * Sanitize mixed trusted-styling/untrusted-content strings at the transcript
 * boundary. KK Code's SGR color sequences remain active; every other terminal
 * command is rendered as inert, visible text.
 */
export function sanitizeTerminalStyledText(value) {
  const source = String(value ?? "").replace(/\r\n?/g, "\n")
  let output = ""
  for (let index = 0; index < source.length;) {
    if (source[index] === "\x1b") {
      const sgr = source.slice(index).match(SGR_RE)?.[0]
      if (sgr) {
        output += sgr
        index += sgr.length
        continue
      }
    }

    const code = source.codePointAt(index)
    const char = String.fromCodePoint(code)
    if (char === "\n" || char === "\t") {
      output += char
    } else if ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      output += visibleControl(code)
    } else if (BIDI_CONTROL_RE.test(char)) {
      output += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`
    } else {
      output += char
    }
    BIDI_CONTROL_RE.lastIndex = 0
    index += char.length
  }
  return output
}

export function sanitizeTerminalValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return sanitizeTerminalText(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]"
    seen.add(value)
    const output = value.map((item) => sanitizeTerminalValue(item, seen))
    seen.delete(value)
    return output
  }
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = sanitizeTerminalValue(item, seen)
  }
  seen.delete(value)
  return output
}
