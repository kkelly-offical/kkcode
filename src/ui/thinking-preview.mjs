/**
 * 思考流的实时预览 —— 固定两行灰字。
 *
 * 此前思考中只显示一行 `Thinking · 5.1s`：你知道它在想，但不知道在想什么，
 * 十几秒的等待里屏幕上什么都没有。完整思考内容又不能直接铺开——它常常几百行，
 * 会把对话挤没。
 *
 * 折中是**固定高度的滚动窗口**：永远两行，显示思考流的尾部。行数固定这一点
 * 是硬约束，不是审美选择 —— 帧的行数记账（fixedRows）按块的实际行数计费，
 * 一个会变高的块会让对话区随模型输出上下抖动。
 *
 * 0.7.0 修两个让这个窗口「乱跳」的缺陷（用户报告：两行字一直在逐字符地跳）：
 *
 *   1. 行边界原本锚在**尾部**（`flat.slice(-usable * limit)`）。思考流每多一个
 *      字符，切片起点就右移一格，所有行的边界跟着整体左移一格 —— 两行字在逐
 *      字符地滚。现在锚在**开头**：一行封口之后就再也不变，新字符只往最后一
 *      行追加，填满了才开新行，窗口整行整行地滚。
 *   2. 原本按**字符数**切行，而参数给的是**列宽**。中文/日文/韩文与 emoji 占
 *      两列，一行 76 个汉字实际是 152 列，调用方的 `clipAnsiLine` 会把超出的
 *      一半悄悄截掉 —— 中文界面里每行只看得见一半内容。现在按显示列宽切，直接
 *      复用 text-layout 的 `wrapAnsiLine`（字素簇安全：宽字符、emoji ZWJ 序列、
 *      组合字符都不会被劈成两半），不另起一份宽度实现。
 */

import { splitGraphemes, wrapAnsiLine } from "../repl/text-layout.mjs"

export const THINKING_PREVIEW_ROWS = 2

/**
 * 强制断行的页长（字符）。
 *
 * 行边界锚在开头之后，第 k 行的起点由它**之前**的全部内容决定 —— 宽字符占两
 * 列，这个依赖绕不过去，而思考流可能几万字符，每帧从头折一遍是几百毫秒（帧
 * 间隔只有 16ms）。所以规定：每 PAGE 个字符强制断一次行。这样页内的行边界只
 * 取决于当前页，冷启动最多折两页，工作量有上限。
 *
 * 代价是每页末尾有一行会提前结束。按 76 列算是每 50 行左右出现一次，而且它是
 * **稳定的** —— 不会像旧实现那样每来一个字符就整体左移一格。
 */
export const THINKING_PREVIEW_PAGE_CHARS = 4096

/** 页内至少要能放下 limit 行，否则往前退一页也补不满窗口。 */
function pageSizeFor(usable, limit) {
  return Math.max(THINKING_PREVIEW_PAGE_CHARS, usable * limit * 2)
}

/** 吸附窗口：一个字素簇不会长到 64 个码元，取这么宽足够定位它的起点。 */
const SNAP_WINDOW = 64

/**
 * 把页边界下标吸附到**不超过它的**最近字素簇边界。
 *
 * 页边界是按码元下标算的，它可能正好落在一个宽字符的代理对中间、或者把重音
 * 从基字上切下来 —— 那一行开头就会画出半个字。字素簇切分是局部的，往回看
 * SNAP_WINDOW 个码元足够把簇的起点找出来，不必从头切一遍。
 */
function snapToGrapheme(flat, index) {
  if (index <= 0) return 0
  if (index >= flat.length) return flat.length
  const from = Math.max(0, index - SNAP_WINDOW)
  let boundary = from
  for (const cluster of splitGraphemes(flat.slice(from, index + SNAP_WINDOW))) {
    const at = from + cluster.index
    if (at > index) break
    boundary = at
  }
  return boundary
}

/** 第 k 页的起点（已吸附）。页边界必须只依赖 flat 本身，否则记忆化就不纯了。 */
function pageStart(flat, pageIndex, page) {
  return pageIndex <= 0 ? 0 : snapToGrapheme(flat, pageIndex * page)
}

