/**
 * 编辑失败的诊断。
 *
 * `edit` 零匹配此前只返回两个词：`no match`。模型拿到它唯一能做的就是重读
 * 整个文件再猜一次 —— 这是最贵的自我纠正路径，而且经常反复失败。
 *
 * 调研五家前沿工具后，这一点上的分野最明显，最好的一条是 Roo Code：它回传
 * 相似度分数、带行号的最接近匹配、周边原文窗口，以及一句下一步该做什么。
 * Aider 用 SequenceMatcher 做同样的事（`find_similar_lines`，阈值 0.6）。
 *
 * **这里刻意只做诊断，不放宽匹配。** 匹配仍然是精确的。宽松匹配最危险的
 * 失败不是「匹配不到」（会报错、可恢复），而是「匹配到一个大得多的块然后
 * 静默吞掉」—— 不可逆的数据损失，且模型不会察觉。真要引入宽松匹配，必须
 * 同时带上 opencode 的 isDisproportionateMatch 守卫（见 guardProportion）。
 */

/** 认为「值得展示给模型」的最低相似度。低于此不如不给，免得误导。 */
const SIMILARITY_FLOOR = 0.5

/** 最接近匹配前后各展示多少行上下文 */
const CONTEXT_LINES = 4

/** 超过这个规模就不做滑窗比对了 —— 诊断不该自己变成性能问题 */
const MAX_DIAGNOSE_LINES = 20000

/**
 * 归一化后的行相似度（0..1）。
 *
 * 先做「视觉等价」归一化：折叠空白、去掉首尾空格。绝大多数失配就是缩进或
 * 行尾空白的差异，归一化后能一眼看出「你只差个空格」。
 */
function lineSimilarity(a, b) {
  const x = String(a).replace(/\s+/g, " ").trim()
  const y = String(b).replace(/\s+/g, " ").trim()
  if (x === y) return 1
  if (!x.length || !y.length) return 0

  // Dice 系数（二元组）。比 Levenshtein 便宜，对「差几个字符」的判别足够。
  const bigrams = (s) => {
    const out = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      out.set(g, (out.get(g) || 0) + 1)
    }
    return out
  }
  const left = bigrams(x)
  const right = bigrams(y)
  let shared = 0
  for (const [g, n] of left) shared += Math.min(n, right.get(g) || 0)
  const total = Math.max(1, (x.length - 1) + (y.length - 1))
  return (2 * shared) / total
}

/** 多行块的相似度：逐行取平均，行数不等时按较长的一方补零 */
function blockSimilarity(wanted, actual) {
  const rows = Math.max(wanted.length, actual.length)
  let sum = 0
  for (let i = 0; i < rows; i++) {
    sum += lineSimilarity(wanted[i] ?? "", actual[i] ?? "")
  }
  return sum / rows
}

/**
 * 在文件里滑窗找与 `before` 最接近的块。
 *
 * @returns {{startLine: number, similarity: number, lines: string[]}|null}
 *   startLine 是 1-based
 */
export function findClosestBlock(content, before) {
  const fileLines = String(content).split("\n")
  const wanted = String(before).split("\n")
  if (!wanted.length || fileLines.length > MAX_DIAGNOSE_LINES) return null

  let best = null
  const span = wanted.length
  for (let i = 0; i + 1 <= fileLines.length; i++) {
    const window = fileLines.slice(i, i + span)
    const score = blockSimilarity(wanted, window)
    if (!best || score > best.similarity) {
      best = { startLine: i + 1, similarity: score, lines: window }
    }
    if (best.similarity === 1) break
  }
  return best && best.similarity >= SIMILARITY_FLOOR ? best : null
}

/** 带行号渲染，供模型对照 */
function numbered(lines, startLine) {
  return lines.map((line, i) => `${String(startLine + i).padStart(6)}→${line}`).join("\n")
}

/**
 * 零匹配时的诊断文本。
 *
 * 结构照 Roo Code 的三段式：诊断 → 证据 → 下一步。
 * 找不到足够接近的块时也要说清「文件多少行、你的片段多少行」，
 * 这比 `no match` 有用得多。
 */
export function diagnoseNoMatch({ path: filePath, content, before }) {
  const fileLines = String(content).split("\n")
  const wanted = String(before).split("\n")
  const best = findClosestBlock(content, before)

  const head = [
    `no match for the given text in ${filePath}`,
    "",
    "Debug Info:",
    `- File length: ${fileLines.length} lines`,
    `- Your snippet: ${wanted.length} line(s), ${String(before).length} chars`
  ]

  if (!best) {
    head.push(
      "- Closest match: none above 50% similarity",
      "- Tip: the text may have changed or may live in another file. Re-read the file, or use grep to locate it."
    )
    return head.join("\n")
  }

  const percent = Math.round(best.similarity * 100)
  const from = Math.max(1, best.startLine - CONTEXT_LINES)
  const to = Math.min(fileLines.length, best.startLine + best.lines.length - 1 + CONTEXT_LINES)
  const window = fileLines.slice(from - 1, to)

  head.push(
    `- Closest match: ${percent}% similar, starting at line ${best.startLine}`,
    whitespaceOnlyDifference(wanted, best.lines)
      ? "- The only difference is whitespace or indentation — copy the exact bytes from the file."
      : "- Tip: copy the exact text from the read output, including indentation, and retry.",
    "",
    "Best Match Found:",
    numbered(best.lines, best.startLine),
    "",
    "Surrounding Content:",
    numbered(window, from)
  )
  return head.join("\n")
}

/** 差异是否只在空白 —— 这是最常见的失配原因，值得单独指出来 */
function whitespaceOnlyDifference(wanted, actual) {
  if (wanted.length !== actual.length) return false
  return wanted.every((line, i) =>
    String(line).replace(/\s+/g, "") === String(actual[i] ?? "").replace(/\s+/g, "")
  )
}

/**
 * 不成比例匹配守卫（抄 opencode 的 isDisproportionateMatch）。
 *
 * 这个函数现在没有调用点 —— 精确匹配不需要它。它存在是为了让「将来引入
 * 宽松匹配」这件事有现成的闸门：那一刻最危险的不是匹配失败，而是匹配到
 * 一个大得多的块然后整块替换掉，静默造成不可逆的数据损失。
 *
 * @returns {boolean} true 表示匹配跨度大得可疑，应当拒绝
 */
export function guardProportion(wantedText, matchedText) {
  const wantedLines = String(wantedText).split("\n").length
  const matchedLines = String(matchedText).split("\n").length
  if (matchedLines >= Math.max(wantedLines + 3, wantedLines * 2)) return true
  if (wantedLines === 1) return false
  const wantedLen = String(wantedText).trim().length
  return String(matchedText).trim().length > Math.max(wantedLen + 500, wantedLen * 4)
}
