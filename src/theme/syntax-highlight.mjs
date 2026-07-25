import { paint, isColorEnabled } from "./color.mjs"

/**
 * 代码块语法高亮 —— 零依赖、逐行独立。
 *
 * **逐行独立是硬约束，不是偷懒**：markdown 的流式渲染器是行级增量的，
 * 并且有一条「输出与网络分片边界无关」的不变式（test/markdown.test.mjs）。
 * 任何跨行状态（未闭合的块注释、多行字符串）都会让同一份内容因为分片
 * 位置不同而渲染出不同结果。代价是块注释的后续行不会被着色 —— 这个取舍
 * 换来的是渲染结果永远可复现。
 *
 * 安全：输入是已经过 sanitizeTerminalText 的纯文本，这里只添加 SGR 序列。
 * 超长行直接原样返回，避免正则在病理输入上退化。
 */

const MAX_LINE = 2000

/** 占位符：私有区，绝不会出现在 sanitize 过的正文里 */
const TOKEN_OPEN = String.fromCharCode(0xE000)
const TOKEN_BASE = 0xE100
const TOKEN_LIMIT = 0x300
const TOKEN_RE = new RegExp(TOKEN_OPEN + "([" + String.fromCharCode(TOKEN_BASE) + "-" + String.fromCharCode(TOKEN_BASE + TOKEN_LIMIT) + "])", "g")

const KEYWORDS = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "new", "await", "async", "import", "export", "from", "default", "try", "catch", "finally", "throw", "typeof", "instanceof", "delete", "in", "of", "this", "super", "null", "undefined", "true", "false", "break", "continue", "switch", "case", "do", "yield", "static", "get", "set"],
  ts: ["interface", "type", "enum", "implements", "public", "private", "protected", "readonly", "namespace", "declare", "as", "satisfies"],
  python: ["def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "try", "except", "finally", "raise", "with", "lambda", "yield", "pass", "break", "continue", "global", "nonlocal", "assert", "del", "None", "True", "False", "and", "or", "not", "in", "is", "async", "await"],
  bash: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "export", "local", "readonly", "source", "echo", "cd", "set", "unset", "shift", "exit"],
  go: ["func", "package", "import", "return", "if", "else", "for", "range", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "switch", "case", "default", "break", "continue", "nil", "true", "false"],
  rust: ["fn", "let", "mut", "const", "struct", "enum", "impl", "trait", "pub", "use", "mod", "match", "if", "else", "for", "while", "loop", "return", "self", "Self", "where", "async", "await", "move", "ref", "dyn", "true", "false", "None", "Some", "Ok", "Err"],
  c: ["int", "char", "float", "double", "void", "long", "short", "unsigned", "signed", "struct", "union", "enum", "typedef", "static", "const", "extern", "return", "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "sizeof", "goto"],
  java: ["public", "private", "protected", "class", "interface", "extends", "implements", "static", "final", "void", "int", "long", "double", "boolean", "String", "new", "return", "if", "else", "for", "while", "try", "catch", "finally", "throw", "throws", "import", "package", "this", "super", "null", "true", "false"],
  sql: ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "AS", "AND", "OR", "NOT", "NULL", "DISTINCT", "UNION", "WITH"],
  css: ["important", "media", "import", "keyframes", "supports", "font-face", "root"],
  yaml: ["true", "false", "null", "yes", "no", "on", "off"]
}

/** 语言别名 → 内部 key。未列出的语言不高亮（原样返回）。 */
const LANGUAGE_ALIASES = {
  js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
  ts: "ts", typescript: "ts", tsx: "ts",
  json: "json", jsonc: "json",
  py: "python", python: "python", python3: "python",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash", console: "bash",
  yaml: "yaml", yml: "yaml",
  go: "go", golang: "go",
  rs: "rust", rust: "rust",
  c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c",
  java: "java", kotlin: "java", kt: "java",
  html: "html", xml: "html", vue: "html",
  css: "css", scss: "css", less: "css",
  sql: "sql",
  diff: "diff", patch: "diff"
}

const LINE_COMMENT = {
  js: "//", ts: "//", go: "//", rust: "//", c: "//", java: "//", css: "//",
  python: "#", bash: "#", yaml: "#",
  sql: "--"
}

function keywordsFor(lang) {
  if (lang === "ts") return [...KEYWORDS.js, ...KEYWORDS.ts]
  return KEYWORDS[lang] || []
}

export function normalizeLanguage(language) {
  const key = String(language || "").trim().toLowerCase().split(/\s+/)[0]
  return LANGUAGE_ALIASES[key] || null
}

export function isHighlightable(language) {
  return Boolean(normalizeLanguage(language))
}

/**
 * 高亮一行代码。
 * @param {string} line 已 sanitize 的纯文本行
 * @param {string} language fence 上标注的语言
 * @param {object} colors 主题的 markdown 分组
 * @returns {string} 原文或带 SGR 的文本
 */
export function highlightLine(line, language, colors = {}) {
  const text = String(line ?? "")
  if (!isColorEnabled()) return text
  if (!text || text.length > MAX_LINE) return text

  const lang = normalizeLanguage(language)
  if (!lang) return text

  if (lang === "diff") return highlightDiffLine(text, colors)

  const tokens = []
  // 占位符与下标都用私有区字符。用十进制数字当下标时，后面的「数字」
  // 规则会命中占位符内部的数字，把已经着色的关键字再染一遍。
  const hold = (value) => {
    const index = tokens.push(value) - 1
    if (index >= TOKEN_LIMIT) return value
    return TOKEN_OPEN + String.fromCharCode(TOKEN_BASE + index)
  }

  let out = text

  // 顺序要紧：注释与字符串先被摘走，之后的关键字/数字规则就不会碰它们的内容。
  const commentMarker = LINE_COMMENT[lang]
  if (commentMarker) {
    const escaped = commentMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    out = out.replace(new RegExp(`(${escaped}.*)$`), (_, comment) => hold(paint(comment, colors.syntaxComment)))
  }

  out = out
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => hold(paint(m, colors.syntaxString)))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => hold(paint(m, colors.syntaxString)))
    .replace(/`(?:[^`\\\n]|\\.)*`/g, (m) => hold(paint(m, colors.syntaxString)))

  const keywords = keywordsFor(lang)
  if (keywords.length) {
    const pattern = new RegExp(`\\b(${keywords.join("|")})\\b`, lang === "sql" ? "gi" : "g")
    out = out.replace(pattern, (m) => hold(paint(m, colors.syntaxKeyword)))
  }

  out = out
    .replace(/\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (m) => hold(paint(m, colors.syntaxNumber)))
    .replace(/\b([A-Za-z_$][\w$]*)\s*(?=\()/g, (m, name) => hold(paint(name, colors.syntaxFunction)))

  return restore(out, tokens)
}

function highlightDiffLine(text, colors) {
  if (/^\+\+\+|^---/.test(text)) return paint(text, colors.syntaxComment)
  if (text.startsWith("+")) return paint(text, colors.syntaxAdded)
  if (text.startsWith("-")) return paint(text, colors.syntaxRemoved)
  if (text.startsWith("@@")) return paint(text, colors.syntaxFunction)
  return text
}

function restore(text, tokens) {
  let out = text
  for (let pass = 0; pass <= tokens.length; pass++) {
    let replaced = false
    out = out.replace(TOKEN_RE, (_, char) => {
      replaced = true
      return tokens[char.charCodeAt(0) - TOKEN_BASE] ?? ""
    })
    if (!replaced) break
  }
  return out
}
