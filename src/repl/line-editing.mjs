/**
 * 行编辑内核（0.7.3）：emacs 风格的行内移动、按词/按行删除，以及历史反向搜索。
 *
 * 这里只有纯函数 —— 输入是 `(text, index)`，输出是新的 `text` 与新的 `cursor`。
 * 按键绑定、渲染、历史落盘都在别处；这样每一条边界情形（emoji、组合字符、中文、
 * 逻辑换行）都能被直接测到，而不用先造出一个终端。
 *
 * **不变量：光标是 JS 字符串索引（UTF-16 code unit），且必须落在 grapheme 边界上。**
 * 输入框里一个 `👨‍👩‍👧‍👦` 是 11 个 code unit、1 个可见字符；任何把光标停在它中间的
 * 位置都会让 text-layout 的行布局与终端硬件光标对不上。所以本模块所有对外函数
 * 都先把传入的 index 夹到 grapheme 边界，返回的 cursor 也一定在边界上，
 * 且 grapheme 切分一律复用 text-layout 的导出，不在这里另起一套。
 */

import { moveGraphemeCursor, splitGraphemes } from "./text-layout.mjs"

/**
 * 逻辑行的分隔符。输入框支持 Shift+Enter 换行，`ui.input` 里存的是真的换行符，
 * 所以「行首/行尾」指的是逻辑行，不是终端里被宽度折出来的视觉行。
 * `\r` 一并认，因为粘贴进来的文本可能带 CRLF。
 */
const NEWLINE_RE = /[\r\n]/

/**
 * 字符分类。写成查表 / 区间数组而不是长条件链：一来 `test/repl-architecture` 的
 * 判定点上限是 60，一串 `||` 很容易撞上去；二来区间带着注释比条件链好读。
 */
const CLASS = {
  space: "space",
  cjk: "cjk",
  word: "word",
  other: "other"
}

/**
 * CJK 文字本体：表意文字、假名、谚文、注音。
 *
 * 不含 emoji 区（U+1F000–U+1FAFF）—— text-layout 的 `isWideCodePoint` 把它算进
 * 宽字符是为了算显示宽度，这里算的是词边界，emoji 归 `other`。
 */
const CJK_SCRIPT_RANGES = [
  [0x1100, 0x11ff],   // 谚文字母 Jamo
  [0x2e80, 0x2fff],   // CJK 部首补充、康熙部首、表意文字描述符
  [0x3040, 0x30ff],   // 平假名、片假名（含长音符 ー、中点 ・）
  [0x3100, 0x312f],   // 注音符号
  [0x3130, 0x318f],   // 谚文兼容字母
  [0x31c0, 0x31ff],   // CJK 笔画、片假名音标扩展
  [0x3200, 0x33ff],   // 带圈/带括号 CJK 字母、CJK 兼容
  [0x3400, 0x4dbf],   // CJK 扩展 A
  [0x4e00, 0x9fff],   // CJK 统一表意文字
  [0xa960, 0xa97f],   // 谚文字母扩展 A
  [0xac00, 0xd7ff],   // 谚文音节 + 谚文字母扩展 B
  [0xf900, 0xfaff],   // CJK 兼容表意文字
  [0xff66, 0xff9f],   // 半角片假名
  [0x1b000, 0x1b16f], // 假名补充、假名扩展
  [0x20000, 0x3fffd]  // CJK 扩展 B–I 与兼容补充（区间取法同 text-layout）
]

/**
 * 全角标点。**它被算进 CJK 类**，因为任务把分类定成「CJK（含中日韩统一表意
 * 文字、假名、全角标点）」。
 *
 * 后果要说在明处：`你好，世界` 整串同类，于是按词删除会一次吞掉整句，而不是
 * 停在 `，` 前。若要改成「全角标点是词边界」（emacs 对中文的常见做法），把下面
 * 这个数组从 `CJK_RANGES` 的展开里去掉即可 —— 它会自然落进 `other` 类，
 * 其余逻辑一行都不用动。
 *
 * U+3000 表意空格不在这里：它由 `\s` 先一步判成空白（见 `classifyCluster`）。
 */
