import { paint } from "../theme/color.mjs"
import { formatPlanProgress } from "./activity-renderer.mjs"

export function createInputBufferState(text = "") {
  return {
    text: String(text || ""),
    cursor: String(text || "").length,
    selection: null,
    dragAnchor: -1
  }
}

export function insertIntoInputBuffer(buffer, text) {
  if (!buffer || !text) return buffer
  const next = deleteInputBufferSelection(buffer)
  const head = next.text.slice(0, next.cursor)
  const tail = next.text.slice(next.cursor)
  next.text = `${head}${text}${tail}`
  next.cursor += text.length
  return next
}

export function moveInputCursor(buffer, delta) {
  if (!buffer) return buffer
  buffer.cursor = Math.max(0, Math.min(buffer.text.length, buffer.cursor + delta))
  return buffer
}

export function setInputCursor(buffer, position) {
  if (!buffer) return buffer
  buffer.cursor = Math.max(0, Math.min(buffer.text.length, position))
  return buffer
}

export function deleteInputBufferSelection(buffer) {
  if (!buffer?.selection) return buffer
  const { start, end } = buffer.selection
  if (start === end) {
    buffer.selection = null
    buffer.dragAnchor = -1
    return buffer
  }
  const from = Math.max(0, Math.min(start, end))
  const to = Math.max(0, Math.max(start, end))
  buffer.text = buffer.text.slice(0, from) + buffer.text.slice(to)
  buffer.cursor = from
  buffer.selection = null
  buffer.dragAnchor = -1
  return buffer
}

export function createScrollState() {
  return {
    offset: 0,
    logRows: 0,
    totalRows: 0,
    maxOffset: 0
  }
}

export function syncScrollViewport(scroll, { logRows, totalRows }) {
  if (!scroll) return createScrollState()
  scroll.logRows = Math.max(0, Number(logRows) || 0)
  scroll.totalRows = Math.max(0, Number(totalRows) || 0)
  scroll.maxOffset = Math.max(0, scroll.totalRows - scroll.logRows)
  scroll.offset = Math.max(0, Math.min(scroll.maxOffset, scroll.offset || 0))
  return scroll
}

export function scrollByDelta(scroll, delta) {
  if (!scroll) return createScrollState()
  scroll.offset = Math.max(0, Math.min(scroll.maxOffset || 0, (scroll.offset || 0) + delta))
  return scroll
}

export function scrollToTop(scroll) {
  if (!scroll) return createScrollState()
  scroll.offset = scroll.maxOffset || 0
  return scroll
}

export function scrollToBottom(scroll) {
  if (!scroll) return createScrollState()
  scroll.offset = 0
  return scroll
}

export function shouldUseAlternateScreen(configUi = {}, stream = process.stdout) {
  const policy = configUi?.alternate_screen || "auto"
  if (policy === "always") return true
  if (policy === "never") return false
  if (!stream?.isTTY) return false
  if ((process.env.TERM || "").toLowerCase() === "dumb") return false
  if (process.env.CI) return false
  return true
}

function longagentStageLabel(state) {
  if (state?.currentStageId) return state.currentStageId
  if (Number.isFinite(state?.stageIndex) && Number.isFinite(state?.stageCount) && state.stageCount > 0) {
    return `${state.stageIndex + 1}/${state.stageCount}`
  }
  return "-"
}

