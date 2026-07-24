import { globToRegex, normalizePath } from "../util/glob.mjs"

/** 这里的模式参数在前，且不支持 `!` 取反，因此不直接复用 util 的 matchGlob。 */
function matchSensitiveGlob(pattern, value) {
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
  return candidates.some((candidate) => patterns.some((pattern) => matchSensitiveGlob(pattern, candidate)))
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
