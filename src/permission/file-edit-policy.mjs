function globToRegex(pattern) {
  let src = ""
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === "*" && pattern[i + 1] === "*") {
      src += ".*"
      i += 2
      if (pattern[i] === "/") i++
    } else if (ch === "*") {
      src += "[^/]*"
      i++
    } else if (ch === "?") {
      src += "[^/]"
      i++
    } else if (".+^${}()|[]\\".includes(ch)) {
      src += `\\${ch}`
      i++
    } else {
      src += ch
      i++
    }
  }
  return new RegExp(`^${src}$`, "i")
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .reduce((acc, segment) => {
      if (!segment || segment === ".") return acc
      if (segment === "..") {
        acc.pop()
        return acc
      }
      acc.push(segment)
      return acc
    }, [])
    .join("/")
}

function matchGlob(pattern, value) {
  return globToRegex(pattern).test(normalizePath(value))
}

export const DEFAULT_SENSITIVE_FILE_PATTERNS = [
  "AGENTS.md",
  "**/AGENTS.md",
  "KKCODE.md",
  "**/KKCODE.md",
  ".kkcode/**",
  "**/.kkcode/**",
  "kkcode.config.yaml",
  "**/kkcode.config.yaml",
  ".mcp.json",
  "**/.mcp.json",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".github/workflows/**",
  "**/.github/workflows/**"
]

const SENSITIVE_EDIT_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
  "notebookedit"
])

function extractCandidatePaths(input) {
  if (Array.isArray(input)) return input.flatMap(extractCandidatePaths)
  if (typeof input !== "string") return []
  return input
    .split(",")
    .map((part) => normalizePath(part.trim()))
    .filter(Boolean)
}

export function getSensitiveFilePatterns(config = {}) {
  const configured = config.tool?.sensitive_file_patterns
  if (!configured) return [...DEFAULT_SENSITIVE_FILE_PATTERNS]
  if (Array.isArray(configured)) return configured.filter((value) => typeof value === "string" && value.trim())
  return [...DEFAULT_SENSITIVE_FILE_PATTERNS]
}

export function isSensitiveEditTool(toolName) {
  return SENSITIVE_EDIT_TOOLS.has(String(toolName || ""))
}

export function isSensitiveEditPath(pathOrPaths, config = {}) {
  const patterns = getSensitiveFilePatterns(config)
  const candidates = extractCandidatePaths(pathOrPaths)
  return candidates.some((candidate) => patterns.some((pattern) => matchGlob(pattern, candidate)))
}

export function getSensitiveEditPolicy(toolName, pathOrPaths, config = {}) {
  if (!isSensitiveEditTool(toolName)) return null
  if (!isSensitiveEditPath(pathOrPaths, config)) return null
  return {
    action: "ask",
    source: "sensitive_path",
    reason: "sensitive edit target requires explicit approval"
  }
}
