/**
 * 提问浮层：分页 Tab、单选/多选、自由文本，外加**遮蔽输入**。
 *
 * 从 frame-builder 里抽出来的一整块。抽它有两个理由，都不是行数：
 *
 *  1. `buildFrame` 已经在结构守卫的 KNOWN_COMPLEX 清单里（判定点只减不增），
 *     而遮蔽、多行描述这些都要往这一块里加分支 —— 留在原地就等于把清单往上顶。
 *  2. 这块有真正值得单独断言的性质（遮蔽后光标不错位、真值不进画面），
 *     隔着整帧去断言只能靠在一屏文本里找子串。
 *
 * ## 遮蔽只发生在这里
 *
 * `ui.questionCustomInput` 里存的**始终是真值**：左右键、Backspace、插入全都
 * 作用在真值上，`maskSecretText` 只负责把它换成等长（按字素簇计）的点串，并把
 * 光标换算到点串坐标系。返回的 `textCursor` 是真值坐标系里对齐到簇边界的光标，
 * 调用方回写它 —— 不会把点串的下标写回真值。
 */

import { maskSecretText } from "../repl/text-layout.mjs"
import { scrollWindow, filterOverlayItems, markMatchRanges } from "./overlay-select.mjs"

const SECRET_MASK = "•"

/**
 * 选项超过这个数就进滚动窗口（0.8.0）。此前是无窗口全量遍历 —— /provider add
 * 的模型多选轮发现 60 个模型时，整帧直接超出终端高度，对话区被压到 2 行。
 */
export const MAX_QUESTION_OPTIONS_VISIBLE = 8

/** 当前问题是否处在自由文本形态（自定义模式，或它本来就没有选项）。 */
export function questionIsTextMode(question, customMode) {
  const options = Array.isArray(question?.options) ? question.options : []
  return Boolean(customMode) || options.length === 0
}

/**
 * 过滤后的可见选项视图：`[{ option, sourceIndex, ranges }]`。
 *
 * **唯一的派生函数** —— 渲染（本文件）、按键（overlay-keys 的 questionOptions
 * 作用域）、提交（dialog-router 的 commitQuestionAnswer）三方都用它。三处各算
 * 一份的话，「界面上高亮的」「空格勾中的」「最终写进答案的」会是三个东西。
 *
 * 多选集合（questionMultiSelected）存的是 **sourceIndex**（原始选项下标），
 * 不是显示位置：过滤会重排显示位置，显示位置一进集合，清掉过滤串后勾选就
 * 全体错位。`questionOptionSelected` 则始终是**显示位置**（0..visible.length，
 * 末尾越界一格代表 Custom 伪项）——两个坐标系只在这里换算。
 */
export function visibleQuestionOptions(question, filter = "") {
  const options = Array.isArray(question?.options) ? question.options : []
  if (!filter) return options.map((option, index) => ({ option, sourceIndex: index, ranges: [] }))
  return filterOverlayItems(options, filter, { field: "label" })
    .map((match) => ({ option: options[match.sourceIndex], sourceIndex: match.sourceIndex, ranges: match.ranges }))
}