const FULLWIDTH_PUNCT_RANGES = [
  [0x3001, 0x303f],   // 、。〈〉《》「」【】…
  [0xfe10, 0xfe19],   // 竖排标点
  [0xfe30, 0xfe4f],   // CJK 兼容形式（竖排括号、破折号）
  [0xff01, 0xff0f],   // ！＂＃＄％＆＇（）＊＋，－．／
  [0xff1a, 0xff20],   // ：；＜＝＞？＠
  [0xff3b, 0xff40],   // ［＼］＾＿｀
  [0xff5b, 0xff65],   // ｛｜｝～｟｠ 与半角 ｡｢｣､･
  [0xffe0, 0xffe6]    // ￠￡￥￦ 等全角符号
]

const CJK_RANGES = [...CJK_SCRIPT_RANGES, ...FULLWIDTH_PUNCT_RANGES]

/** `\s` 已经覆盖 U+3000 表意空格、U+00A0 不换行空格与各种 U+2000 段空格。 */
const WHITESPACE_RE = /\s/

/**
 * 单词字符：字母、数字、组合记号，外加 `_` 与 `-`。
 *
 * `\p{L}` 也会命中汉字，所以 CJK 必须**先**判 —— 顺序是这套分类的一部分。
 * `\p{M}` 收的是「整簇的基字符本身就是组合记号」这种畸形输入，正常的 `é`
 * 基字符是 `e`，走 `\p{L}`。
 */
const WORD_RE = /[\p{L}\p{N}\p{M}]/u
const WORD_EXTRA = new Set(["_", "-"])

function inRanges(code, ranges) {
  for (const [low, high] of ranges) {
    if (code >= low && code <= high) return true
  }
  return false
}

/**
 * 判定一个 grapheme 簇的类别，依据是它的**基码点**（第一个码点）。
 *
 * 按簇而不是按码点分类，是「emoji 与组合字符不能被劈开」这条要求的落点：
 * `👨‍👩‍👧‍👦` 是一个簇、`é`（e + U+0301）是一个簇，词边界只可能落在簇与簇之间。
 */
function classifyCluster(cluster) {
  const text = String(cluster || "")
  if (!text) return CLASS.other
  const head = String.fromCodePoint(text.codePointAt(0))
  if (WHITESPACE_RE.test(head)) return CLASS.space
  if (inRanges(head.codePointAt(0), CJK_RANGES)) return CLASS.cjk
  if (WORD_EXTRA.has(head) || WORD_RE.test(head)) return CLASS.word
  return CLASS.other
}

/**
 * 把任意 index 夹到最近的（不超过它的）grapheme 边界，同时兼做越界与 NaN 的钳位。
 *
 * 复用 `moveGraphemeCursor(text, index, 0)`：delta 为 0 时它只做归一化不做移动，
 * 于是 grapheme 边界的定义在整个 REPL 里仍然只有一份。
 * （`test/repl-line-editing` 里有专门一条钉住这个行为，免得哪天 delta 为 0
 * 被「优化」成直接返回入参而这里静默失效。）
 */
function clampToGrapheme(text, index) {
  return moveGraphemeCursor(text, index, 0)
}

/** 带类别的 grapheme 簇序列。所有扫描都在这上面走，而不是在码点上走。 */
function clustersOf(text) {
  return splitGraphemes(text).map((part) => ({
    index: part.index,
    end: part.end,
    kind: classifyCluster(part.text)
  }))
}

/** 光标左边有几个完整的簇 —— 也就是「光标停在第几个簇之前」。 */
function clusterSlotAt(parts, cursor) {
  let slot = 0
  while (slot < parts.length && parts[slot].end <= cursor) slot += 1
  return slot
}