function clipPanelText(text = "", max = 80) {
  const value = String(text || "").trim().replace(/\s+/g, " ")
  if (!value) return ""
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function panelRow(text = "", width = 80, color = null, options = {}) {
  const plain = clipPanelText(text, width)
  return paint(`│ ${plain.padEnd(width)} │`, color, options)
}

function longagentProgressBar(percent, width = 18) {
  if (!Number.isFinite(percent)) return "pending"
  const safe = Math.max(0, Math.min(100, Math.round(percent)))
  const filled = Math.round(width * safe / 100)
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))} ${safe}%`
}

function formatLongagentTimeline(longagentState, { maxItems = 4, textWidth = 72 } = {}) {
  if (!longagentState || typeof longagentState !== "object") return []
  const timeline = []
  const reports = Array.isArray(longagentState.stageReports) ? longagentState.stageReports : []
  const checkpoints = Array.isArray(longagentState.checkpoints) ? longagentState.checkpoints : []

  for (const report of reports.slice(-Math.max(0, maxItems))) {
    timeline.push({
      key: `stage:${report.stageId || "unknown"}:${report.updatedAt || report.completedAt || timeline.length}`,
      text: [
        "stage",
        report.stageId || "-",
        String(report.status || "-").toUpperCase(),
        `${report.successCount || 0} ok/${report.failCount || 0} fail`
      ].join(" ")
    })
  }

  for (const checkpoint of checkpoints.slice(-Math.max(0, maxItems))) {
    timeline.push({
      key: `checkpoint:${checkpoint.id || timeline.length}`,
      text: [
        "checkpoint",
        checkpoint.phase || "-",
        checkpoint.kind || "checkpoint",
        clipPanelText(checkpoint.summary || "", Math.max(16, textWidth - 28))
      ].join(" ")
    })
  }

  if (longagentState.backgroundTaskId) {
    timeline.push({
      key: `background:${longagentState.backgroundTaskId}`,
      text: [
        "background",
        longagentState.backgroundTaskStatus || "unknown",
        longagentState.backgroundTaskId,
        `attempt=${longagentState.backgroundTaskAttempt || 0}`
      ].join(" ")
    })
  }

  return timeline
    .slice(-Math.max(0, maxItems))
    .map((entry) => entry.text)
}

function recommendLongagentAction(longagentState) {
  if (!longagentState?.sessionId) return null
  if (["interrupted", "error", "cancel_requested"].includes(longagentState.backgroundTaskStatus || "")) {
    return {
      command: `kkcode longagent recover --session ${longagentState.sessionId}`,
      reason: `background task is ${longagentState.backgroundTaskStatus}`
    }
  }
  const checkpoints = Array.isArray(longagentState.checkpoints) ? longagentState.checkpoints : []
  const latestCheckpointId = checkpoints.length ? checkpoints[checkpoints.length - 1].id : null
  if ((longagentState.lastStageReport?.status === "fail" || Number(longagentState.recoveryCount || 0) > 0) && latestCheckpointId) {
    return {
      command: `kkcode longagent recover-checkpoint --session ${longagentState.sessionId} --checkpoint ${latestCheckpointId}`,
      reason: longagentState.lastStageReport?.status === "fail"
        ? `last stage ${longagentState.lastStageReport.stageId || "-"} failed`
        : `recovery_count=${longagentState.recoveryCount || 0}`
    }
  }
  return null
}

function compactRecommendedCommand(command = "") {
  const value = String(command || "")
  const checkpointMatch = value.match(/recover-checkpoint --session [^ ]+ --checkpoint ([^ ]+)/)
  if (checkpointMatch) return `recover-checkpoint ${checkpointMatch[1]}`
  const recoverMatch = value.match(/recover --session ([^ ]+)/)
  if (recoverMatch) return `recover ${recoverMatch[1]}`
  return value
}

export function renderLongAgentPanel(longagentState, { width, theme }) {
  if (!longagentState) return []
  const innerWidth = Math.max(16, (width || 80) - 4)
  const border = theme?.base?.border || "#666666"
  const fg = theme?.base?.fg || "white"
  const muted = theme?.base?.muted || "#999999"
  const warn = theme?.semantic?.warn || "yellow"
  const success = theme?.semantic?.success || "green"

  const lines = []
  lines.push(paint(`┌${"─".repeat(innerWidth + 2)}┐`, border))
  lines.push(paint(`│ LongAgent Control${" ".repeat(Math.max(0, innerWidth - 17))} │`, success, { bold: true }))

  const summary = [
    `status=${longagentState.status || "-"}`,
    `phase=${longagentState.phase || "-"}`,
    `stage=${longagentStageLabel(longagentState)}`,
    `gate=${longagentState.currentGate || "-"}`,
    `remaining=${Number.isFinite(longagentState.remainingFilesCount) ? longagentState.remainingFilesCount : "-"}`
  ].join("  ")
  lines.push(panelRow(summary, innerWidth, fg))

  const progress = `progress=${longagentProgressBar(longagentState.progress?.percentage, Math.min(18, Math.max(8, innerWidth - 40)))}`
  const iteration = `iter=${longagentState.maxIterations ? `${longagentState.iterations || 0}/${longagentState.maxIterations}` : String(longagentState.iterations ?? "-")}`
  const recovery = `recovery=${longagentState.recoveryCount || 0}`
  const line2 = `${progress}  ${iteration}  ${recovery}`
  lines.push(panelRow(line2, innerWidth, muted))

  if (longagentState.stageProgress?.total) {
    const stageProgress = `tasks=${longagentState.stageProgress.done || 0}/${longagentState.stageProgress.total}`
    lines.push(panelRow(stageProgress, innerWidth, fg))
  }

  if (longagentState.gitBranch) {
    const gitLine = `git=${longagentState.gitBranch}${longagentState.gitBaseBranch ? ` <- ${longagentState.gitBaseBranch}` : ""}`
    lines.push(panelRow(gitLine, innerWidth, fg))
  }

  if (longagentState.backgroundTaskId) {
    const bgLine = `bg=${longagentState.backgroundTaskStatus || "unknown"}  task=${longagentState.backgroundTaskId}  attempt=${longagentState.backgroundTaskAttempt || 0}`
    lines.push(panelRow(bgLine, innerWidth, fg))
  }

  if (longagentState.lastMessage) {
    const messageLine = `note=${clipPanelText(longagentState.lastMessage, innerWidth - 5)}`
    lines.push(panelRow(messageLine, innerWidth, muted))
  }

  if (longagentState.lastStageReport?.stageId) {
    const report = longagentState.lastStageReport
    const statusText = String(report.status || "-").toUpperCase()
    const reportColor = report.status === "pass" ? success : warn
    lines.push(panelRow("Last Stage", innerWidth, reportColor, { bold: true }))
    lines.push(panelRow(
      `${report.stageId} ${statusText} ${report.successCount || 0} ok / ${report.failCount || 0} fail`,
      innerWidth,
      fg
    ))
    const metaBits = []
    if (Number(report.retryCount || 0) > 0) metaBits.push(`retry=${report.retryCount}`)
    if (Number(report.fileChangesCount || 0) > 0) metaBits.push(`files=${report.fileChangesCount}`)
    if (Number(report.remainingFilesCount || 0) > 0) metaBits.push(`remaining=${report.remainingFilesCount}`)
    if (Number(report.totalCost || 0) > 0) metaBits.push(`cost=$${Number(report.totalCost).toFixed(4)}`)
    if (metaBits.length) lines.push(panelRow(metaBits.join("  "), innerWidth, muted))
  }

  const stageReports = Array.isArray(longagentState.stageReports) ? longagentState.stageReports : []
  if (stageReports.length > 1) {
    lines.push(panelRow("Recent Stages", innerWidth, success, { bold: true }))
    for (const report of stageReports.slice(-3).reverse()) {
      const text = [
        report.stageId || "-",
        String(report.status || "-").toUpperCase(),
        `${report.successCount || 0}/${(report.successCount || 0) + (report.failCount || 0)} ok`
      ].join("  ")
      lines.push(panelRow(text, innerWidth, report.status === "pass" ? fg : warn))
    }
  }

  if (Array.isArray(longagentState.remainingFiles) && longagentState.remainingFiles.length) {
    lines.push(panelRow("Remaining Files", innerWidth, warn, { bold: true }))
    for (const file of longagentState.remainingFiles.slice(0, 3)) {
      lines.push(panelRow(file, innerWidth, muted))
    }
  }

  if (Array.isArray(longagentState.recoverySuggestions) && longagentState.recoverySuggestions.length) {
    lines.push(panelRow("Recovery Hints", innerWidth, warn, { bold: true }))
    for (const suggestion of longagentState.recoverySuggestions.slice(0, 2)) {
      lines.push(panelRow(suggestion, innerWidth, warn))
    }
  }
  const recommended = recommendLongagentAction(longagentState)
  if (recommended) {
    lines.push(panelRow("Recommended Action", innerWidth, warn, { bold: true }))
    lines.push(panelRow(compactRecommendedCommand(recommended.command), innerWidth, warn))
    lines.push(panelRow(recommended.reason, innerWidth, muted))
  }

  const timeline = formatLongagentTimeline(longagentState, {
    maxItems: 4,
    textWidth: innerWidth
  })
  if (timeline.length) {
    lines.push(panelRow("Timeline", innerWidth, success, { bold: true }))
    for (const item of timeline) {
      lines.push(panelRow(item, innerWidth, muted))
    }
  }

  const checkpoints = Array.isArray(longagentState.checkpoints) ? longagentState.checkpoints : []
  if (checkpoints.length) {
    const recommendedCheckpointId = recommended?.command?.includes("--checkpoint ")
      ? String(recommended.command.split("--checkpoint ")[1] || "").trim()
      : ""
    lines.push(panelRow("Recent Checkpoints", innerWidth, success, { bold: true }))
    for (const checkpoint of checkpoints.slice(-3).reverse()) {
      const text = [
        checkpoint.phase || "-",
        checkpoint.kind || "checkpoint",
        checkpoint.id === recommendedCheckpointId ? "[recommended]" : null,
        clipPanelText(checkpoint.summary || "", Math.max(12, innerWidth - 18))
      ].filter(Boolean).join("  ")
      lines.push(panelRow(text, innerWidth, muted))
    }
  }

  const taskLines = formatPlanProgress(longagentState.taskProgress || {}).slice(1, 5)
  if (taskLines.length) {
    lines.push(panelRow("Tasks", innerWidth, success, { bold: true }))
    for (const taskLine of taskLines) {
      const plain = String(taskLine || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      lines.push(panelRow(plain, innerWidth))
    }
  }

  if (Array.isArray(longagentState.lastGateFailures) && longagentState.lastGateFailures.length) {
    lines.push(panelRow("Gate alerts", innerWidth, warn, { bold: true }))
    for (const failure of longagentState.lastGateFailures.slice(0, 3)) {
      lines.push(panelRow(failure, innerWidth, warn))
    }
  }

  lines.push(paint(`└${"─".repeat(innerWidth + 2)}┘`, border))
  return lines
}

export function renderFileChangesPanel(fileChanges = [], { width, theme, title = "Recent File Changes" } = {}) {
  if (!Array.isArray(fileChanges) || !fileChanges.length) return []
  const innerWidth = Math.max(16, (width || 80) - 4)
  const border = theme?.base?.border || "#666666"
  const fg = theme?.base?.fg || "white"
  const muted = theme?.base?.muted || "#999999"
  const success = theme?.semantic?.success || "green"

  const lines = []
  lines.push(paint(`┌${"─".repeat(innerWidth + 2)}┐`, border))
  lines.push(paint(`│ ${clipPanelText(title, innerWidth).padEnd(innerWidth)} │`, success, { bold: true }))

  for (const item of fileChanges.slice(0, 6)) {
    const path = clipPanelText(item.path || "", Math.max(12, innerWidth - 18))
    const add = Number(item.addedLines || 0)
    const del = Number(item.removedLines || 0)
    const scope = [item.stageId, item.taskId].filter(Boolean).join("/")
    const stats = `${add > 0 ? `+${add}` : "+0"} ${del > 0 ? `-${del}` : "-0"}`
    const line = scope
      ? `${path}  ${stats}  ${scope}`
      : `${path}  ${stats}`
    lines.push(panelRow(line, innerWidth, fg))
  }

  if (fileChanges.length > 6) {
    lines.push(panelRow(`... +${fileChanges.length - 6} more file(s)`, innerWidth, muted))
  }

  lines.push(paint(`└${"─".repeat(innerWidth + 2)}┘`, border))
  return lines
}

export function renderInspectorOverlay({
  mode = "agent",
  providerType = "-",
  model = "-",
  longagentState = null,
  providerSwitches = [],
  recoverableSessions = [],
  backgroundSummary = null,
  backgroundTasks = [],
  fileChanges = [],
  activityLines = [],
  width,
  theme
} = {}) {
  const overlayWidth = Math.max(48, Math.min(Number(width || 100) - 8, 96))
  const innerWidth = Math.max(44, overlayWidth - 4)
  const border = theme?.base?.border || "#666666"
  const fg = theme?.base?.fg || "white"
  const muted = theme?.base?.muted || "#999999"
  const info = theme?.semantic?.info || "cyan"
  const warn = theme?.semantic?.warn || "yellow"
  const success = theme?.semantic?.success || "green"

  const lines = []
  lines.push(paint(`┌${"─".repeat(innerWidth + 2)}┐`, border))
  lines.push(paint(`│ ${"Inspector".padEnd(innerWidth)} │`, info, { bold: true }))
  lines.push(panelRow(`mode=${mode}  provider=${providerType}  model=${model}`, innerWidth, fg))

  if (Array.isArray(providerSwitches) && providerSwitches.length) {
    lines.push(panelRow("Provider Timeline", innerWidth, info, { bold: true }))
    for (const item of providerSwitches.slice(0, 4)) {
      lines.push(panelRow(item, innerWidth, muted))
    }
  }

  if (Array.isArray(recoverableSessions) && recoverableSessions.length) {
    lines.push(panelRow("Recovery Center", innerWidth, info, { bold: true }))
    for (const item of recoverableSessions.slice(0, 3)) {
      lines.push(panelRow(
        `${item.id || "-"} ${item.status || "recoverable"} ${item.retryable ? "retry" : "resume"}`,
        innerWidth,
        muted
      ))
    }
  }

  if (longagentState) {
    const stage = longagentState.currentStageId || (Number.isFinite(longagentState.stageIndex) && Number.isFinite(longagentState.stageCount)
      ? `${longagentState.stageIndex + 1}/${longagentState.stageCount}`
      : "-")
    lines.push(panelRow("LongAgent", innerWidth, success, { bold: true }))
    lines.push(panelRow(
      `status=${longagentState.status || "-"}  phase=${longagentState.phase || "-"}  stage=${stage}`,
      innerWidth,
      fg
    ))
    lines.push(panelRow(
      `gate=${longagentState.currentGate || "-"}  remaining=${longagentState.remainingFilesCount ?? "-"}  recovery=${longagentState.recoveryCount || 0}`,
      innerWidth,
      muted
    ))
    if (longagentState.backgroundTaskId) {
      lines.push(panelRow(
        `background=${longagentState.backgroundTaskStatus || "unknown"}  task=${longagentState.backgroundTaskId}  attempt=${longagentState.backgroundTaskAttempt || 0}`,
        innerWidth,
        muted
      ))
    }
    if (longagentState.lastStageReport?.stageId) {
      const report = longagentState.lastStageReport
      lines.push(panelRow("Last Stage", innerWidth, success, { bold: true }))
      lines.push(panelRow(
        `${report.stageId} ${String(report.status || "-").toUpperCase()} ${report.successCount || 0} ok / ${report.failCount || 0} fail`,
        innerWidth,
        fg
      ))
    }
    const checkpoints = Array.isArray(longagentState.checkpoints) ? longagentState.checkpoints : []
    if (checkpoints.length) {
      lines.push(panelRow("Recent Checkpoints", innerWidth, info, { bold: true }))
      for (const checkpoint of checkpoints.slice(-3).reverse()) {
        lines.push(panelRow(
          `${checkpoint.phase || "-"} ${checkpoint.kind || "checkpoint"} ${checkpoint.summary || ""}`,
          innerWidth,
          muted
        ))
      }
    }
    const timeline = formatLongagentTimeline(longagentState, {
      maxItems: 4,
      textWidth: innerWidth
    })
    if (timeline.length) {
      lines.push(panelRow("Timeline", innerWidth, info, { bold: true }))
      for (const item of timeline) {
        lines.push(panelRow(item, innerWidth, muted))
      }
    }
  }

  if (Array.isArray(fileChanges) && fileChanges.length) {
    lines.push(panelRow("File Changes", innerWidth, info, { bold: true }))
    for (const item of fileChanges.slice(0, 8)) {
      const scope = [item.stageId, item.taskId].filter(Boolean).join("/")
      const text = scope
        ? `${item.path}  +${Number(item.addedLines || 0)} -${Number(item.removedLines || 0)}  ${scope}`
        : `${item.path}  +${Number(item.addedLines || 0)} -${Number(item.removedLines || 0)}`
      lines.push(panelRow(text, innerWidth, fg))
    }
  }

  if (Array.isArray(activityLines) && activityLines.length) {
    lines.push(panelRow("Recent Activity", innerWidth, info, { bold: true }))
    for (const line of activityLines.slice(-5)) {
      lines.push(panelRow(String(line || "").replace(/\s+/g, " ").trim(), innerWidth, fg))
    }
  }

  if (Array.isArray(longagentState?.recoverySuggestions) && longagentState.recoverySuggestions.length) {
    lines.push(panelRow("Recovery Hints", innerWidth, warn, { bold: true }))
    for (const suggestion of longagentState.recoverySuggestions.slice(0, 3)) {
      lines.push(panelRow(suggestion, innerWidth, warn))
    }
  }

  if (longagentState?.backgroundTaskId && ["interrupted", "error", "cancel_requested"].includes(longagentState.backgroundTaskStatus)) {
    lines.push(panelRow("Recovery Actions", innerWidth, warn, { bold: true }))
    lines.push(panelRow(`kkcode longagent recover --session ${longagentState.sessionId || "<session>"}`, innerWidth, warn))
    lines.push(panelRow(`kkcode longagent task --session ${longagentState.sessionId || "<session>"}`, innerWidth, muted))
  }

  if (backgroundSummary) {
    lines.push(panelRow("Background Tasks", innerWidth, info, { bold: true }))
    lines.push(panelRow(
      `total=${backgroundSummary.total || 0} running=${backgroundSummary.running || 0} pending=${backgroundSummary.pending || 0} interrupted=${backgroundSummary.interrupted || 0} error=${backgroundSummary.error || 0}`,
      innerWidth,
      fg
    ))
    lines.push(panelRow(
      `longagent=${backgroundSummary.longagent || 0} recovery=${backgroundSummary.recovery || 0} completed=${backgroundSummary.completed || 0}`,
      innerWidth,
      muted
    ))
    for (const task of Array.isArray(backgroundTasks) ? backgroundTasks.slice(0, 3) : []) {
      lines.push(panelRow(
        `${task.id || "-"} ${task.label || task.status || "-"} ${task.status || "-"}${task.sessionId ? ` session=${task.sessionId}` : ""}`,
        innerWidth,
        fg
      ))
    }
  }

  lines.push(panelRow("Esc close  Ctrl+I toggle", innerWidth, muted))
  lines.push(paint(`└${"─".repeat(innerWidth + 2)}┘`, border))
  return lines
}
