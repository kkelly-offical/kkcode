/**
 * 选单浮层 —— 全仓唯一实现。
 *
 * 0.5.8 之前，模型 / 模式 / 权限策略 / 权限请求四个选单各自在 `buildFrame`
 * 里手搓一遍 `┌─┐` 与选中反白，视觉语言早就统一了，代码却复制了四份：
 * 改一处配色要改四处，加一个选单就再抄一遍，而 `fixedRows` 还要为每一份
 * 单独记一笔账（记漏了 CI 不会红，真终端上对话区会消失）。
 *
 * 这里把它们收成一个纯函数。提问面板（标签页 + 多选 + 自定义输入光标）
 * 结构差异太大，仍保留自己的渲染器，只是共用同一套边框语汇。
 *
 * 无色可用性：选中行除了反白背景，永远还有 `▸` 前缀 —— NO_COLOR 或不支持
 * truecolor 的终端下背景色不可见，前缀是唯一的选中线索，不能省。
 */

const SELECTED_PREFIX = "▸"
const CURRENT_MARKER = "●"
/** 选中行的前景色：反白背景上用近黑色保证对比度 */
const SELECTED_FG = "#111111"

/**
 * 计算滚动窗口，保证选中项始终可见。
 * @returns {{start: number, end: number, visible: number}}
 */
export function scrollWindow({ total, selected, offset, maxVisible }) {
  const visible = Math.min(total, Math.max(1, maxVisible || total))
  let start = Math.max(0, Math.min(offset || 0, total - visible))
  if (selected < start) start = selected
  if (selected >= start + visible) start = selected - visible + 1
  return { start, end: Math.min(total, start + visible), visible }
}

/**
 * @param {object} p
 * @param {string} p.title        标题（如 "Select Model (2/12)"）
 * @param {string} p.hint         快捷键提示，接在标题后
 * @param {Array<{label: string, desc?: string, current?: boolean}>} p.items
 * @param {number} p.selected     当前高亮项下标
 * @param {number} [p.offset]     滚动窗口起点（会被返回值修正）
 * @param {number} [p.maxVisible] 最多可见项数；缺省全部可见
 * @param {number} p.width        终端宽度
 * @param {object} p.theme
 * @param {string} p.accent       语义色（选中背景 / 标题色）
 * @param {Function} p.paint
 * @param {Function} p.padRight
 * @param {Array<{text: string, color?: string}>} [p.header] 框内顶部附加行
 * @param {"single"|"two-column"} [p.layout] 未选中行是否分两列排 label/desc
 * @param {boolean} [p.numbered]  项前加 "1." 序号
 * @param {boolean} [p.markers]   为 current 项显示 ● 标记
 * @returns {{lines: string[], offset: number}}
 */
export function renderSelectOverlay({
  title,
  hint = "",
  items = [],
  selected = 0,
  offset = 0,
  maxVisible = 0,
  width = 80,
  theme,
  accent,
  paint,
  padRight,
  header = [],
  layout = "single",
  numbered = false,
  markers = false,
  labelWidth = 22
}) {
  const lines = []
  const border = theme?.base?.border
  // 框宽以边框行为准：`┌` + inner + `┐` = width - 2。
  // 合并四份副本时才发现它们的项目行都是 `│` + (width-5) + `│` = width - 3，
  // 比边框窄一个字符 —— 真终端上方框右边缘一直是参差的。这里对齐修掉。
  // header 行多一个前导空格（`│ `），所以少留一格。
  const inner = Math.max(1, width - 4)
  const cell = inner
  const headerCell = Math.max(1, width - 5)

  lines.push(paint(hint ? `${title}  ${hint}` : title, accent, { bold: true }))
  lines.push(paint(`┌${"─".repeat(inner)}┐`, border))

  for (const row of header) {
    lines.push(paint(`│ ${padRight(row.text, headerCell)}│`, row.color || theme?.base?.fg))
  }
  if (header.length) {
    // 丁字接头而非竖线：`│──│` 的两端与方框侧边不相连，在真实终端里看着像
    // 一条浮在框内的断线。四份副本里原本都是竖线，合并后才看出来。
    lines.push(paint(`├${"─".repeat(inner)}┤`, border))
  }

  const win = scrollWindow({ total: items.length, selected, offset, maxVisible: maxVisible || items.length })
  for (let i = win.start; i < win.end; i++) {
    const item = items[i]
    const active = i === selected
    const prefix = active ? SELECTED_PREFIX : " "
    const marker = markers ? `${item.current ? CURRENT_MARKER : " "} ` : ""
    const number = numbered ? `${i + 1}. ` : ""
    const label = `${number}${item.label}`

    if (active) {
      const text = ` ${prefix} ${marker}${label}${item.desc ? `  ${item.desc}` : ""}`
      lines.push(paint(`│${padRight(text, cell)}│`, SELECTED_FG, { bg: accent, bold: true }))
      continue
    }

    const color = item.current ? theme?.semantic?.success : theme?.base?.fg
    if (layout === "two-column" && item.desc) {
      const left = padRight(` ${prefix} ${marker}${label}`, labelWidth)
      lines.push(paint(`│${left}${padRight(item.desc, Math.max(1, inner - labelWidth))}│`, color))
    } else {
      const text = ` ${prefix} ${marker}${label}${item.desc ? `  ${item.desc}` : ""}`
      lines.push(paint(`│${padRight(text, cell)}│`, color))
    }
  }

  lines.push(paint(`└${"─".repeat(inner)}┘`, border))

  if (items.length > win.visible) {
    lines.push(paint(`  ${win.start + 1}-${win.end} of ${items.length}`, theme?.base?.muted))
  }

  return { lines, offset: win.start }
}
