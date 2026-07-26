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
 *
 * ## 打字过滤（0.7.3）
 *
 * `/resume` 列 30 个会话时只能一路按下箭头。选择器现在接受打字过滤，匹配引擎
 * 就在本文件下半部分 —— 它是纯函数，`overlay-keys` 与 `overlay-controller`
 * 都 import 它，没有第二份实现。
 *
 * 命中区间用**方括号**标进 label，而不是用颜色：
 *
 *   1. `padRight` 会 `stripAnsi` 后再补位（frame-primitives.mjs:59），行内插的
 *      颜色码会被它吃掉，而且嵌在选中行的反白背景里还会把背景截断；
 *   2. 方括号在 NO_COLOR / 不支持 truecolor 的终端下同样可见 —— 这与「选中行
 *      必带 ▸ 前缀」是同一条约定：可用性信息不能只存在于颜色里。
 *
 * 区间同时保留在 `picker.matches[i].ranges` 里，将来渲染层要改成 ANSI 高亮时
 * 不必重算。
 */

const SELECTED_PREFIX = "▸"
const CURRENT_MARKER = "●"
/** 选中行的前景色：反白背景上用近黑色保证对比度 */
const SELECTED_FG = "#111111"
/**
 * 过滤后一个都没剩时的提示行。
 *
 * 不能什么都不画 —— 空框看起来和「卡住了」一模一样，用户不会知道是自己敲的
 * 过滤串把候选滤光了。
 */
