import { getSensitiveEditPolicy } from "./file-edit-policy.mjs"
import { findProtectedAccess } from "./protected-paths.mjs"
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
  http_request: "network",
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
  // 0.7.0 阶段 3 新增的文件管理工具。remove 默认进回收站（可恢复），
  // 但它仍是 edit 能力 —— 删错文件的代价不因为可恢复就变小。
  move: "edit",
  copy: "edit",
  remove: "edit",
  mkdir: "edit",
  archive: "edit",
  task: "task",
  task_group: "task",
  task_stop: "task",
  background_cancel: "task",
  skill: "task",

  // 0.7.0：以下工具此前全部落到 "unknown"，后果不是策略决定而是漏登记 ——
  // readonly 档下 unknown 一律 deny、accept-edits 档下一律 ask，于是
  // `git status` 这种纯读操作在只读档被拒、在「接受编辑」档还要弹窗，
  // 而同族的 task_list 放行、task_parallel 要问，区别只在于名字有没有
  // 被手写进这张表。
  task_parallel: "read",
  git_status: "read",
  git_info: "read",
  git_list_snapshots: "read",
  git_snapshot: "edit",
  git_restore: "edit",
  git_delete_snapshot: "edit",
  git_cleanup: "edit",
  git_apply_patch: "edit",
  git_auto_stage: "edit",
  git_auto_commit: "edit",
  git_auto_push: "risky-shell",
  git_full_auto_status: "read"
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
    // safe-shell 归入放行：它的定义就是「已判定为只读的命令」——
    // `git status`、`ls`、`cat`、`rg` 之类（见 TRUSTED_BASH_PATTERNS）。
    // 此前把它排除在外，导致 git status 在只读档被拒，而 exec-policy 的
    // allow_git_status 与 TRUSTED_BASH_PATTERNS 都判它安全 —— 三处判定
    // 互相矛盾，用户在最该畅通的档位上反而被挡。
    return ["read", "search", "network", "safe-shell"].includes(cap) ? "allow" : "deny"
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

  // 保护路径检查排在**用户规则之前**，这个顺序本身就是安全属性：
  // 否则仓库里 checked-in 的一条 `{tool:"write", pattern:".git/**",
  // action:"allow"}` 就能把整套保护绕掉 —— 而那条规则可能来自你刚 clone
  // 的别人的仓库。yolo 也不例外：这些位置的写入无法靠 git 回滚补救。
  const protectedHit = findProtectedAccess({ tool, pattern, command })
  if (protectedHit) {
    return {
      action: "ask",
      source: "protected_path",
      rule: null,
      level: permissionLevel,
      protectedPath: protectedHit.path,
      reason: protectedHit.reason
    }
  }

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
