import { paint } from "../theme/color.mjs"
import { sanitizeTerminalValue } from "../theme/terminal-sanitize.mjs"
import { renderFrameDashboardHeader, renderReplStatusLine } from "../ui/repl-status-view.mjs"
import { buildTranscriptViewport } from "../ui/repl-transcript-panel.mjs"
import { renderSelectOverlay } from "../ui/overlay-select.mjs"
import { renderPanelOverlay } from "../ui/overlay-panel.mjs"
import { formatThinkingDuration } from "../ui/thinking-state.mjs"
import { thinkingPreviewLines } from "../ui/thinking-preview.mjs"
import { slashSuggestions } from "./slash-router.mjs"
import { POLICY_CHOICES, PERMISSION_PROMPT_CHOICES } from "./permission-flow.mjs"
import { resolveModeId, MODE_PICKER_CHOICES } from "./mode-flow.mjs"
import { layoutInputText } from "./text-layout.mjs"
import { clipAnsiLine, padRight, wrapLogLines } from "./frame-primitives.mjs"

/**
 * 整帧组装：把 UI 状态渲染成一屏文本行。
 *
 * 从 repl.mjs 的 startTuiRepl 里抽出来的 456 行。抽它的理由不是行数，是
 * **宽高此前直接读 process.stdout**：
 *
 *   const width = Number(process.stdout.columns || 120)
 *
 * 测试进程里那两个值恒为 undefined，于是所有分档逻辑一律走 120×40 这一条路 ——
 * 0.6.1 的状态栏事故（86 列下 PERMISSION 段被截掉、整条状态栏溢出）就是这么
 * 漏过 1148 条测试的。宽高改成参数之后，任意宽度都能断言。
 *
 * 同理 `Date.now()` 也提成 `now` 参数：思考计时用它算已耗时，写死系统时间会让
 * 整帧不可断言。
 *
 * 依赖分三类，都显式传入而非闭包捕获：
 *   - 状态：ui / ctx / state / transcript
 *   - 尺寸与时间：width / height / now
 *   - 宿主回调：slashOptions（斜杠候选来源）、applySelectionHighlight（选区高亮）、
 *     renderToastLine（提示条）—— 它们依赖 REPL 运行期的东西，不适合搬进来
 */

const MAX_TUI_SUGGESTIONS = 5
const MAX_MODEL_PICKER_VISIBLE = 8
const BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function clipBusy(text, max) {
  const s = String(text || "").trim().split("\n")[0]
  return s.length > max ? s.slice(0, max - 3) + "..." : s
}

export function formatBusyToolDetail(toolName, args) {
  if (!args) return ""
  switch (toolName) {
    case "bash": return args.command ? paint(` ${clipBusy(args.command, 60)}`, null, { dim: true }) : ""
    case "read": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "write": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "edit": return args.path ? paint(` ${clipBusy(args.path, 60)}`, null, { dim: true }) : ""
    case "notebookedit": return args.path ? paint(` ${clipBusy(args.path, 50)} cell ${args.cell_number ?? 0}`, null, { dim: true }) : ""
    case "grep": return args.pattern ? paint(` ${clipBusy(args.pattern, 40)}`, null, { dim: true }) : ""
    case "glob": return args.pattern ? paint(` ${clipBusy(args.pattern, 40)}`, null, { dim: true }) : ""
    case "patch": return args.path ? paint(` ${clipBusy(args.path, 40)} L${args.start_line || "?"}-${args.end_line || "?"}`, null, { dim: true }) : ""
    case "task": return args.description ? paint(` ${clipBusy(args.description, 50)}`, null, { dim: true }) : ""
    case "enter_plan": return args.reason ? paint(` ${clipBusy(args.reason, 50)}`, null, { dim: true }) : paint(" planning...", null, { dim: true })
    case "exit_plan": return paint(" submitting plan...", null, { dim: true })
    default: return ""
  }
}

