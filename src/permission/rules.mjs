import { getSensitiveEditPolicy } from "./file-edit-policy.mjs"

export const PERMISSION_MODES = ["auto", "manual", "yolo"]
export const LEGACY_PERMISSION_POLICIES = ["ask", "allow", "deny"]

const AUTO_READONLY_TOOLS = new Set([
  "list",
  "read",
  "glob",
  "grep",
  "codesearch",
  "sysinfo",
  "websearch",
  "webfetch",
  "background_output",
  "task_list",
  "task_get",
  "task_output",
  "todowrite",
  "question",
  "enter_plan",
  "exit_plan"
])

const AUTO_REVIEW_ASK_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "patch",
  "multiedit",
  "notebookedit",
  "task",
  "task_stop",
  "background_cancel",
  "skill"
])

const TRUSTED_BASH_PATTERNS = [
  /^(pwd|ls|cat|head|tail|wc|which|date|whoami|uname)\b/i,
  /^(rg|grep|find)\b/i,
  /^sed\s+-n\b/i,
  /^git\s+(status|log|diff|show|branch|rev-parse)\b/i,
  /^(node|npm|pnpm|yarn)\s+(--version|-v|version|root|list|ls)\b/i
]

function normalizePermissionMode(permission = {}) {
  const mode = String(permission.mode || "").toLowerCase()
  if (PERMISSION_MODES.includes(mode)) return mode
  const legacy = String(permission.default_policy || "").toLowerCase()
  if (legacy === "auto" || legacy === "yolo") return legacy
  return "manual"
}

function trustedBashCommand(command) {
  const cmd = String(command || "").trim()
  if (!cmd) return false
  if (/[;&|<>`]/.test(cmd)) return false
  return TRUSTED_BASH_PATTERNS.some((pattern) => pattern.test(cmd))
}

function autoAllowsTool({ tool, command = "" }) {
  if (AUTO_READONLY_TOOLS.has(tool)) return true
  if (tool === "bash") return trustedBashCommand(command)
  if (AUTO_REVIEW_ASK_TOOLS.has(tool)) return false
  return false
}

function applySensitiveEscalation(decision, { tool, pattern, config, mode }) {
  if (mode === "yolo") return decision
  const sensitivePolicy = getSensitiveEditPolicy(tool, pattern, config)
  if (sensitivePolicy && decision.action === "allow") {
    return {
      action: sensitivePolicy.action,
      source: sensitivePolicy.source,
      rule: decision.rule || null,
      mode
    }
  }
  return decision
}

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

function normalizePath(p) {
  // Resolve ../ and ./ sequences to prevent traversal bypass
  return p.replace(/\\/g, "/").split("/").reduce((acc, seg) => {
    if (seg === "..") { acc.pop(); return acc }
    if (seg !== "." && seg !== "") acc.push(seg)
    return acc
  }, []).join("/")
}

function matchGlob(value, pattern) {
  if (!pattern || pattern === "*") return true
  const str = normalizePath(String(value || ""))
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
  const permissionMode = normalizePermissionMode(permission)
  const rules = Array.isArray(permission.rules) ? permission.rules : []
  for (const rule of rules) {
    if (matchRule(rule, { tool, mode, pattern, command, risk })) {
      const matchedDecision = {
        action: rule.action,
        source: "rule",
        rule,
        mode: permissionMode
      }
      return applySensitiveEscalation(matchedDecision, { tool, pattern, config, mode: permissionMode })
    }
  }

  if (permissionMode === "yolo") {
    return { action: "allow", source: "mode:yolo", rule: null, mode: permissionMode }
  }

  if (permissionMode === "auto") {
    const action = autoAllowsTool({ tool, command, risk }) ? "allow" : "ask"
    const decision = { action, source: "auto_review", rule: null, mode: permissionMode }
    return applySensitiveEscalation(decision, { tool, pattern, config, mode: permissionMode })
  }

  const defaultPolicy = LEGACY_PERMISSION_POLICIES.includes(permission.default_policy)
    ? permission.default_policy
    : "ask"
  const fallbackDecision = {
    action: defaultPolicy,
    source: "default",
    rule: null,
    mode: permissionMode
  }
  return applySensitiveEscalation(fallbackDecision, { tool, pattern, config, mode: permissionMode })
}

// Exported for testing
export { matchGlob, matchPatterns, matchCommandPrefix, normalizePermissionMode, trustedBashCommand, autoAllowsTool }
