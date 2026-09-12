/**
 * 「Always Allow」习得规则。
 *
 * 0.3.x 的授权只活在 PermissionEngine 的内存 Map 里，进程退出即丢，用户
 * 每次重启都要把同样的工具重新点一遍。0.4.0 把这类授权落到用户级配置的
 * permission.rules[]，复用既有规则结构，不引入新的判定概念。
 *
 * 刻意写用户级而非项目级：项目目录的 .kkcode/ 未必在用户仓库的
 * .gitignore 里，习得规则会跟着提交出去。规则改带 workspace 字段限定
 * 生效范围，既不泄漏也不会跨项目误放行。
 */

export const LEARNED_RULE_SOURCE = "learned"
export const DEFAULT_LEARNED_RULE_LIMIT = 200

/**
 * bash 命令取前两个 token 作为前缀，`git status --short` → `git status`。
 * 含通配符的输入一律拒绝，避免记出一条放行所有命令的规则。
 */
export function commandPrefixOf(command) {
  const text = String(command || "").trim()
  if (!text || text.includes("*")) return ""
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!tokens.length) return ""
  return tokens.slice(0, 2).join(" ")
}

/**
 * 由一次审批构造习得规则。
 * bash 走 command_prefix，其余工具用具体路径；pattern 为 `*` 时不带路径限定，
 * 表示该工具在此工作区整体放行。
 */
export function buildLearnedRule({ tool, pattern = "*", command = "", workspace = "" }) {
  const name = String(tool || "").trim()
  if (!name) return null

  const rule = { tool: name, action: "allow" }
  if (name === "bash") {
    // 只认真实命令：没有命令就没有可记的范围，宁可不记也不放行全部
    const prefix = commandPrefixOf(command)
    if (!prefix) return null
    rule.command_prefix = prefix
  } else if (pattern && pattern !== "*") {
    rule.file_patterns = [String(pattern)]
  }
  if (workspace) rule.workspace = String(workspace)
  rule.source = LEARNED_RULE_SOURCE
  return rule
}

function sameTarget(a, b) {
  if (a.tool !== b.tool) return false
  if (String(a.workspace || "") !== String(b.workspace || "")) return false
  if (String(a.command_prefix || "") !== String(b.command_prefix || "")) return false
  const listA = JSON.stringify(a.file_patterns || a.file_pattern || null)
  const listB = JSON.stringify(b.file_patterns || b.file_pattern || null)
  return listA === listB
}

/** 是否已有等价规则（含用户手写的），有则无需再记。 */
export function findEquivalentRule(rules, candidate) {
  if (!candidate) return null
  const list = Array.isArray(rules) ? rules : []
  return list.find((rule) => rule && rule.action === candidate.action && sameTarget(rule, candidate)) || null
}

export function isLearnedRule(rule) {
  return Boolean(rule) && rule.source === LEARNED_RULE_SOURCE
}

export function listLearnedRules(rules) {
  return (Array.isArray(rules) ? rules : []).filter(isLearnedRule)
}

/**
 * 追加一条习得规则。纯函数：返回新数组与结果说明，不做 IO。
 * @returns {{rules: Array, added: boolean, reason: string}}
 */
export function appendLearnedRule(rules, candidate, { limit = DEFAULT_LEARNED_RULE_LIMIT } = {}) {
  const list = Array.isArray(rules) ? [...rules] : []
  if (!candidate) return { rules: list, added: false, reason: "invalid" }
  if (findEquivalentRule(list, candidate)) return { rules: list, added: false, reason: "duplicate" }
  if (listLearnedRules(list).length >= limit) return { rules: list, added: false, reason: "limit" }
  list.push(candidate)
  return { rules: list, added: true, reason: "added" }
}

/**
 * 删除习得规则。传 index 删单条（下标是 listLearnedRules 的序号），
 * 传 all 清空全部习得规则；用户手写的规则永远不动。
 */
export function removeLearnedRules(rules, { index = null, all = false } = {}) {
  const list = Array.isArray(rules) ? rules : []
  if (all) {
    const removed = listLearnedRules(list)
    return { rules: list.filter((rule) => !isLearnedRule(rule)), removed }
  }
  const learned = listLearnedRules(list)
  const target = learned[Number(index)]
  if (!target) return { rules: [...list], removed: [] }
  const at = list.indexOf(target)
  return { rules: [...list.slice(0, at), ...list.slice(at + 1)], removed: [target] }
}

/** 单行描述，供 /permission list 展示。 */
export function describeRule(rule) {
  if (!rule) return ""
  const target = rule.command_prefix
    ? `\`${rule.command_prefix}\``
    : (rule.file_patterns || rule.file_pattern)
      ? [].concat(rule.file_patterns || rule.file_pattern).join(", ")
      : "*"
  const scope = rule.workspace ? ` @${rule.workspace}` : ""
  return `${rule.action} ${rule.tool} ${target}${scope}`
}