export function renderQuestionOverlay({
  pendingQuestion,
  questionIndex = 0,
  questionAnswers = {},
  questionOptionSelected = 0,
  questionMultiSelected = {},
  questionCustomMode = false,
  questionCustomInput = "",
  questionCustomCursor = 0,
  questionFilter = "",
  questionOptionOffset = 0,
  width,
  theme,
  paint,
  padRight,
  layoutInputText
}) {
  const questions = pendingQuestion?.questions || []
  const qCount = questions.length
  const currentQ = questions[questionIndex] || {}
  const options = Array.isArray(currentQ.options) ? currentQ.options : []
  const answered = Object.keys(questionAnswers).length
  const inner = Math.max(1, width - 5)
  const rule = Math.max(1, width - 4)
  const lines = []
  const row = (text, color, style) => lines.push(paint(`│ ${padRight(text, inner)}│`, color, style))

  const hintKeys = questionCustomMode
    ? "Enter confirm  Esc back"
    : "↑↓ select  Enter confirm  Tab switch  Esc skip  Ctrl+Enter submit all"
  lines.push(paint(`Question (${questionIndex + 1}/${qCount})  ${hintKeys}`, theme.semantic.info, { bold: true }))
  lines.push(paint(`┌${"─".repeat(rule)}┐`, theme.base.border))

  if (qCount > 1) {
    let tabBar = ""
    for (let i = 0; i < qCount; i++) {
      // ✓ 只给**答出了内容**的问题。表单里 Tab 走过一遍就会把空串存进答案，
      // 拿「键在不在」当标记的话，一路 Tab 到底会让每个字段都打上勾。
      const done = Boolean(questionAnswers[questions[i].id])
      const isCurrent = i === questionIndex
      const marker = done ? "✓" : " "
      const tabLabel = (questions[i].header || `Q${i + 1}`).slice(0, 12)
      tabBar += isCurrent ? `[${marker}${tabLabel}]` : ` ${marker}${tabLabel} `
      if (i < qCount - 1) tabBar += " "
    }
    row(tabBar, theme.base.fg)
    lines.push(paint(`│${"─".repeat(rule)}│`, theme.base.border))
  }

  // 题干与描述都按 \n 逐行画。此前两处都是一次 padRight —— 多行内容（确认页
  // 要展示的整段 YAML 预览、计划审批里的整份计划）第二行起全部被吞，「所见即
  // 所写」的确认页于是只剩一行标题。
  for (const textLine of String(currentQ.text || "").split("\n")) {
    row(textLine, theme.base.fg)
  }
  if (currentQ.description) {
    for (const descLine of String(currentQ.description).split("\n")) {
      row(descLine, theme.base.muted)
    }
  }
  lines.push(paint(`│${"─".repeat(rule)}│`, theme.base.border))

  let cursor = null
  let textCursor = questionCustomCursor
  // 滚动窗口起点，调用方回写（与 renderSelectOverlay 的 offset 约定一致）
  let optionOffset = questionOptionOffset
  if (questionIsTextMode(currentQ, questionCustomMode)) {
    const secret = currentQ.secret === true
    const masked = secret ? maskSecretText(questionCustomInput, questionCustomCursor, SECRET_MASK) : null
    if (masked) textCursor = masked.normalizedCursor
    const layout = layoutInputText({
      value: masked ? masked.value : questionCustomInput,
      cursor: masked ? masked.cursor : questionCustomCursor,
      width: inner,
      maxRows: 3,
      prefix: ""
    })
    if (!masked) textCursor = layout.normalizedCursor
    row(options.length ? "Custom input:" : "Answer:", theme.base.muted)
    const inputStart = lines.length
    const placeholder = secret ? "(hidden input)" : "(type your answer)"
    for (const [index, inputLine] of layout.lines.entries()) {
      const visible = inputLine || (index === 0 ? paint(placeholder, theme.base.muted, { dim: true }) : "")
      lines.push(`│ ${padRight(visible, inner)}│`)
    }
    cursor = { row: inputStart + layout.cursor.row, col: 3 + layout.cursor.col }
  } else if (options.length) {
    const multiSelected = questionMultiSelected[currentQ.id] || new Set()
    const visible = visibleQuestionOptions(currentQ, questionFilter)
    const allowCustom = currentQ.allowCustom !== false
    // Custom 伪项参与窗口计算 —— 它是列表的最后一行，滚到底才看得见，
    // 否则窗口滚动时它会把可见行数顶到 maxVisible + 1。
    const total = visible.length + (allowCustom ? 1 : 0)
    const win = scrollWindow({
      total,
      selected: Math.min(questionOptionSelected, Math.max(0, total - 1)),
      offset: questionOptionOffset,
      maxVisible: MAX_QUESTION_OPTIONS_VISIBLE
    })
    // 窗口化时不画 description 行：窗口按**选项数**算，行数却按渲染行数长 ——
    // 8 个带描述的选项就是 16 行，等于没窗口。列表短时保留描述，信息不丢。
    const windowed = total > win.visible

    if (!visible.length && questionFilter) {
      row("no match · Backspace deletes · Esc clears filter", theme.base.muted)
    }
    for (let i = win.start; i < win.end; i++) {
      const active = i === questionOptionSelected
      const prefix = active ? "▸" : " "
      if (i >= visible.length) {
        const customLine = ` ${prefix}   Custom...`
        lines.push(
          active
            ? paint(`│${padRight(customLine, inner)}│`, "#111111", { bg: theme.semantic.info, bold: true })
            : paint(`│${padRight(customLine, inner)}│`, theme.base.muted)
        )
        continue
      }
      const entry = visible[i]
      const marker = currentQ.multi
        ? (multiSelected.has(entry.sourceIndex) ? "☑" : "☐")
        : (active ? "●" : "○")
      const label = questionFilter ? markMatchRanges(entry.option.label, entry.ranges) : entry.option.label
      const optLine = ` ${prefix} ${marker} ${label}`
      lines.push(
        active
          ? paint(`│${padRight(optLine, inner)}│`, "#111111", { bg: theme.semantic.info, bold: true })
          : paint(`│${padRight(optLine, inner)}│`, theme.base.fg)
      )
      if (entry.option.description && !windowed) {
        lines.push(paint(`│${padRight(`       ${entry.option.description}`, inner)}│`, theme.base.muted))
      }
    }
    if (windowed || questionFilter) {
      const range = windowed ? `${win.start + 1}-${win.end} of ${total}` : ""
      const filterNote = questionFilter ? `filter: ${questionFilter}` : "type to filter"
      row([range, filterNote].filter(Boolean).join("  ·  "), theme.base.muted)
    }
    optionOffset = win.start
  }

  lines.push(paint(`│${"─".repeat(rule)}│`, theme.base.border))
  const multiCount = currentQ.multi ? (questionMultiSelected[currentQ.id] || new Set()).size : 0
  const multiHint = currentQ.multi && multiCount > 0 ? `  (${multiCount} selected)` : ""
  row(`Answered: ${answered}/${qCount}${multiHint}  [Ctrl+Enter submit all]`, theme.base.muted)
  lines.push(paint(`└${"─".repeat(rule)}┘`, theme.base.border))

  return { lines, cursor, textCursor, optionOffset }
}
