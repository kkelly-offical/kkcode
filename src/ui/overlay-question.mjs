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

const SECRET_MASK = "•"

/** 当前问题是否处在自由文本形态（自定义模式，或它本来就没有选项）。 */
export function questionIsTextMode(question, customMode) {
  const options = Array.isArray(question?.options) ? question.options : []
  return Boolean(customMode) || options.length === 0
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
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]
      const active = i === questionOptionSelected
      const prefix = active ? "▸" : " "
      const marker = currentQ.multi
        ? (multiSelected.has(i) ? "☑" : "☐")
        : (active ? "●" : "○")
      const optLine = ` ${prefix} ${marker} ${opt.label}`
      lines.push(
        active
          ? paint(`│${padRight(optLine, inner)}│`, "#111111", { bg: theme.semantic.info, bold: true })
          : paint(`│${padRight(optLine, inner)}│`, theme.base.fg)
      )
      if (opt.description) {
        lines.push(paint(`│${padRight(`       ${opt.description}`, inner)}│`, theme.base.muted))
      }
    }
    if (currentQ.allowCustom !== false) {
      const active = questionOptionSelected === options.length
      const customLine = ` ${active ? "▸" : " "}   Custom...`
      lines.push(
        active
          ? paint(`│${padRight(customLine, inner)}│`, "#111111", { bg: theme.semantic.info, bold: true })
          : paint(`│${padRight(customLine, inner)}│`, theme.base.muted)
      )
    }
  }

  lines.push(paint(`│${"─".repeat(rule)}│`, theme.base.border))
  const multiCount = currentQ.multi ? (questionMultiSelected[currentQ.id] || new Set()).size : 0
  const multiHint = currentQ.multi && multiCount > 0 ? `  (${multiCount} selected)` : ""
  row(`Answered: ${answered}/${qCount}${multiHint}  [Ctrl+Enter submit all]`, theme.base.muted)
  lines.push(paint(`└${"─".repeat(rule)}┘`, theme.base.border))

  return { lines, cursor, textCursor }
}
