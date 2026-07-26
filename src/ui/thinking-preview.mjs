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
 */

export const THINKING_PREVIEW_ROWS = 2

/**
 * 把流式思考文本折成固定两行的尾部窗口。
 *
 * @param {string} raw 累积的思考原文
 * @param {number} width 可用列宽
 * @param {number} rows 预览行数（默认 2）
 * @returns {string[]} 恰好 rows 行（不足时补空串），已按 width 截断
 */
export function thinkingPreviewLines(raw, width, rows = THINKING_PREVIEW_ROWS) {
  const limit = Math.max(1, Number(rows) || THINKING_PREVIEW_ROWS)
  const usable = Math.max(10, Number(width) || 80)
  const text = String(raw || "")
  if (!text.trim()) return Array(limit).fill("")

  // 思考流里的换行大多是模型的段落停顿，直接按软换行重排更稳定：
  // 否则一段长推理会占满窗口，而下一段刚开头就把它挤走，读起来是闪的。
  const flat = text.replace(/\s+/g, " ").trim()

  // 只需要尾部，不必对整段做换行计算 —— 思考流可能已经几万字符。
  const tailBudget = usable * limit
  const tail = flat.length > tailBudget ? flat.slice(-tailBudget) : flat

  const lines = []
  for (let i = 0; i < tail.length; i += usable) {
    lines.push(tail.slice(i, i + usable))
  }

  const window = lines.slice(-limit)
  while (window.length < limit) window.unshift("")
  return window
}