const NO_MATCH_HINT = "no match · Backspace deletes · Esc clears filter"

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

  // 一个候选都没有 = 过滤把它们滤光了（空列表的选择器压根不会打开，见
  // overlay-controller 的 listPicker.open）。这里必须说一声，不能留个空框。
  if (!items.length) {
    lines.push(paint(`│${padRight(` ${NO_MATCH_HINT}`, cell)}│`, theme?.base?.muted))
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

// --- 打字过滤 ---

/**
 * 匹配档位。排序时**先按档位**：前缀命中排在子串命中前面，子串又排在
 * 零散的子序列命中前面。否则输 "gpt" 时 `deepseek-r1` 这种「碰巧按顺序含有
 * g、p、t」的项会和 `gpt-5` 混在一起，等于没排序。
 */
export const MATCH_TIER = Object.freeze({ prefix: 0, substring: 1, subsequence: 2 })

/** 相邻或重叠的区间并成一段：`[a][u][t]h` 读起来不如 `[aut]h`。 */
function mergeRanges(ranges) {
  const merged = []
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * 单个候选的模糊匹配。大小写不敏感。
 *
 * @param {string} text  候选文本
 * @param {string} query 过滤串
 * @returns {{tier: number, start: number, ranges: Array<[number, number]>}|null}
 *   不匹配返回 null。空过滤串返回「全体命中、无区间」。
 */
export function matchFilter(text, query) {
  const q = String(query ?? "").toLowerCase()
  if (!q) return { tier: -1, start: 0, ranges: [] }
  // text 缺失时不要 String(undefined) —— 那会变成字面量 "undefined"，
  // 于是输 "n" 能匹配上一个没有 label 的候选。
  if (text === null || text === undefined) return null
  const raw = String(text)
  const lower = raw.toLowerCase()

  if (lower.startsWith(q)) return { tier: MATCH_TIER.prefix, start: 0, ranges: [[0, q.length]] }
  const at = lower.indexOf(q)
  if (at > 0) return { tier: MATCH_TIER.substring, start: at, ranges: [[at, at + q.length]] }

  // 子序列：过滤串的每个字符按顺序出现即可，中间可以隔开
  const hits = []
  let cursor = 0
  for (const ch of q) {
    const idx = lower.indexOf(ch, cursor)
    if (idx === -1) return null
    hits.push([idx, idx + ch.length])
    cursor = idx + ch.length
  }
  return { tier: MATCH_TIER.subsequence, start: hits[0][0], ranges: mergeRanges(hits) }
}

/**
 * 过滤并排序一组候选。
 *
 * @returns {Array<{sourceIndex: number, tier: number, start: number, ranges: Array}>}
 *   与过滤后的显示顺序一一对应；`sourceIndex` 指回原数组。
 */
export function filterOverlayItems(items = [], query = "", { field = "label" } = {}) {
  const q = String(query ?? "")
  if (!q) return items.map((_, index) => ({ sourceIndex: index, tier: -1, start: 0, ranges: [] }))

  const hits = []
  items.forEach((item, index) => {
    const match = matchFilter(item?.[field], q)
    if (match) hits.push({ sourceIndex: index, ...match })
  })
  // 同档位内按命中位置靠前优先，再按原顺序 —— 原顺序是有意义的
  // （会话按时间倒序、模型按目录顺序），不该被打乱。
  hits.sort((a, b) => a.tier - b.tier || a.start - b.start || a.sourceIndex - b.sourceIndex)
  return hits
}

/** 把命中区间用方括号标进文本。见文件头「为什么不用颜色」。 */
export function markMatchRanges(text, ranges = []) {
  const raw = text === null || text === undefined ? "" : String(text)
  if (!ranges.length) return raw
  let out = ""
  let cursor = 0
  for (const [start, end] of ranges) {
    // 区间是在 toLowerCase 之后算的，个别字符小写后长度会变（如 İ）。
    // 越界就整段放弃标注，而不是把字符串切坏。
    if (start < cursor || end > raw.length) return raw
    out += `${raw.slice(cursor, start)}[${raw.slice(start, end)}]`
    cursor = end
  }
  return out + raw.slice(cursor)
}

/**
 * 选择器的初始状态。`all` 是永远不变的原始候选，`items` 是渲染方看到的那份。
 *
 * frame-builder 只拿得到 `items`（它 `.map()` 成 `{label, desc, current}` 再交给
 * 渲染函数），所以过滤必须体现在 `items` 本身上 —— 见 `applyOverlayFilter`。
 */
export function createPickerFilterState(items = [], selected = 0) {
  return {
    all: items,
    items,
    matches: filterOverlayItems(items, ""),
    filter: "",
    selected: Math.max(0, Math.min(items.length - 1, selected)),
    offset: 0
  }
}

/**
 * 过滤状态的唯一转移函数：原地改写 picker 状态。
 *
 * **选中项跟随**是这里最容易写错的一处：过滤后候选的下标全变了，把 `selected`
 * 留在原位等于选中了另一个东西（对 `/resume` 来说就是续跑错的会话）。所以先
 * 记下当前选中项在 `all` 里的下标，过滤完再找回去；找不到才归零。
 */
export function applyOverlayFilter(picker, query) {
  if (!picker) return picker
  // 兼容手工构造的旧形状（只有 items，没有 all/matches）
  const all = Array.isArray(picker.all) ? picker.all
    : (Array.isArray(picker.items) ? picker.items : [])
  const previous = picker.matches?.[picker.selected]?.sourceIndex ?? picker.selected ?? 0

  const filter = String(query ?? "")
  const matches = filterOverlayItems(all, filter)
  picker.all = all
  picker.filter = filter
  picker.matches = matches
  picker.items = filter
    ? matches.map((match) => ({
      ...all[match.sourceIndex],
      label: markMatchRanges(all[match.sourceIndex]?.label, match.ranges)
    }))
    : all

  const kept = matches.findIndex((match) => match.sourceIndex === previous)
  picker.selected = kept >= 0 ? kept : 0
  // 过滤后窗口重来：留着旧 offset 会在短列表上显示成一片空白
  picker.offset = 0
  return picker
}

/**
 * 取出当前选中的**原始**候选。
 *
 * 不能直接返回 `picker.items[selected]` —— 过滤态下那是一份 label 被标了方括号的
 * 副本，确认动作要的是原件。
 */
export function resolvePickerChoice(picker) {
  if (!picker?.items) return null
  const match = picker.matches?.[picker.selected]
  if (match && Array.isArray(picker.all)) return picker.all[match.sourceIndex] ?? null
  return picker.items[picker.selected] ?? null
}
