/**
 * Glob 匹配与路径归一化。
 *
 * 权限规则（permission/rules.mjs）与敏感文件策略（permission/file-edit-policy.mjs）
 * 此前各自维护了一份逐字符相同的实现，0.4.0 统一到这里。
 *
 * 支持的语法：
 *   *      任意字符（不跨 /）
 *   **     任意字符（跨 /）
 *   ?      单个字符（不跨 /）
 *   !pat   取反，内层模式命中时返回 false
 */

export function globToRegex(pattern) {
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

/** 归一化路径分隔符并折叠 ./ 与 ../，避免用穿越写法绕过模式匹配。 */
export function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .reduce((acc, segment) => {
      if (segment === "..") {
        acc.pop()
        return acc
      }
      if (segment !== "." && segment !== "") acc.push(segment)
      return acc
    }, [])
    .join("/")
}

/** 单模式匹配。`*` 与空模式一律放行；`!` 前缀取反。 */
export function matchGlob(value, pattern) {
  if (!pattern || pattern === "*") return true
  const str = normalizePath(String(value || ""))
  const negate = String(pattern).startsWith("!")
  const pat = negate ? String(pattern).slice(1) : String(pattern)
  const matched = globToRegex(pat).test(str)
  return negate ? !matched : matched
}

/**
 * 多模式匹配：正向模式取 OR，任一反向模式命中即整体拒绝。
 * 传入单个字符串时按单模式处理；空列表放行。
 */
export function matchPatterns(value, patterns) {
  if (!patterns) return true
  const list = Array.isArray(patterns) ? patterns : [patterns]
  if (!list.length) return true
  const positives = list.filter((p) => !String(p).startsWith("!"))
  const negatives = list.filter((p) => String(p).startsWith("!"))
  for (const neg of negatives) {
    if (!matchGlob(value, neg)) return false // negation matched → excluded
  }
  if (!positives.length) return true
  return positives.some((p) => matchGlob(value, p))
}
