/**
 * 只读信息浮层：把一段多行文本浮在帧上方，可上下滚动，Esc 关闭。
 *
 * 为什么需要它，而不是继续用 `channel: "panel"`：
 *
 * `panel` 通道把输出折叠成对话记录里的一条条目 —— 0.6.0 那次改动解决的是
 * 「80 行帮助刷屏」，但它把这些输出留在了对话历史里。后果有三个：
 *
 *   1. `/status`、`/permission` 这类**查询当前状态**的输出会进上下文，
 *      随会话一起被发给模型 —— 它是给人看的，不是给模型看的
 *   2. `/clear` 会把它们一起清掉，而它们本来跟对话内容无关
 *   3. 看完之后没法关掉，只能往下滚过去
 *
 * 选择型的浮层（模型/模式/策略选择器）走 `renderSelectOverlay`；这个模块管的
 * 是「读完就关」的信息面板，两者刻意分开：前者的交互是选一个，后者是滚动看完。
 */

/** 计算滚动窗口。offset 会被夹到合法范围，调用方应回写返回的 offset。 */
export function panelWindow({ total, offset, maxVisible }) {
  const visible = Math.max(1, Math.min(maxVisible || total, total))
  const maxOffset = Math.max(0, total - visible)
  const start = Math.max(0, Math.min(maxOffset, Number(offset) || 0))
  return { start, end: Math.min(total, start + visible), visible, maxOffset }
}

/**
 * @param {object} p
 * @param {string} p.title    标题
 * @param {string[]} p.lines  内容行（已带颜色码亦可）
 * @param {number} [p.offset] 滚动起点
 * @param {number} p.width    终端宽度
 * @param {number} [p.maxRows] 内容区最多占多少行；缺省 12
 * @param {object} p.theme
 * @param {string} [p.accent] 标题与边框色
 * @param {Function} p.paint
 * @param {Function} p.clipAnsiLine 行裁剪（保留颜色）
 * @param {Function} p.wrapLines  按宽度折行
 * @param {string} [p.hint]   底部快捷键提示；缺省按是否可滚动自动生成
 * @returns {{lines: string[], offset: number, maxOffset: number, totalRows: number}}
 */
export function renderPanelOverlay({
  title = "",
  lines = [],
  offset = 0,
  width = 80,
  maxRows = 12,
  theme,
  accent = null,
  paint,
  clipAnsiLine,
  wrapLines,
  hint = ""
}) {
  const border = accent || theme?.base?.border || null
  const inner = Math.max(8, width - 4)

  // 先按内容区宽度折行，再算滚动 —— 顺序反了的话滚动位置会随宽度变化而漂移
  const wrapped = wrapLines(lines.length ? lines : [""], inner)
  const win = panelWindow({ total: wrapped.length, offset, maxVisible: maxRows })
  const visibleLines = wrapped.slice(win.start, win.end)

  const scrollTag = win.maxOffset > 0
    ? `  ${win.start + 1}-${win.end}/${wrapped.length}`
    : ""
  const heading = `${title}${scrollTag}`
  const footer = hint || (win.maxOffset > 0
    ? "↑↓ scroll  PgUp/PgDn page  Esc close"
    : "Esc close")

  const out = []
  out.push(paint(`┌${"─".repeat(Math.max(1, width - 2))}┐`, border))
  out.push(`${paint("│ ", border)}${clipAnsiLine(paint(heading, accent || theme?.base?.accent, { bold: true }), inner)}${paint(" │", border)}`)
  out.push(paint(`├${"─".repeat(Math.max(1, width - 2))}┤`, border))
  for (const line of visibleLines) {
    out.push(`${paint("│ ", border)}${clipAnsiLine(line, inner)}${paint(" │", border)}`)
  }
  // 内容不足时补空行，浮层高度稳定 —— 否则每次滚动边框都在跳
  for (let i = visibleLines.length; i < win.visible; i++) {
    out.push(`${paint("│ ", border)}${clipAnsiLine("", inner)}${paint(" │", border)}`)
  }
  out.push(paint(`├${"─".repeat(Math.max(1, width - 2))}┤`, border))
  out.push(`${paint("│ ", border)}${clipAnsiLine(paint(footer, theme?.base?.muted), inner)}${paint(" │", border)}`)
  out.push(paint(`└${"─".repeat(Math.max(1, width - 2))}┘`, border))

  return { lines: out, offset: win.start, maxOffset: win.maxOffset, totalRows: wrapped.length }
}
