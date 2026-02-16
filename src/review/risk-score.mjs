const DEFAULT_PATH_RISK = ["config", "auth", "permission", "migration", "infra", "script"]
const COMMAND_RISK_RE = /\b(curl|wget|powershell|pwsh|bash|sh|chmod|sudo|eval|exec|rm\s+-rf)\b/i

const DEFAULT_WEIGHTS = {
  sensitive_path: 4,
  large_change: 3,
  medium_change: 2,
  small_change: 1,
  executable_script: 2,
  command_pattern: 3
}

export function scoreRisk(file, options = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...options.weights }
  const sensitiveKeys = options.sensitive_paths || DEFAULT_PATH_RISK

  let score = 1
  const reasons = []
  const lowerPath = file.path.toLowerCase()

  for (const key of sensitiveKeys) {
    if (lowerPath.includes(key)) {
      score += w.sensitive_path
      reasons.push(`path contains "${key}"`)
    }
  }

  const changed = file.added + file.removed
  if (changed > 200) {
    score += w.large_change
    reasons.push("large change size (>200 lines)")
  } else if (changed > 80) {
    score += w.medium_change
    reasons.push("medium change size (>80 lines)")
  } else if (changed > 30) {
    score += w.small_change
    reasons.push("noticeable change size (>30 lines)")
  }

  if (/\.(sh|ps1|bat|cmd)$/i.test(file.path)) {
    score += w.executable_script
    reasons.push("executable script file")
  }

  if (file.addedLines.some((line) => COMMAND_RISK_RE.test(line))) {
    score += w.command_pattern
    reasons.push("contains executable command patterns")
  }

  return { score, reasons }
}

export function sortReviewFiles(files, sortMode) {
  if (sortMode === "file_order") {
    return [...files].sort((a, b) => a.path.localeCompare(b.path))
  }
  if (sortMode === "time_order") {
    return [...files]
  }
  return [...files].sort((a, b) => b.riskScore - a.riskScore || a.path.localeCompare(b.path))
}
