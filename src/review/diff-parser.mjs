function decodeGitQuotedPath(value) {
  const raw = String(value || "")
  if (!(raw.startsWith("\"") && raw.endsWith("\""))) return raw
  const bytes = []
  const body = raw.slice(1, -1)
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char !== "\\") {
      const codePoint = body.codePointAt(index)
      const symbol = String.fromCodePoint(codePoint)
      bytes.push(...Buffer.from(symbol, "utf8"))
      if (symbol.length === 2) index += 1
      continue
    }
    const escaped = body[++index]
    if (escaped === undefined) break
    if (/[0-7]/.test(escaped)) {
      let octal = escaped
      while (octal.length < 3 && /[0-7]/.test(body[index + 1] || "")) {
        octal += body[++index]
      }
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    const mapped = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      "\\": 92,
      "\"": 34
    }[escaped]
    if (mapped !== undefined) bytes.push(mapped)
    else bytes.push(...Buffer.from(escaped, "utf8"))
  }
  return Buffer.from(bytes).toString("utf8")
}

function normalizeDiffPath(value) {
  let raw = String(value || "").trimEnd()
  if (!raw.startsWith("\"")) raw = raw.split("\t", 1)[0]
  raw = decodeGitQuotedPath(raw)
  return raw.replace(/^(?:a|b)\//, "")
}

function pathFromDiffHeader(line) {
  const raw = line.slice("diff --git ".length)
  if (raw.startsWith("\"")) {
    let escaped = false
    for (let index = 1; index < raw.length; index++) {
      const char = raw[index]
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === "\"" && raw[index + 1] === " ") {
        return normalizeDiffPath(raw.slice(index + 2))
      }
    }
  }
  const separator = raw.lastIndexOf(" b/")
  return normalizeDiffPath(separator >= 0 ? raw.slice(separator + 1) : raw)
}

export function parseUnifiedDiff(diffText) {
  const lines = diffText.split(/\r?\n/)
  const files = []
  let current = null

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current)
      current = {
        path: pathFromDiffHeader(line),
        added: 0,
        removed: 0,
        rawLines: [],
        addedLines: []
      }
      continue
    }
    if (!current) continue
    current.rawLines.push(line)
    if (line.startsWith("+++ ") && line.slice(4).trim() !== "/dev/null") {
      current.path = normalizeDiffPath(line.slice(4))
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.added += 1
      current.addedLines.push(line.slice(1))
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.removed += 1
    }
  }
  if (current) files.push(current)
  return files.filter((file) => file.path.length > 0)
}

export function previewLines(file, limit = 80) {
  return file.rawLines.slice(0, limit)
}
