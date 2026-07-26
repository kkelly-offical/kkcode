import { getSensitiveEditPolicy } from "./file-edit-policy.mjs"
import { matchGlob, matchPatterns, normalizePath } from "../util/glob.mjs"
import { APPROVAL_LEVELS, DEFAULT_APPROVAL } from "../core/modes.mjs"
import { noteDeprecation } from "../core/deprecations.mjs"

export const PERMISSION_LEVELS = APPROVAL_LEVELS
export const LEGACY_PERMISSION_POLICIES = ["ask", "allow", "deny"]

const TOOL_CAPABILITIES = {
  list: "read",
  read: "read",
  glob: "search",
  grep: "search",
  codesearch: "search",
  sysinfo: "read",
  websearch: "network",
  webfetch: "network",
  background_output: "read",
  task_list: "read",
  task_get: "read",
  task_output: "read",
  todowrite: "read",
  question: "read",
  enter_plan: "read",
  exit_plan: "read",
  bash: "shell",
  write: "edit",
  edit: "edit",
  patch: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  task: "task",
  task_stop: "task",
  background_cancel: "task",
  skill: "task"
}

const TRUSTED_BASH_PATTERNS = [
  /^(pwd|ls|cat|head|tail|wc|which|date|whoami|uname)\b/i,
  /^(rg|grep|find)\b/i,
  /^sed\s+-n\b/i,
  /^git\s+(status|log|diff|show|branch|rev-parse)\b/i,
  /^(node|npm|pnpm|yarn)\s+(--version|-v|version|root|list|ls)\b/i
]

/**
 * 归一为 0.4.0 的四档审批级别。
 *
 * 旧配置按 level → mode → default_policy 的优先级降级读取，命中旧写法时
 * 发一次弃用提示。注意 0.3.x 的 `auto` 语义是「编辑仍需确认」，映射到新的
 * `manual` 而不是 `accept-edits`，升级不会静默放宽权限。
 */
export function normalizePermissionLevel(permission = {}) {
  const rawLevel = String(permission.level || "").toLowerCase().trim()
  if (!rawLevel) return DEFAULT_APPROVAL
  // 0.6.0 起只认四档。旧名（review/auto/edit/full-auto）与 permission.mode /
  // permission.default_policy 已在 schema 层被拒并给出迁移写法，所以能走到
  // 这里的旧名只可能来自绕过校验的内部调用 —— 回落到默认档而不是猜。
  return APPROVAL_LEVELS.includes(rawLevel) ? rawLevel : DEFAULT_APPROVAL
}

export function toolCapability(tool, command = "") {
  const name = String(tool || "")
  if (name === "bash") return trustedBashCommand(command) ? "safe-shell" : "risky-shell"
  return TOOL_CAPABILITIES[name] || "unknown"
}

function trustedBashCommand(command) {
  const cmd = String(command || "").trim()
  if (!cmd) return false
  if (/[;&|<>`]/.test(cmd)) return false
  return TRUSTED_BASH_PATTERNS.some((pattern) => pattern.test(cmd))
}

/** @deprecated 旧 `auto` 档的判定，保留供既有测试与迁移期比对，0.5.0 移除。 */
function autoAllowsTool({ tool, command = "" }) {
  const cap = toolCapability(tool, command)
  return ["read", "search", "network", "safe-shell"].includes(cap)
}

/**
 * 四档审批矩阵。能力分类见 TOOL_CAPABILITIES；bash 另按命令白名单拆成
 * safe-shell / risky-shell。
 *
 *              read/search/network  safe-shell  risky-shell  edit   task
 *   readonly          allow            deny        deny      deny   deny
 *   manual            allow           allow         ask       ask    ask
 *   accept-edits      allow           allow         ask     allow  allow
 *   yolo              allow           allow       allow     allow  allow
 */
function levelAllowsTool({ level, tool, command = "" }) {
  const cap = toolCapability(tool, command)
  if (level === "yolo") return "allow"
  if (level === "readonly") {
    return ["read", "search", "network"].includes(cap) ? "allow" : "deny"
  }
  if (level === "accept-edits") {
    if (["read", "search", "network", "safe-shell", "edit", "task"].includes(cap)) return "allow"
    return "ask"
  }
  // manual（默认）：只读与白名单 shell 自动放行，其余一律询问
  if (["read", "search", "network", "safe-shell"].includes(cap)) return "allow"
  return "ask"
}

function applySensitiveEscalation(decision, { tool, pattern, config, level }) {
  if (level === "yolo") return decision
  const sensitivePolicy = getSensitiveEditPolicy(tool, pattern, config)
  if (sensitivePolicy && decision.action === "allow") {
    return {
      action: sensitivePolicy.action,
      source: sensitivePolicy.source,
      rule: decision.rule || null,
      mode: decision.mode,
      level
    }
  }
  return decision
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
  // workspace 限定「Always Allow」习得的规则，缺省表示全局生效（旧规则语义不变）
  if (rule.workspace && normalizePath(rule.workspace) !== normalizePath(input.workspace || "")) return false

  // File glob matching (for read/write/edit/glob/grep tools)
  if (rule.file_patterns || rule.file_pattern) {
    if (!matchPatterns(input.pattern || "", rule.file_patterns || rule.file_pattern)) return false
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

/**
 * 用户规则优先，其次按审批档判定。
 *
 * 0.3.x 在 level 判定之后还有 mode:yolo / mode:auto / default_policy 三个分支，
 * 但 DEFAULT_CONFIG 恒定注入 permission.level，那三条路径永远不可达。0.4.0 起
 * normalizePermissionLevel 总能给出四档之一，分支随之删除。
 */
export function evaluatePermission({ config, tool, mode, pattern = "*", command = "", risk = 0, workspace = "" }) {
  const permission = config.permission || { rules: [] }
  const permissionLevel = normalizePermissionLevel(permission)
  const rules = Array.isArray(permission.rules) ? permission.rules : []

  for (const rule of rules) {
    if (matchRule(rule, { tool, mode, pattern, command, risk, workspace })) {
      const matchedDecision = {
        action: rule.action,
        source: "rule",
        rule,
        level: permissionLevel
      }
      return applySensitiveEscalation(matchedDecision, { tool, pattern, config, level: permissionLevel })
    }
  }

  const action = levelAllowsTool({ level: permissionLevel, tool, command })
  const decision = {
    action,
    source: `level:${permissionLevel}`,
    rule: null,
    level: permissionLevel
  }
  return applySensitiveEscalation(decision, { tool, pattern, config, level: permissionLevel })
}

// Exported for testing
export { matchGlob, matchPatterns, matchCommandPrefix, trustedBashCommand, autoAllowsTool, levelAllowsTool }