/** `start` 之后的下一个页边界；吸附可能把边界拉回来，所以要跳过已经用过的页。 */
function nextPageBoundary(flat, start, page) {
  for (let pageIndex = Math.floor(start / page) + 1; pageIndex * page < flat.length; pageIndex += 1) {
    const boundary = pageStart(flat, pageIndex, page)
    if (boundary > start) return boundary
  }
  return flat.length
}

/**
 * 把 `flat[from..]` 按 usable 列宽贪心折行，并在每个页边界强制断行。
 * 折行本身走 `wrapAnsiLine`，不重复实现宽度与字素簇逻辑。
 */
function wrapRegion(flat, from, usable, page) {
  const out = []
  let start = Math.max(0, from)
  while (start < flat.length) {
    const pageEnd = nextPageBoundary(flat, start, page)
    for (const line of wrapAnsiLine(flat.slice(start, pageEnd), usable)) out.push(line)
    start = pageEnd
  }
  return out
}

/**
 * 增量记忆：流式追加时，已封口的行是不变的，重折它们纯属浪费。
 *
 * 这是**纯记忆化** —— 命中与否结果完全一致，因为行边界的定义（从页首贪心折
 * 行、页边界强制断行）只依赖 flat 本身。命中时只重折「在制行 + 新增字符」，
 * 稳态开销是几个字素；未命中（首帧、改宽、换了一段思考、一次追加超过两页）
 * 走冷启动路径，工作量仍有页长的硬上限。
 */
let memo = null

/**
 * 把流式思考文本折成固定两行的窗口（显示尾部）。
 *
 * @param {string} raw 累积的思考原文
 * @param {number} width 可用列宽
 * @param {number} rows 预览行数（默认 2）
 * @returns {string[]} 恰好 rows 行（不足时补空串），每行显示宽度不超过 width
 */
export function thinkingPreviewLines(raw, width, rows = THINKING_PREVIEW_ROWS) {
  const limit = Math.max(1, Number(rows) || THINKING_PREVIEW_ROWS)
  const usable = Math.max(10, Number(width) || 80)
  const text = String(raw || "")
  if (!text.trim()) {
    memo = null
    return Array(limit).fill("")
  }

  // 思考流里的换行大多是模型的段落停顿，直接按软换行重排更稳定：
  // 否则一段长推理会占满窗口，而下一段刚开头就把它挤走，读起来是闪的。
  const flat = text.replace(/\s+/g, " ").trim()
  const page = pageSizeFor(usable, limit)

  let lines = null
  if (
    memo &&
    memo.usable === usable &&
    memo.limit === limit &&
    flat.length >= memo.flat.length &&
    // 一次追加超过两页就别走增量了 —— 那等于从头遍历，工作量没了上限。
    flat.length - memo.cursor <= page * 2 &&
    flat.startsWith(memo.flat)
  ) {
    const fresh = wrapRegion(flat, memo.cursor, usable, page)
    // memo.lines 的最后一条是**在制行**（还没填满），要连着新字符一起重折；
    // 它前面的都已封口，原样保留 —— 这正是「已成型的行永不改变」。
    if (fresh.length) lines = [...memo.lines.slice(0, -1), ...fresh]
  }

  if (!lines) {
    // 冷启动：从末尾所在页的页首开始折；这一页还没攒够 limit 行时再往前退一
    // 页。最多两页 —— 这是「不从头遍历整段」的硬边界。
    const lastPage = Math.floor(Math.max(0, flat.length - 1) / page)
    lines = wrapRegion(flat, pageStart(flat, lastPage, page), usable, page)
    if (lines.length < limit && lastPage >= 1) {
      lines = wrapRegion(flat, pageStart(flat, lastPage - 1, page), usable, page)
    }
  }

  const window = lines.slice(-limit)
  // cursor 是在制行在 flat 里的起点。折行是无损的（flat 里既没有 ANSI 也没有
  // 换行），所以最后一行必然是 flat 的后缀，减长度即可定位。
  memo = { flat, usable, limit, lines: window, cursor: flat.length - (window.at(-1) || "").length }

  const padded = window.slice()
  while (padded.length < limit) padded.unshift("")
  return padded
}