export function renderSuggestions({ inputLine, suggestions, selected, offset, maxVisible, theme, width }) {
  const sigil = String(inputLine || "").startsWith("$") ? "$" : String(inputLine || "").startsWith("/") ? "/" : null
  if (!sigil || !suggestions.length) {
    return { lines: [], offset: 0 }
  }
  const visible = Math.max(1, maxVisible || MAX_TUI_SUGGESTIONS)
  let start = Math.max(0, Math.min(offset || 0, Math.max(0, suggestions.length - visible)))
  if (selected < start) start = selected
  if (selected >= start + visible) start = selected - visible + 1

  const end = Math.min(suggestions.length, start + visible)
  const view = suggestions.slice(start, end)
  const lines = [
    paint(
      `${sigil === "$" ? "Skills" : "Slash Commands"} (${selected + 1}/${suggestions.length})  Enter choose, Enter again execute`,
      theme.base.muted,
      { bold: true }
    )
  ]
  for (let i = 0; i < view.length; i++) {
    const item = view[i]
    const index = start + i
    const active = index === selected
    const prefix = active ? ">" : " "
    const line = `${prefix} ${sigil}${padRight(item.name, 14)} ${item.desc}`
    lines.push(
      active
        ? paint(line, "#111111", { bg: theme.semantic.info, bold: true })
        : paint(line, theme.base.fg)
    )
  }
  if (suggestions.length > visible) {
    lines.push(
      paint(`scroll: ${start + 1}-${end}/${suggestions.length} (Up/Down)`, theme.base.muted)
    )
  }
  return {
    lines: lines.map((line) => clipAnsiLine(line, width)),
    offset: start
  }
}

