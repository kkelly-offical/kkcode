/**
 * 补全候选表的渲染。
 *
 * 与 `suggestion-source.mjs` 配对：那边决定「有哪些候选」，这边只决定「怎么画」。
 * 候选有三种（`/` 命令、`$` 技能、`@` 文件），差异全部收在这里的两个小函数里 ——
 * `renderSuggestions` 自己不认种类，加第四种候选时它一行都不用改。
 *
 * ## 无色可用性
 *
 * 两处约定与 `ui/overlay-select.mjs` 完全一致，因为它们要解决的是同一个问题：
 *
 *   1. 选中行除了反白背景，永远还有 `▸` 前缀。NO_COLOR 或不支持 truecolor 的终端下
 *      背景色不可见，前缀是唯一的选中线索。
 *   2. 命中区间用**方括号**标（`src/[repl].mjs`），不用颜色。`padRight` 会 stripAnsi
 *      后再补位，行内颜色码会被它吃掉；而且嵌在选中行的反白背景里还会把背景截断。
 */

import { paint } from "../theme/color.mjs"
import { markMatchRanges } from "../ui/overlay-select.mjs"
import { clipAnsiLine, padRight } from "./frame-primitives.mjs"

/** 候选表最多同时显示几行。再多就靠上下键滚 —— 它挤的是对话区。 */
export const MAX_TUI_SUGGESTIONS = 5

/** 选中行的非颜色标记，见文件头。 */
const SELECTED_PREFIX = "▸"

/**
 * 标题：这是哪一类候选、选中第几条、该按什么键。
 *
 * 文件那一支必须把「索引被 maxFiles 截断了」说出来。悄悄封顶会让人以为「补全里没有
 * 就是仓库里没有」，然后花二十分钟找一个其实存在的文件。
 */
function suggestionTitle(suggestions, selected) {
  const position = `(${selected + 1}/${suggestions.items.length})`
  if (suggestions.kind === "mention") {
    const capped = suggestions.truncated ? `  · index capped at ${suggestions.maxFiles} files` : ""
    return `Files ${position}  Enter choose${capped}`
  }
  return `${suggestions.kind === "skill" ? "Skills" : "Slash Commands"} ${position}  Enter choose, Enter again execute`
}

/**
 * 只标长度 ≥ 2 的连续命中段。
 *
 * 一对方括号是**两个**字符的噪声；标一个字符时它换来的信号还不如噪声多。散射式的
 * 子序列匹配尤其糟 —— `@src/[a]gen[t]/promp[t]/[a]r[ch]itect.txt` 已经读不出原本的
 * 路径，而那种候选本来就排在后面，用户需要的是一眼扫过去跳过它。前缀与子串命中才是
 * 标记真正有用的地方，它们天然就是长段。
 *
 * 区间是**半开**的（end 独占），两端约定一致：`file-rank.mjs` 的档次表按 `needle.length`
 * 算 end，`markMatchRanges` 按 `raw.slice(start, end)` 取值。所以判据是 `end - start >= 2`
 * 而不是 `>=1`；哪天有一头改成闭区间，这里会静默少标一个字符。
 */
function worthMarking(ranges) {
  return (ranges || []).filter(([start, end]) => end - start >= 2)
}

/**
 * 一条候选的正文。
 *
 * 文件名**不 padRight**：路径长度差得远，补到 14 列只会把长路径挤成一堵墙，
 * 而命令名短且带说明文字，对齐才读得下去。
 */
function suggestionLabel(suggestions, item) {
  if (suggestions.kind === "mention") return `@${markMatchRanges(item.name, worthMarking(item.matched))}`
  return `${suggestions.sigil}${padRight(item.name, 14)} ${item.desc}`
}

/**
 * @param {object} p
 * @param {object} p.suggestions  suggestion-source 算好的候选表
 * @param {number} p.selected     选中下标
 * @param {number} p.offset       滚动窗口起点（会被返回值修正）
 * @returns {{lines: string[], offset: number}}
 */
export function renderSuggestions({ suggestions, selected, offset, maxVisible, theme, width }) {
  const items = suggestions?.items || []
  if (!suggestions?.kind || !items.length) {
    return { lines: [], offset: 0 }
  }
  const visible = Math.max(1, maxVisible || MAX_TUI_SUGGESTIONS)
  let start = Math.max(0, Math.min(offset || 0, Math.max(0, items.length - visible)))
  if (selected < start) start = selected
  if (selected >= start + visible) start = selected - visible + 1

  const end = Math.min(items.length, start + visible)
  const view = items.slice(start, end)
  const lines = [paint(suggestionTitle(suggestions, selected), theme.base.muted, { bold: true })]
  for (let i = 0; i < view.length; i++) {
    const item = view[i]
    const index = start + i
    const active = index === selected
    const prefix = active ? SELECTED_PREFIX : " "
    const line = `${prefix} ${suggestionLabel(suggestions, item)}`
    lines.push(
      active
        ? paint(line, "#111111", { bg: theme.semantic.info, bold: true })
        : paint(line, theme.base.fg)
    )
  }
  if (items.length > visible) {
    lines.push(paint(`scroll: ${start + 1}-${end}/${items.length} (Up/Down)`, theme.base.muted))
  }
  return {
    lines: lines.map((line) => clipAnsiLine(line, width)),
    offset: start
  }
}