/**
 * 当前逻辑行的行首：上一个换行符之后的位置，没有换行符就是 0。
 *
 * 注意是**逻辑行**：`a\nb` 里光标在 `b` 上时行首是 2，不是 0。Ctrl+A 因此停在
 * 当前这一行的开头，不会一路飞到多行输入的最上面。
 */
export function lineStart(value, index) {
  const text = String(value || "")
  const cursor = clampToGrapheme(text, index)
  for (let at = cursor - 1; at >= 0; at -= 1) {
    if (NEWLINE_RE.test(text[at])) return at + 1
  }
  return 0
}

/**
 * 当前逻辑行的行尾：下一个换行符的位置（即换行符**之前**），没有就是文本末尾。
 *
 * 光标恰在换行符前时返回的就是光标自身 —— 「已经在行尾」这个状态由调用方
 * （`deleteToLineEnd`）据此识别。
 */
export function lineEnd(value, index) {
  const text = String(value || "")
  const cursor = clampToGrapheme(text, index)
  for (let at = cursor; at < text.length; at += 1) {
    if (NEWLINE_RE.test(text[at])) return at
  }
  return text.length
}

/**
 * 前一个词的起点（Alt+B / Ctrl+W 的落点）。
 *
 * emacs 语义：先跳过光标左侧的连续空白，再整体吃掉一段同类字符。
 * 「同类」按 `classifyCluster` 的四类算，跨类即边界 —— 于是 `abc中文` 在
 * `abc` 与 `中文` 之间有边界，而 `snake_case` 因为 `_` 也是单词字符而不被拆开。
 * 驼峰**不**拆：`camelCase` 全是字母、同一类，这是明确的选择而不是遗漏，
 * 因为拆驼峰会让 Ctrl+W 在写英文散文时变得话痨。
 */
export function wordStartBefore(value, index) {
  const text = String(value || "")
  const cursor = clampToGrapheme(text, index)
  const parts = clustersOf(text)
  let slot = clusterSlotAt(parts, cursor)
  while (slot > 0 && parts[slot - 1].kind === CLASS.space) slot -= 1
  if (slot === 0) return 0
  const kind = parts[slot - 1].kind
  while (slot > 0 && parts[slot - 1].kind === kind) slot -= 1
  return parts[slot].index
}

/**
 * 后一个词的终点（Alt+F / Alt+D 的落点）。规则与 `wordStartBefore` 镜像：
 * 先跳过右侧连续空白，再吃掉一段同类字符。
 */
export function wordEndAfter(value, index) {
  const text = String(value || "")
  const cursor = clampToGrapheme(text, index)
  const parts = clustersOf(text)
  let slot = clusterSlotAt(parts, cursor)
  while (slot < parts.length && parts[slot].kind === CLASS.space) slot += 1
  if (slot >= parts.length) return text.length
  const kind = parts[slot].kind
  while (slot < parts.length && parts[slot].kind === kind) slot += 1
  return slot < parts.length ? parts[slot].index : text.length
}

/**
 * 删掉 [from, to) 区间。两端都会被夹到 grapheme 边界，顺序反了也认。
 *
 * @returns {{ text: string, cursor: number, removed: string }}
 *   `removed` 给调用方留着（比如提示「已删除 N 字」），但这里**没有 kill ring**：
 *   Ctrl+Y 已经被「选中即复制」开关占用，所以不做 yank，也就不存 kill 栈。
 */
export function deleteRange(value, from, to) {
  const text = String(value || "")
  const left = clampToGrapheme(text, from)
  const right = clampToGrapheme(text, to)
  const start = Math.min(left, right)
  const end = Math.max(left, right)
  return {
    text: text.slice(0, start) + text.slice(end),
    cursor: start,
    removed: text.slice(start, end)
  }
}

/** Ctrl+W / Alt+Backspace：删掉光标前的一个词。 */
export function deleteWordBefore(value, index) {
  const text = String(value || "")
  const cursor = clampToGrapheme(text, index)
  return deleteRange(text, wordStartBefore(text, cursor), cursor)
}

