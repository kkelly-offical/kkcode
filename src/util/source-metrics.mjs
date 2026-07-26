/**
 * 源码结构度量：函数边界、行数、判定点。
 *
 * 抽成接受**文本**（而不是文件路径）的纯函数，是为了让行尾这种事可以被直接测。
 * 仓库里没有 .gitattributes，Windows 上 git 可能按 CRLF 签出 —— 那时按 `\n`
 * 切出来的每一行尾部都带着 `\r`，于是「这一行是不是恰好等于缩进 + `}`」永远为假，
 * 每个函数都被算到文件末尾，判定点爆表。
 *
 * 这是本项目第四次栽在 Windows 与 POSIX 的分歧上（前三次：裸路径不是合法的 ESM
 * specifier、占用中的锁 EPERM vs EEXIST、路径分隔符）。所以这次的断言写在**在
 * Linux 上也会红**的单测里，而不是等 Windows 的 CI 告诉我们。
 */

/** 判定点：分支与短路运算。它比行数更能预测「改起来危不危险」。 */
const DECISION = /\b(if|for|while|case|catch)\b|&&|\|\||\?\?/g

/** 剥掉注释与字符串 —— 否则文案里的 `if`、`||` 会被算成判定点。 */
export function stripCommentsAndStrings(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
}

/** 统一行尾再切行。CRLF 与 CR 都要处理 —— 见文件头。 */
export function toLines(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n")
}

/**
 * 列出源码里的具名函数声明及其规模。
 *
 * 边界靠缩进匹配的收尾大括号判定 —— 对本仓库的风格够用，且不需要引入解析器。
 * 前提是行尾已经统一，否则边界一个都找不到。
 *
 * @returns {Array<{name: string, line: number, lines: number, decisions: number}>}
 */
export function measureFunctions(text) {
  const src = toLines(text)
  const out = []
  for (let i = 0; i < src.length; i++) {
    const match = src[i].match(/^(\s*)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
    if (!match) continue
    const closing = " ".repeat(match[1].length) + "}"
    let j = i + 1
    while (j < src.length && src[j] !== closing) j++
    const body = stripCommentsAndStrings(src.slice(i, j + 1).join("\n"))
    out.push({
      name: match[2],
      line: i + 1,
      lines: j - i + 1,
      decisions: (body.match(DECISION) || []).length
    })
  }
  return out
}

/** 行数。与 measureFunctions 用同一套行尾归一，免得两处数出不同的值。 */
export function countLines(text) {
  return toLines(text).length
}
