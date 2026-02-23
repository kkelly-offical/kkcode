/**
 * 执行策略 (Execution Policy)
 * 
 * 定义 AI Agent 执行命令的安全规则。
 * 参考 Codex 的设计理念：
 * - AI 可以修改文件（通过 patch）
 * - AI 可以查看 Git 状态
 * - AI 不能执行某些危险操作（如 git commit, git push）
 * 
 * 安全原则：
 * 1. 最小权限原则 - AI 只拥有完成任务必需的最小权限
 * 2. 用户保留控制权 - 关键操作（commit/push）必须由用户手动执行
 * 3. 透明可审计 - 所有策略决策都有明确的原因
 */

/**
 * 决策类型
 */
export const Decision = {
  ALLOW: "allow",       // 允许执行
  FORBID: "forbid",     // 禁止执行
  WARN: "warn",         // 警告但允许（记录日志）
  CONFIRM: "confirm"    // 需要用户确认
}

/**
 * 规则匹配器
 */
function createMatcher(pattern) {
  if (typeof pattern === "string") {
    return (cmd) => cmd.includes(pattern)
  }
  if (pattern instanceof RegExp) {
    return (cmd) => pattern.test(cmd)
  }
  if (Array.isArray(pattern)) {
    // RegExp 数组：任一匹配即命中
    if (pattern[0] instanceof RegExp) {
      return (cmd) => pattern.some(re => re.test(cmd))
    }
    // 字符串数组：按顺序包含所有元素（用于匹配 git commit）
    return (cmd) => {
      const parts = cmd.toLowerCase().split(/\s+/)
      let patternIdx = 0
      for (const part of parts) {
        if (patternIdx < pattern.length && part === pattern[patternIdx].toLowerCase()) {
          patternIdx++
        }
      }
      return patternIdx === pattern.length
    }
  }
  return () => false
}

/**
 * 执行策略规则
 */