/** Alt+D：删掉光标后的一个词。 */
export function deleteWordAfter(value, index) {
  const text = String(value || "")
  const cursor = clampToGrapheme(text, index)
  return deleteRange(text, cursor, wordEndAfter(text, cursor))
}

/**
 * Ctrl+U：删到当前逻辑行的行首。
 *
 * **光标已在行首时是 no-op** —— 文本、光标、`removed` 全都原样返回，不会把上一行
 * 接过来。这与下面 Ctrl+K 的行为**故意不对称**：Ctrl+K 吞换行符是 emacs
 * `kill-line` 的既定语义，而 Ctrl+U 的肌肉记忆来自 readline 的 `unix-line-discard`
 * ——「清掉我这一行」。这里没有 kill ring 可以撤回，所以让它在行首哑掉，
 * 比让它悄悄吃掉上一行的内容安全。
 */
export function deleteToLineStart(value, index) {
  const text = String(value || "")
  const cursor = clampToGrapheme(text, index)
  return deleteRange(text, lineStart(text, cursor), cursor)
}

/**
 * Ctrl+K：删到当前逻辑行的行尾。
 *
 * **光标已在行尾时删掉那个换行符，把下一行接上来** —— 这是 emacs `kill-line`
 * 的行为：连按 Ctrl+K 能把多行逐段收掉。否则在行尾按下去毫无反应，用户得
 * 改按 Delete，多行输入里这很别扭。
 *
 * 换行符按 grapheme 边界删，因此粘贴进来的 CRLF 会被整簇删掉，
 * 不会留下一个孤零零的 `\r`。
 */
export function deleteToLineEnd(value, index) {
  const text = String(value || "")
  const cursor = clampToGrapheme(text, index)
  const end = lineEnd(text, cursor)
  if (end === cursor && cursor < text.length) {
    return deleteRange(text, cursor, moveGraphemeCursor(text, cursor, 1))
  }
  return deleteRange(text, cursor, end)
}

/** 把查询串转义成字面量正则。用户在 Ctrl+R 里打 `.*` 就该是搜 `.*`。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 历史反向搜索（Ctrl+R）。
 *
 * `history` 的顺序与 `ui.history` 一致：**最新的在数组末尾**（提交时 `push`，
 * `loadHistoryLines` 也是按文件顺序 `slice(-size)`）。因此 `direction: -1`
 * 「往更旧」就是下标递减。
 *
 * - `from` 为 null/undefined：从最新一条开始，**含**它自己。
 * - `from` 为数字：从 `from + direction` 开始，也就是跳过当前这条 ——
 *   连按 Ctrl+R 才会往下一个命中走，而不是原地不动。
 * - 空 query 返回 null：Ctrl+R 刚按下、还没输入时不该立刻跳到某一条历史上去。
 *   （只有空串算空；全是空格的 query 是合法搜索，照常匹配。）
 * - 大小写不敏感用正则 `i` 而不是 `toLowerCase()`：后者对某些字符会改变长度
 *   （`İ`.toLowerCase() 是两个 code unit），那样算出来的 `matched` 会与 `entry`
 *   对不上。正则 `i` 是在原串上匹配的，下标天然可用。
 *
 * @returns {{ index: number, entry: string, matched: [number, number] } | null}
 */
export function searchHistory(history, query, { from = null, direction = -1 } = {}) {
  const entries = Array.isArray(history) ? history : []
  const needle = String(query ?? "")
  if (!needle) return null

  const step = Number(direction) >= 0 ? 1 : -1
  const matcher = new RegExp(escapeRegExp(needle), "i")
  let at = from === null || from === undefined
    ? entries.length - 1
    : Math.trunc(Number(from) || 0) + step

  while (at >= 0 && at < entries.length) {
    const entry = entries[at]
    const hit = typeof entry === "string" ? matcher.exec(entry) : null
    if (hit) return { index: at, entry, matched: [hit.index, hit.index + hit[0].length] }
    at += step
  }
  return null
}
