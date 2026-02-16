/**
 * Glob-style pattern matching supporting:
 *   *      — any chars except /
 *   **     — any chars including /
 *   ?      — single char
 *   !pat   — negation (returns false when inner pattern matches)
 */
function globToRegex(pattern) {
  let src = ""
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === "*" && pattern[i + 1] === "*") {
      src += ".*"
      i += 2
      if (pattern[i] === "/") i++ // skip trailing slash after **
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

function matchGlob(value, pattern) {
  if (!pattern || pattern === "*") return true
  const str = String(value || "")
  const negate = pattern.startsWith("!")
  const pat = negate ? pattern.slice(1) : pattern
  const matched = globToRegex(pat).test(str)
  return negate ? !matched : matched
}

/**
 * Match a list of glob patterns (OR logic, negations filter out).
 * Single string is treated as one pattern.
 */
function matchPatterns(value, patterns) {
  if (!patterns) return true
  const list = Array.isArray(patterns) ? patterns : [patterns]
  if (!list.length) return true
  const positives = list.filter((p) => !String(p).startsWith("!"))
  const negatives = list.filter((p) => String(p).startsWith("!"))
  // If any negative matches, reject
  for (const neg of negatives) {
    if (!matchGlob(value, neg)) return false // negation matched → excluded
  }
  // If no positive patterns, pass (only negatives were specified)
  if (!positives.length) return true
  // At least one positive must match
  return positives.some((p) => matchGlob(value, p))
}

/**
 * Match command prefix for bash tool rules.
 * command_prefix: "npm test" matches "npm test --verbose"
 * command_prefix: ["git *", "npm *"] matches any git or npm command
 */
function matchCommandPrefix(command, prefixes) {
  if (!prefixes) return true
  const list = Array.isArray(prefixes) ? prefixes : [prefixes]
  if (!list.length) return true
  const cmd = String(command || "").trim()
  return list.some((prefix) => {
    if (prefix.includes("*")) return matchGlob(cmd, prefix)
    return cmd === prefix || cmd.startsWith(`${prefix} `)
  })
}

export function matchRule(rule, input) {
  if (rule.tool !== "*" && rule.tool !== input.tool) return false
  if (Array.isArray(rule.modes) && rule.modes.length && !rule.modes.includes(input.mode)) return false
  if (rule.risk && input.risk && Number(input.risk) < Number(rule.risk)) return false

  // File glob matching (for read/write/edit/glob/grep tools)
  if (rule.file_patterns) {
    if (!matchPatterns(input.pattern || "", rule.file_patterns)) return false
  } else if (rule.pattern) {
    // Legacy single-pattern support
    if (!matchGlob(input.pattern || input.tool, rule.pattern)) return false
  }

  // Command prefix matching (for bash tool)
  if (rule.command_prefix && input.tool === "bash") {
    if (!matchCommandPrefix(input.command || input.pattern || "", rule.command_prefix)) return false
  }

  return true
}

export function evaluatePermission({ config, tool, mode, pattern = "*", command = "", risk = 0 }) {
  const permission = config.permission || { default_policy: "ask", rules: [] }
  const rules = Array.isArray(permission.rules) ? permission.rules : []
  for (const rule of rules) {
    if (matchRule(rule, { tool, mode, pattern, command, risk })) {
      return {
        action: rule.action,
        source: "rule",
        rule
      }
    }
  }
  return {
    action: permission.default_policy || "ask",
    source: "default",
    rule: null
  }
}

// Exported for testing
export { matchGlob, matchPatterns, matchCommandPrefix }