const DEFAULT_RULES = [
  // =========================================================================
  // 高危操作 - 禁止
  // =========================================================================
  
  {
    name: "forbid_git_commit",
    pattern: ["git", "commit"],
    decision: Decision.FORBID,
    reason: "AI cannot directly create git commits. Use git_snapshot to create temporary snapshots instead. Users must manually run 'git commit' to finalize changes.",
    category: "git_safety"
  },
  {
    name: "forbid_git_push",
    pattern: ["git", "push"],
    decision: Decision.FORBID,
    reason: "AI cannot push to remote repositories. Users must manually review and push changes.",
    category: "git_safety"
  },
  {
    name: "forbid_git_force_push",
    pattern: [/git\s+push\s+.*--force/, /git\s+push\s+.*-f\b/],
    decision: Decision.FORBID,
    reason: "Force push is extremely dangerous and can overwrite remote history. Never allowed for AI.",
    category: "git_safety"
  },
  {
    name: "forbid_git_reset_hard",
    pattern: ["git", "reset", "--hard"],
    decision: Decision.FORBID,
    reason: "Hard reset destroys uncommitted changes. Use git_restore with a snapshot ID instead.",
    category: "git_safety"
  },
  {
    name: "forbid_git_clean_fd",
    pattern: [/git\s+clean\s+.*-f/, /git\s+clean\s+.*-d/],
    decision: Decision.FORBID,
    reason: "git clean -f/-d deletes untracked files and directories. Dangerous operation.",
    category: "git_safety"
  },
  
  // =========================================================================
  // 文件系统危险操作 - 禁止
  // =========================================================================
  
  {
    name: "forbid_rm_rf",
    pattern: [/rm\s+-rf?\s+\//, /rm\s+.*\*\s+.*\/\.\.?/],
    decision: Decision.FORBID,
    reason: "Dangerous file deletion pattern detected. Cannot delete system directories or use wildcards with relative path traversals.",
    category: "fs_safety"
  },
  {
    name: "forbid_dd_disk",
    pattern: [/dd\s+.*of=\/dev\//],
    decision: Decision.FORBID,
    reason: "Direct disk write operations are forbidden.",
    category: "fs_safety"
  },
  {
    name: "forbid_mkfs",
    pattern: ["mkfs"],
    decision: Decision.FORBID,
    reason: "Filesystem formatting operations are forbidden.",
    category: "fs_safety"
  },
  
  // =========================================================================
  // 网络危险操作 - 禁止
  // =========================================================================
  
  {
    name: "forbid_curl_pipe_sh",
    pattern: [/curl\s+.*\|\s*(ba)?sh/, /wget\s+.*\|\s*(ba)?sh/],
    decision: Decision.FORBID,
    reason: "Piping curl/wget output directly to shell is dangerous and can execute arbitrary code.",
    category: "network_safety"
  },
  
  // =========================================================================
  // 权限提升操作 - 需要确认
  // =========================================================================
  
  {
    name: "confirm_sudo",
    pattern: ["sudo"],
    decision: Decision.CONFIRM,
    reason: "Command requires elevated privileges. Please confirm this is necessary.",
    category: "privilege"
  },
  {
    name: "confirm_chmod_777",
    pattern: [/chmod\s+.*777/],
    decision: Decision.WARN,
    reason: "777 permissions grant full access to everyone. Consider using more restrictive permissions.",
    category: "privilege"
  },
  
  // =========================================================================
  // Git 信息查看 - 允许
  // =========================================================================
  
  {
    name: "allow_git_status",
    pattern: ["git", "status"],
    decision: Decision.ALLOW,
    reason: "Reading git status is safe and necessary.",
    category: "git_read"
  },
  {
    name: "allow_git_log",
    pattern: ["git", "log"],
    decision: Decision.ALLOW,
    reason: "Reading git history is safe.",
    category: "git_read"
  },
  {
    name: "allow_git_diff",
    pattern: ["git", "diff"],
    decision: Decision.ALLOW,
    reason: "Reading git diff is safe.",
    category: "git_read"
  },
  {
    name: "allow_git_show",
    pattern: ["git", "show"],
    decision: Decision.ALLOW,
    reason: "Reading commit details is safe.",
    category: "git_read"
  }
]

/**
 * 执行策略评估结果
 */
export class PolicyResult {
  constructor(decision, rule, reason, category) {
    this.decision = decision
    this.rule = rule
    this.reason = reason
    this.category = category
  }
  
  isAllowed() {
    return this.decision === Decision.ALLOW
  }
  
  isForbidden() {
    return this.decision === Decision.FORBID
  }
  
  needsConfirmation() {
    return this.decision === Decision.CONFIRM
  }
}

/**
 * 评估命令是否符合执行策略
 * 
 * @param {string} command - 要评估的命令
 * @param {Object} options - 选项
 * @param {boolean} [options.strict=false] - 严格模式（默认禁止任何未明确允许的操作）
 * @param {Array} [options.customRules=[]] - 自定义规则
 * @returns {PolicyResult}
 */
export function evaluateCommand(command, options = {}) {
  const { strict = false, customRules = [] } = options
  const rules = [...customRules, ...DEFAULT_RULES]
  
  const normalizedCmd = String(command || "").trim()
  
  for (const rule of rules) {
    const matcher = createMatcher(rule.pattern)
    if (matcher(normalizedCmd)) {
      return new PolicyResult(
        rule.decision,
        rule.name,
        rule.reason,
        rule.category
      )
    }
  }
  
  // 严格模式：未匹配任何规则则禁止
  if (strict) {
    return new PolicyResult(
      Decision.FORBID,
      "strict_mode",
      "Command not in allowlist (strict mode)",
      "strict"
    )
  }
  
  // 默认允许
  return new PolicyResult(
    Decision.ALLOW,
    "default",
    "No policy rules matched, allowing by default",
    "default"
  )
}

/**
 * 检查 bash 工具调用是否被允许
 *
 * @param {string} command - 命令
 * @param {Object} config - 配置
 * @returns {{allowed: boolean, reason?: string, warning?: string}}
 */
export function checkBashAllowed(command, config = {}) {
  // 全自动化模式检查
  const fullAuto = config.git_auto?.full_auto === true
  const allowDangerous = config.git_auto?.allow_dangerous_ops === true
  
  // 检查是否配置了全局禁止 git commit/push
  // 全自动化模式下，如果 auto_commit/auto_push 启用，则允许
  const autoCommit = fullAuto && config.git_auto?.auto_commit === true
  const autoPush = fullAuto && config.git_auto?.auto_push === true
  
  if (!autoCommit && config.git_auto?.forbid_commit !== false) {
    const commitPattern = /^git\s+commit\b/i
    if (commitPattern.test(command)) {
      return {
        allowed: false,
        reason: "git commit is forbidden for AI. Use git_snapshot to create temporary snapshots, then manually commit when satisfied. Or enable git_auto.full_auto and git_auto.auto_commit for automatic commits."
      }
    }
  }
  
  if (!autoPush && config.git_auto?.forbid_push !== false) {
    const pushPattern = /^git\s+push\b/i
    if (pushPattern.test(command)) {
      return {
        allowed: false,
        reason: "git push is forbidden for AI. Users must manually review and push changes. Or enable git_auto.full_auto and git_auto.auto_push for automatic pushes."
      }
    }
  }
  
  // 执行完整策略评估
  const result = evaluateCommand(command)
  
  if (result.isForbidden()) {
    // 全自动化模式下，危险操作可能被允许（如果 allow_dangerous_ops 启用）
    if (fullAuto && allowDangerous && result.category === "git_safety") {
      return {
        allowed: true,
        warning: `Dangerous operation allowed in full-auto mode: ${result.reason}`
      }
    }
    
    if (fullAuto && allowDangerous) {
      return {
        allowed: true,
        warning: `Operation allowed in full-auto mode with dangerous_ops enabled: ${result.reason}`
      }
    }
    
    return {
      allowed: false,
      reason: result.reason
    }
  }
  
  return { allowed: true }
}

/**
 * 获取当前执行策略模式
 *
 * @param {Object} config - 配置
 * @returns {{mode: string, restrictions: string[]}}
 */
export function getPolicyMode(config = {}) {
  if (config.git_auto?.full_auto === true) {
    const restrictions = []
    if (config.git_auto?.auto_commit !== true) restrictions.push("no_auto_commit")
    if (config.git_auto?.auto_push !== true) restrictions.push("no_auto_push")
    if (config.git_auto?.allow_dangerous_ops !== true) restrictions.push("no_dangerous_ops")
    
    return {
      mode: "full_auto",
      restrictions: restrictions.length > 0 ? restrictions : ["none"]
    }
  }
  
  return {
    mode: "safe",
    restrictions: ["no_commit", "no_push", "no_dangerous_ops"]
  }
}

/**
 * 检查是否为全自动化模式
 */
export function isFullAutoMode(config = {}) {
  return config.git_auto?.full_auto === true
}

/**
 * 获取所有禁止的规则（用于文档）
 */
export function getForbiddenRules() {
  return DEFAULT_RULES
    .filter(r => r.decision === Decision.FORBID)
    .map(r => ({
      name: r.name,
      pattern: Array.isArray(r.pattern) ? r.pattern.join(" ") : r.pattern.toString(),
      reason: r.reason
    }))
}

/**
 * 检查是否为 Git 相关操作
 */
export function isGitCommand(command) {
  return /^git\s+/i.test(String(command || ""))
}