export function buildFrame({
  ui,
  ctx,
  state,
  transcript,
  width,
  height,
  slashOptions,
  applySelectionHighlight,
  renderToastLine,
  // 时间也当参数：思考计时用它算已耗时，写死 Date.now() 会让整帧不可断言。
  now = Date.now()
}) {

  const dashboardLines = renderFrameDashboardHeader({
    showDashboard: ui.showDashboard,
    theme: ctx.themeState.theme,
    columns: width
  })

  const suggestions = slashSuggestions(ui.input, slashOptions)
  if (suggestions.length === 0) {
    ui.selectedSuggestion = 0
    ui.suggestionOffset = 0
  } else if (ui.selectedSuggestion >= suggestions.length) {
    ui.selectedSuggestion = suggestions.length - 1
  }
  const suggestionRender = renderSuggestions({
    inputLine: ui.input,
    suggestions,
    selected: ui.selectedSuggestion,
    offset: ui.suggestionOffset,
    maxVisible: MAX_TUI_SUGGESTIONS,
    theme: ctx.themeState.theme,
    width: Math.max(1, width - 4)
  })
  const suggestionLines = suggestionRender.lines
  ui.suggestionOffset = suggestionRender.offset

  const status = renderReplStatusLine({
    state,
    configState: ctx.configState,
    theme: ctx.themeState.theme,
    tokenMeter: ui.metrics.tokenMeter,
    cost: ui.metrics.cost,
    costSavings: ui.metrics.costSavings,
    contextMeter: ui.metrics.context,
    longagentState: ui.metrics.longagent,
    // 状态栏必须按**帧的宽度**排版。此前它自己读 process.stdout.columns，
    // 于是排版宽度和帧宽度可以不一致：86 列的帧里塞一条按 120 列排的状态栏，
    // 超出部分被 clipAnsiLine 从右边硬切，而 PERMISSION 恰好在最右。
    width
  })

  const lines = []
  let dashboardRows = 0
  if (ui.showDashboard && dashboardLines.length) {
    dashboardRows = Math.min(dashboardLines.length, Math.max(5, Math.floor(height * 0.22)))
    lines.push(...dashboardLines.slice(0, dashboardRows).map((line) => clipAnsiLine(line, width)))
    lines.push(" ".repeat(width))
  }

  const inputInnerWidth = Math.max(8, width - 4)
  const imgTag = ui.pendingImages.length ? `[${ui.pendingImages.length} img] ` : ""
  const stateIndicator = ui.busy
    ? paint("● ", ctx.themeState.theme.semantic.warn)
    : ui.paused
      ? paint("⏸ ", ctx.themeState.theme.base.muted)
      : paint("❯ ", ctx.themeState.theme.semantic.success)
  const inputVisibleRows = Math.max(1, Math.min(5, Math.floor(height * 0.2)))
  const inputLayout = layoutInputText({
    value: ui.input,
    cursor: ui.inputCursor,
    width: inputInnerWidth,
    maxRows: inputVisibleRows,
    prefix: `${stateIndicator}${imgTag}`,
    selection: ui.inputSelection,
    ghost: ui.inputSelection ? "" : ui.ghostText
  })
  ui.inputCursor = inputLayout.normalizedCursor
  ui.inputLayout = inputLayout
  const visibleInput = inputLayout.lines
  let busyLine
  if (ui.busy && ui.currentActivity) {
    const spinner = BUSY_SPINNER_FRAMES[ui.spinnerIndex]
    const stepTag = ui.currentStep > 0
      ? paint(` [${ui.currentStep}/${ui.maxSteps || "?"}]`, "cyan", { dim: true })
      : ""
    if (ui.currentActivity.type === "tool") {
      const toolName = ui.currentActivity.tool || "tool"
      const toolColor = toolName === "edit" || toolName === "write" || toolName === "notebookedit" ? "yellow"
        : toolName === "bash" ? "magenta"
        : "cyan"
      busyLine = `${paint(spinner, toolColor)} ${paint(toolName, toolColor, { bold: true })}${formatBusyToolDetail(toolName, ui.currentActivity.args)}${stepTag}`
    } else if (ui.currentActivity.type === "writing") {
      busyLine = `${paint(spinner, "green")} ${paint("writing", "green", { bold: true })}${stepTag}`
    } else {
      const elapsed = ui.thinking.startedAt
        ? formatThinkingDuration(now - ui.thinking.startedAt)
        : "0.0s"
      const dots = ".".repeat((ui.spinnerIndex % 3) + 1)
      busyLine = `${paint(spinner, ctx.themeState.theme.semantic.warn)} ${paint(`Thinking${dots} · ${elapsed}`, ctx.themeState.theme.semantic.warn, { bold: true })}${stepTag}`
    }
  } else if (ui.busy) {
    const spinner = BUSY_SPINNER_FRAMES[ui.spinnerIndex]
    const elapsed = ui.thinking.startedAt
      ? formatThinkingDuration(now - ui.thinking.startedAt)
      : "0.0s"
    const dots = ".".repeat((ui.spinnerIndex % 3) + 1)
    busyLine = `${paint(spinner, ctx.themeState.theme.semantic.warn)} ${paint(`Thinking${dots} · ${elapsed}`, ctx.themeState.theme.semantic.warn, { bold: true })}`
  } else {
    busyLine = ""
  }

  const suggestionsTitleLine = paint("Commands", ctx.themeState.theme.base.muted, { bold: true })
  const PERM_CHOICES = PERMISSION_PROMPT_CHOICES
  const permissionLines = []
  if (ui.pendingPermission) {
    const perm = ui.pendingPermission
    const displayPerm = sanitizeTerminalValue({
      tool: perm.tool,
      command: perm.command,
      pattern: perm.pattern,
      risk: perm.risk,
      reason: perm.reason
    })
    const target = displayPerm.command ||
      (displayPerm.pattern && displayPerm.pattern !== "*" ? displayPerm.pattern : "")
    const toolInfo = `tool: ${displayPerm.tool}  risk: ${displayPerm.risk || 0}/10`
    const reasonInfo = displayPerm.reason ? `  ${displayPerm.reason}` : ""
    const permHeader = [{ text: toolInfo, color: ctx.themeState.theme.base.fg }]
    if (target) permHeader.push({ text: `target: ${target}`, color: ctx.themeState.theme.semantic.warn })
    if (reasonInfo) permHeader.push({ text: reasonInfo, color: ctx.themeState.theme.base.muted })
    permissionLines.push(...renderSelectOverlay({
      title: "Permission Request",
      hint: "↑↓ navigate  Enter select  Esc deny",
      items: PERM_CHOICES.map((choice) => ({ label: choice.label })),
      selected: ui.permissionSelected,
      width,
      theme: ctx.themeState.theme,
      accent: ctx.themeState.theme.semantic.warn,
      paint,
      padRight,
      header: permHeader,
      numbered: true
    }).lines)
  }
  const modelPickerLines = []
  if (ui.modelPicker) {
    const mp = ui.modelPicker
    const rendered = renderSelectOverlay({
      title: `Select Model (${mp.selected + 1}/${mp.items.length})`,
      hint: "↑↓ navigate  Enter select  Esc cancel",
      items: mp.items.map((item) => ({
        label: item.label,
        current: item.model === state.model && item.provider === state.providerType
      })),
      selected: mp.selected,
      offset: mp.offset,
      maxVisible: MAX_MODEL_PICKER_VISIBLE,
      width,
      theme: ctx.themeState.theme,
      accent: ctx.themeState.theme.semantic.info,
      paint,
      padRight,
      markers: true
    })
    mp.offset = rendered.offset
    modelPickerLines.push(...rendered.lines)
  }
  // provider 选择器。0.6.13 之前 `/provider` 打印一份编号列表到对话记录，
  // 然后进一个「输入编号」的模式 —— 配置 provider 是个选择动作，理应和
  // /model 一样是可视化选择器，而不是让用户在滚动的对话记录里数行号。
  const providerPickerLines = []
  if (ui.providerPicker && Array.isArray(ui.providerPicker.items)) {
    const pp = ui.providerPicker
    const rendered = renderSelectOverlay({
      title: `Select Provider (${pp.selected + 1}/${pp.items.length})`,
      hint: "↑↓ navigate  Enter select  Esc cancel  (/provider add 新增)",
      items: pp.items.map((item) => ({
        label: item.label,
        desc: item.desc,
        current: item.name === state.providerType
      })),
      selected: pp.selected,
      offset: pp.offset || 0,
      maxVisible: MAX_MODEL_PICKER_VISIBLE,
      width,
      theme: ctx.themeState.theme,
      accent: ctx.themeState.theme.semantic.info,
      paint,
      padRight,
      markers: true,
      layout: "two-column"
    })
    pp.offset = rendered.offset
    providerPickerLines.push(...rendered.lines)
  }

  // 会话选择器（裸 /resume）。与 provider 选择器同构。
  const sessionPickerLines = []
  if (ui.sessionPicker && Array.isArray(ui.sessionPicker.items)) {
    const sp = ui.sessionPicker
    const rendered = renderSelectOverlay({
      title: `Resume Session (${sp.selected + 1}/${sp.items.length})`,
      hint: "↑↓ navigate  Enter resume  Esc cancel",
      items: sp.items.map((item) => ({
        label: item.label,
        desc: item.desc,
        current: item.id === state.sessionId
      })),
      selected: sp.selected,
      offset: sp.offset || 0,
      maxVisible: MAX_MODEL_PICKER_VISIBLE,
      width,
      theme: ctx.themeState.theme,
      accent: ctx.themeState.theme.semantic.info,
      paint,
      padRight,
      markers: true,
      layout: "two-column"
    })
    sp.offset = rendered.offset
    sessionPickerLines.push(...rendered.lines)
  }

  const modePickerLines = []
  if (ui.modePicker) {
    const currentModeId = state.modeId || resolveModeId(state.mode)
    modePickerLines.push(...renderSelectOverlay({
      title: "Mode",
      hint: "↑↓ navigate  Enter select  Esc cancel  (Shift+Tab cycles)",
      items: MODE_PICKER_CHOICES.map((choice) => ({
        label: choice.label,
        desc: choice.desc,
        current: choice.value === currentModeId
      })),
      selected: ui.modePicker.selected,
      width,
      theme: ctx.themeState.theme,
      accent: ctx.themeState.theme.semantic.info,
      paint,
      padRight,
      layout: "two-column",
      markers: true
    }).lines)
  }

  const policyPickerLines = []
  if (ui.policyPicker) {
    const currentPolicy = ctx.configState.config.permission?.level || ctx.configState.config.permission?.mode || ctx.configState.config.permission?.default_policy || "auto"
    policyPickerLines.push(...renderSelectOverlay({
      title: "Permission Policy",
      hint: "↑↓ navigate  Enter select  Esc cancel",
      items: POLICY_CHOICES.map((choice) => ({
        label: choice.label,
        desc: choice.desc,
        current: choice.value === currentPolicy
      })),
      selected: ui.policyPicker.selected,
      width,
      theme: ctx.themeState.theme,
      accent: ctx.themeState.theme.semantic.info,
      paint,
      padRight,
      layout: "two-column",
      markers: true
    }).lines)
  }

  // --- Question panel ---
  const questionLines = []
  let questionCursor = null
  if (ui.pendingQuestion) {
    const pq = ui.pendingQuestion
    const questions = pq.questions || []
    const qCount = questions.length
    const currentQ = questions[ui.questionIndex] || {}
    const options = Array.isArray(currentQ.options) ? currentQ.options : []
    const answered = Object.keys(ui.questionAnswers).length

    // Header
    const hintKeys = ui.questionCustomMode
      ? "Enter confirm  Esc back"
      : "↑↓ select  Enter confirm  Tab switch  Esc skip  Ctrl+Enter submit all"
    questionLines.push(
      paint(`Question (${ui.questionIndex + 1}/${qCount})  ${hintKeys}`, ctx.themeState.theme.semantic.info, { bold: true })
    )
    questionLines.push(paint(`┌${"─".repeat(Math.max(1, width - 4))}┐`, ctx.themeState.theme.base.border))

    // Tab bar (multi-question)
    if (qCount > 1) {
      let tabBar = ""
      for (let i = 0; i < qCount; i++) {
        const qId = questions[i].id
        const done = qId in ui.questionAnswers
        const isCurrent = i === ui.questionIndex
        const marker = done ? "✓" : " "
        const tabLabel = (questions[i].header || `Q${i + 1}`).slice(0, 12)
        tabBar += isCurrent ? `[${marker}${tabLabel}]` : ` ${marker}${tabLabel} `
        if (i < qCount - 1) tabBar += " "
      }
      questionLines.push(paint(`│ ${padRight(tabBar, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg))
      questionLines.push(paint(`│${"─".repeat(Math.max(1, width - 4))}│`, ctx.themeState.theme.base.border))
    }

    // Question text
    questionLines.push(paint(`│ ${padRight(currentQ.text || "", Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg))
    if (currentQ.description) {
      questionLines.push(paint(`│ ${padRight(currentQ.description, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted))
    }
    questionLines.push(paint(`│${"─".repeat(Math.max(1, width - 4))}│`, ctx.themeState.theme.base.border))

    if (ui.questionCustomMode || options.length === 0) {
      // Custom/free-text mode uses the same grapheme-aware layout as the
      // main composer so the hardware cursor and IME stay anchored here.
      const questionInputLayout = layoutInputText({
        value: ui.questionCustomInput,
        cursor: ui.questionCustomCursor,
        width: Math.max(1, width - 5),
        maxRows: 3,
        prefix: ""
      })
      ui.questionCustomCursor = questionInputLayout.normalizedCursor
      questionLines.push(
        paint(`│ ${padRight(options.length ? "Custom input:" : "Answer:", Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted)
      )
      const questionInputStart = questionLines.length
      for (const [index, inputLine] of questionInputLayout.lines.entries()) {
        const visible = inputLine || (index === 0
          ? paint("(type your answer)", ctx.themeState.theme.base.muted, { dim: true })
          : "")
        questionLines.push(
          `│ ${padRight(visible, Math.max(1, width - 5))}│`
        )
      }
      questionCursor = {
        row: questionInputStart + questionInputLayout.cursor.row,
        col: 3 + questionInputLayout.cursor.col
      }
    } else if (options.length) {
      // Options list
      const multiSelected = ui.questionMultiSelected[currentQ.id] || new Set()
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]
        const active = i === ui.questionOptionSelected
        const prefix = active ? "▸" : " "
        let marker
        if (currentQ.multi) {
          marker = multiSelected.has(i) ? "☑" : "☐"
        } else {
          marker = active ? "●" : "○"
        }
        const optLine = ` ${prefix} ${marker} ${opt.label}`
        questionLines.push(
          active
            ? paint(`│${padRight(optLine, Math.max(1, width - 5))}│`, "#111111", { bg: ctx.themeState.theme.semantic.info, bold: true })
            : paint(`│${padRight(optLine, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.fg)
        )
        if (opt.description) {
          questionLines.push(paint(`│${padRight(`       ${opt.description}`, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted))
        }
      }
      // Custom option
      if (currentQ.allowCustom !== false) {
        const customIdx = options.length
        const active = ui.questionOptionSelected === customIdx
        const prefix = active ? "▸" : " "
        const customLine = ` ${prefix}   Custom...`
        questionLines.push(
          active
            ? paint(`│${padRight(customLine, Math.max(1, width - 5))}│`, "#111111", { bg: ctx.themeState.theme.semantic.info, bold: true })
            : paint(`│${padRight(customLine, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted)
        )
      }
    }

    // Footer
    questionLines.push(paint(`│${"─".repeat(Math.max(1, width - 4))}│`, ctx.themeState.theme.base.border))
    const multiCount = currentQ.multi ? (ui.questionMultiSelected[currentQ.id] || new Set()).size : 0
    const multiHint = currentQ.multi && multiCount > 0 ? `  (${multiCount} selected)` : ""
    const footerText = `Answered: ${answered}/${qCount}${multiHint}  [Ctrl+Enter submit all]`
    questionLines.push(paint(`│ ${padRight(footerText, Math.max(1, width - 5))}│`, ctx.themeState.theme.base.muted))
    questionLines.push(paint(`└${"─".repeat(Math.max(1, width - 4))}┘`, ctx.themeState.theme.base.border))
  }

  // 对话区之下的全部浮层块。求和与推入都遍历这个列表 —— 唯一来源。
  //
  // 此前 fixedRows 是一串手写加法，与下面一串手写 push 各说各话：新增一个
  // UI 块只要漏掉其中一边，logRows 就算错，而 buildFrame 在测试里够不着，
  // CI 全绿、真终端上对话区被挤没。让两边同源，这个错就犯不出来了。
  // 思考实时预览：固定两行灰字，显示思考流的尾部。行数固定是硬约束 ——
  // 会变高的块会让对话区随模型输出上下抖动（fixedRows 按实际行数计费）。
  const thinkingPreview = (ui.busy && ui.thinking?.phase === "streaming" && ui.thinking.raw)
    ? thinkingPreviewLines(ui.thinking.raw, Math.max(20, width - 4))
        .map((line) => clipAnsiLine(`  ${paint(line, ctx.themeState.theme.base.muted, { dim: true })}`, width))
    : []

  // 只读信息浮层（/status、/permission、/keys 之类）。放在最前面是因为它
  // 与选择器互斥：打开它时不该同时有别的浮层在抢屏。
  const infoPanelLines = []
  if (ui.infoPanel) {
    const panel = renderPanelOverlay({
      title: ui.infoPanel.title || "info",
      lines: ui.infoPanel.lines || [],
      offset: ui.infoPanel.offset || 0,
      width,
      maxRows: Math.max(4, Math.min(Number(ui.infoPanel.maxRows) || 14, Math.floor(height * 0.6))),
      theme: ctx.themeState.theme,
      accent: ctx.themeState.theme.base.accent,
      paint,
      clipAnsiLine,
      wrapLines: (lines, w) => wrapLogLines(lines, w),
      // 自带边框的内容（runtime 视图、ultra 看板）不能折行 —— 折了框就断成两段。
      // 缺省 true 是为了兼容没带这个字段的旧浮层状态。
      wrap: ui.infoPanel.wrap !== false
    })
    // 回写夹紧后的 offset 与总行数，键盘处理据此判断能否继续滚
    ui.infoPanel.offset = panel.offset
    ui.infoPanel.maxOffset = panel.maxOffset
    infoPanelLines.push(...panel.lines)
  }

  const overlayBlocks = [
    { name: "infoPanel", lines: infoPanelLines },
    { name: "thinkingPreview", lines: thinkingPreview },
    { name: "suggestions", lines: suggestionLines.length ? [suggestionsTitleLine, ...suggestionLines] : [] },
    { name: "modelPicker", lines: modelPickerLines },
    { name: "providerPicker", lines: providerPickerLines },
    { name: "sessionPicker", lines: sessionPickerLines },
    { name: "policyPicker", lines: policyPickerLines },
    { name: "modePicker", lines: modePickerLines },
    { name: "permission", lines: permissionLines },
    { name: "question", lines: questionLines }
  ]
  const overlayRows = overlayBlocks.reduce((total, block) => total + block.lines.length, 0)

  const fixedRows =
    1 + // activity title
    1 + // scroll hint
    overlayRows +
    1 + // status bar
    1 + // busy indicator
    1 + // input top border
    visibleInput.length +
    1 + // input bottom border
    1 // footer hint

  const logRows = Math.max(2, height - lines.length - fixedRows)
  const transcriptViewport = buildTranscriptViewport({
    logs: transcript.getItems(),
    width,
    logRows,
    scrollOffset: ui.scrollOffset,
    wrapLogLines,
    clipAnsiLine,
    paint,
    theme: ctx.themeState.theme
  })
  const wrappedLogs = transcriptViewport.wrappedLogs
  ui.scrollOffset = transcriptViewport.scrollOffset
  ui.scrollMeta = transcriptViewport.scrollMeta
  const scrollHint = transcriptViewport.scrollHint

  lines.push(clipAnsiLine(paint("─".repeat(Math.min(40, width)), ctx.themeState.theme.base.border, { dim: true }), width))

  // 记录日志区起始行号（0-based in lines array, 1-based on screen）
  const logStartRow = lines.length
  lines.push(...transcriptViewport.lines)

  const logEndRow = lines.length  // 日志区结束行号（不含）

  lines.push(clipAnsiLine(scrollHint, width))

  let questionStartRow = null
  for (const block of overlayBlocks) {
    if (!block.lines.length) continue
    if (block.name === "question") questionStartRow = lines.length
    for (const line of block.lines) lines.push(clipAnsiLine(line, width))
  }

  lines.push(clipAnsiLine(status, width))
  // Toast 与 `Thinking · Ns` 此前抢同一行，toast 一出现就会盖掉思考计时。
  // 忙碌时把 toast 挤到状态栏那侧，两者同时可见。
  const toastLine = renderToastLine()
  if (toastLine && ui.busy && busyLine) {
    const half = Math.max(20, Math.floor(width / 2))
    lines.push(clipAnsiLine(`${padRight(clipAnsiLine(busyLine, half - 1), half)}${toastLine}`, width))
  } else {
    lines.push(clipAnsiLine(toastLine || busyLine, width))
  }

  const inputTop = paint(`┌${"─".repeat(Math.max(1, width - 2))}┐`, ctx.themeState.theme.base.border)
  const inputBottom = paint(`└${"─".repeat(Math.max(1, width - 2))}┘`, ctx.themeState.theme.base.border)
  lines.push(inputTop)
  const inputStartRow = lines.length  // 输入区内容起始行
  for (const inputLine of visibleInput) {
    const left = paint("│ ", ctx.themeState.theme.base.border)
    const right = paint(" │", ctx.themeState.theme.base.border)
    lines.push(`${left}${clipAnsiLine(inputLine, inputInnerWidth)}${right}`)
  }
  const inputEndRow = lines.length  // 输入区内容结束行（不含）
  lines.push(inputBottom)
  lines.push(clipAnsiLine(paint("↵ send  ⌃J newline  ⌃Y auto-copy  /paste image  ? help", ctx.themeState.theme.base.muted, { dim: true }), width))

  // In very small terminals, preserve the composer and its real cursor by
  // trimming overflow from the top rather than cutting off the bottom pane.
  const frameStartRow = Math.max(0, lines.length - Math.max(1, height))
  const final = lines.slice(frameStartRow, frameStartRow + Math.max(1, height))
  while (final.length < height) final.push(" ".repeat(width))

  // 鼠标选择高亮：对选中区域应用反色
  if (ui.mouseSelection) {
    applySelectionHighlight(final, ui.mouseSelection)
  }

  // 存储布局元数据供鼠标事件使用（行号均为 1-based 屏幕坐标）
  ui.layoutMeta = {
    logStartRow: logStartRow + 1 - frameStartRow,
    logEndRow: logEndRow - frameStartRow,
    inputStartRow: inputStartRow + 1 - frameStartRow,
    inputEndRow: inputEndRow - frameStartRow,
    inputInnerOffset: 3,  // "│ " 占 2 个可见字符 + 1 (1-based)
    width,
    // 屏幕行 ↔ transcript 绝对行的换算基准
    visibleStartIndex: transcriptViewport.visibleStartIndex,
    transcriptLines: transcriptViewport.allLines,
    transcriptHitRegions: (transcriptViewport.hitRegions || []).map((region) => ({
      ...region,
      row: logStartRow + region.viewportRow + 1 - frameStartRow
    }))
  }

  const composerCursor = {
    row: inputStartRow + inputLayout.cursor.row + 1 - frameStartRow,
    col: Math.max(1, Math.min(width, 3 + inputLayout.cursor.col)),
    visible: true
  }
  const modalCursor = questionCursor && questionStartRow !== null
    ? {
        row: questionStartRow + questionCursor.row + 1 - frameStartRow,
        col: Math.max(1, Math.min(width, questionCursor.col)),
        visible: true
      }
    : null

  return {
    lines: final,
    width,
    height,
    wrappedLogs,
    cursor: modalCursor || composerCursor
  }
}
