/**
 * `@` 补全的模糊排序。
 *
 * ## 为什么是分档而不是一个连续的打分函数
 *
 * 用户敲 `repl` 的时候，`src/repl.mjs` 必须排在 `src/tool/registry.mjs`（子序列命中
 * r-e-p-l）前面 —— 无论后者的路径多短。一个把「命中位置」「路径长度」「层级」加权求和的
 * 连续函数总能被某个够短的路径翻盘，而那种翻盘只会在真实仓库里偶发地出现一次，没人测得到。
 * 所以先分档，档内才比细节：**档间差 200 分，档内的惩罚总和封顶 140 分**，跨不过去。
 *
 * 档次：完整路径前缀 > 文件名前缀 > 文件名子串 > 路径子串 > 路径子序列。
 * （路径子串是子序列的特例，排在它前面。）
 *
 * ## matched 区间
 *
 * `[[start, end], ...]`，end 独占，索引对着**原始 path**，给 UI 高亮用。
 * 大小写不敏感匹配是靠 `toLowerCase()` 做的，而个别字符小写之后长度会变（土耳其语的 İ），
 * 那会让区间整体错位。所以每个候选都先验一次「小写前后长度一致」，不一致就对这个候选退回
 * 大小写敏感匹配 —— 宁可少一条候选，也不要给出对不上的高亮。
 */

const TIER_SCORE = [1000, 800, 600, 400, 200]

const DEFAULT_LIMIT = 30

function baseNameStart(path) {
  const slash = path.lastIndexOf("/")
  return slash < 0 ? 0 : slash + 1
}

function countSlashes(path) {
  let n = 0
  for (let i = 0; i < path.length; i++) if (path[i] === "/") n++
  return n
}

/**
 * 子序列命中的区间表，命不中返回 null。相邻的命中会合并成一段，免得 UI 高亮成一串碎片。
 * 逐**码点**推进（不是码元），这样 emoji 与生僻字的区间不会切在代理对中间。
 */
function subsequenceRanges(haystack, needle) {
  const ranges = []
  let from = 0
  for (const ch of needle) {
    const at = haystack.indexOf(ch, from)
    if (at < 0) return null
    const last = ranges[ranges.length - 1]
    if (last && last[1] === at) last[1] = at + ch.length
    else ranges.push([at, at + ch.length])
    from = at + ch.length
  }
  return ranges
}

/** 定档 + 算区间。haystack/needle 已经按同一套大小写策略处理过。 */
function classify(haystack, needle) {
  const nameAt = baseNameStart(haystack)
  const name = haystack.slice(nameAt)
  if (haystack.startsWith(needle)) return { tier: 0, ranges: [[0, needle.length]] }
  if (name.startsWith(needle)) return { tier: 1, ranges: [[nameAt, nameAt + needle.length]] }
  const inName = name.indexOf(needle)
  if (inName >= 0) return { tier: 2, ranges: [[nameAt + inName, nameAt + inName + needle.length]] }
  const inPath = haystack.indexOf(needle)
  if (inPath >= 0) return { tier: 3, ranges: [[inPath, inPath + needle.length]] }
  const ranges = subsequenceRanges(haystack, needle)
  return ranges ? { tier: 4, ranges } : null
}

/**
 * 档内的细节比较，全部写成**惩罚**（越小越好）并各自封顶，总和不超过 140 < 档间距 200。
 * 依次是：命中越靠前越好、路径越短越好、层级越浅越好、命中越紧凑越好。
 */
function penalty(path, hit, needleLength) {
  const start = hit.ranges[0][0]
  const span = hit.ranges[hit.ranges.length - 1][1] - start
  return Math.min(start, 60) * 0.5
    + Math.min(path.length, 200) * 0.25
    + Math.min(countSlashes(path), 20) * 2
    + Math.min(Math.max(span - needleLength, 0), 100) * 0.2
}

/**
 * @param {string[]} files  `/` 分隔的相对路径清单（通常来自 createFileIndex().list()）
 * @param {string} query    去掉 `@` 之后的查询串，可以为空
 * @param {{limit?: number}} [options]
 * @returns {Array<{path: string, score: number, matched: Array<[number, number]>}>}
 *          score 越大越好。空 query 时按路径序返回前 limit 个（**不是空清单** —— 刚敲下
 *          `@` 就该看见东西，否则用户以为补全没生效）。
 */
export function rankCandidates(files, query, { limit = DEFAULT_LIMIT } = {}) {
  const all = Array.isArray(files) ? files : []
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT
  const raw = String(query ?? "")
  if (!raw) {
    return [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, cap)
      .map((path) => ({ path, score: 0, matched: [] }))
  }

  const lowerQuery = raw.toLowerCase()
  const foldable = lowerQuery.length === raw.length
  const out = []
  for (const path of all) {
    const lower = path.toLowerCase()
    // 小写后长度变了就对这个候选退回大小写敏感 —— 见文件头
    const fold = foldable && lower.length === path.length
    const hit = classify(fold ? lower : path, fold ? lowerQuery : raw)
    if (!hit) continue
    out.push({
      path,
      score: TIER_SCORE[hit.tier] - penalty(path, hit, raw.length),
      matched: hit.ranges
    })
  }
  // 长度与层级已经写进 penalty 了，这里**不再**重复比一遍 —— 同一个偏好落在两处的话，
  // 改动其中一处不会有任何测试变红，另一处就变成了没人守的死规则。
  // 剩下的字典序只管一件事：分数真的相同时输出稳定，不随入参顺序漂。
  return out
    .sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, cap)
}
