import { paint } from "../theme/color.mjs"

export function formatRuntimeStateText(state, mcpSummary = null, skillSummary = null, backgroundSummary = null) {
  const lines = [
    `session=${state.sessionId}`,
    `mode=${state.mode}`,
    `provider=${state.providerType}`,
    `model=${state.model}`
  ]
  if (state.mode === "longagent" && state.longagentImpl) {
    lines.push(`longagent.impl=${state.longagentImpl}`)
  }
  if (mcpSummary) {
    lines.push(`mcp=${mcpSummary.healthy}/${mcpSummary.configured} healthy, ${mcpSummary.tools} tools`)
    if (mcpSummary.configured === 0) {
      lines.push("mcp.quickstart=kkcode mcp init --project")
    }
  }
  if (skillSummary) {
    const mdCount = skillSummary.template + skillSummary.skillMd
    lines.push(`skills=${skillSummary.total} loaded (md:${mdCount}, mcp:${skillSummary.mcpPrompt}, mjs:${skillSummary.programmable})`)
    if (skillSummary.total === 0) {
      lines.push("skills.quickstart=kkcode skill init --project")
    }
  }
  if (backgroundSummary) {
    lines.push(`background=${backgroundSummary.active} active (pending:${backgroundSummary.counts.pending}, running:${backgroundSummary.counts.running})`)
    lines.push(`background.terminal=completed:${backgroundSummary.counts.completed} interrupted:${backgroundSummary.counts.interrupted} error:${backgroundSummary.counts.error}`)
  }
  return lines.join("\n")
}

export function normalizeFileChanges(toolEvents = []) {
  const rows = []
  for (const event of toolEvents || []) {
    if (!event || !["write", "edit"].includes(event.name)) continue
    const changes = Array.isArray(event?.metadata?.fileChanges) ? event.metadata.fileChanges : []
    for (const item of changes) {
      const path = String(item?.path || event.args?.path || "").trim()
      if (!path) continue
      rows.push({
        path,
        addedLines: Number(item?.addedLines || 0),
        removedLines: Number(item?.removedLines || 0),
        stageId: item?.stageId ? String(item.stageId) : "",
        taskId: item?.taskId ? String(item.taskId) : ""
      })
    }
  }

  const grouped = new Map()
  for (const row of rows) {
    const key = `${row.path}::${row.stageId}::${row.taskId}`
    const prev = grouped.get(key) || {
      path: row.path,
      addedLines: 0,
      removedLines: 0,
      stageId: row.stageId,
      taskId: row.taskId
    }
    prev.addedLines += row.addedLines
    prev.removedLines += row.removedLines
    grouped.set(key, prev)
  }
  return [...grouped.values()]
}

export function renderFileChangeLines(fileChanges = [], limit = 20) {
  const lines = []
  const rows = fileChanges.slice(0, limit)
  for (const item of rows) {
    const scope = [item.stageId, item.taskId].filter(Boolean).join("/")
    const suffix = scope ? paint(` (${scope})`, null, { dim: true }) : ""
    const add = item.addedLines > 0
      ? paint(`+${item.addedLines}`, "#00ff00", { bold: true })
      : paint("+0", null, { dim: true })
    const del = item.removedLines > 0
      ? paint(`-${item.removedLines}`, "#ff4444", { bold: true })
      : paint("-0", null, { dim: true })
    lines.push(`  ${paint(item.path, "white")}  ${add} ${del}${suffix}`)
  }
  if (fileChanges.length > rows.length) {
    lines.push(paint(`  ... +${fileChanges.length - rows.length} more file(s)`, null, { dim: true }))
  }
  return lines
}

export function normalizeDiagnostics(toolEvents = []) {
  const summaries = []
  for (const event of toolEvents || []) {
    const diagnostics = event?.metadata?.diagnostics
    if (!diagnostics) continue
    const summary = diagnostics.summary || {}
    const currentSummary = diagnostics.after?.summary || diagnostics.current?.summary || {}
    const delta = diagnostics.delta || {}
    summaries.push({
      tool: String(event?.name || ""),
      path: String(event?.args?.path || diagnostics.current?.diagnostics?.[0]?.file || diagnostics.baseline?.diagnostics?.[0]?.file || "").trim(),
      introduced: Number(summary.introduced || delta.added?.length || 0),
      persistent: Number(summary.persistent || delta.persisted?.length || 0),
      resolved: Number(summary.resolved || delta.resolved?.length || 0),
      unchanged: Boolean(summary.unchanged || delta.unchanged),
      errorCount: Number(currentSummary.errorCount || currentSummary.errors || 0),
      warningCount: Number(currentSummary.warningCount || currentSummary.warnings || 0),
      status: String(summary.status || diagnostics.after?.status || diagnostics.current?.status || diagnostics.status || "")
    })
  }
  return summaries
}

export function renderDiagnosticsLines(rows = [], limit = 10) {
  const lines = []
  const visible = rows.slice(0, limit)
  for (const item of visible) {
    const label = item.path || item.tool || "diagnostics"
    const summary = item.unchanged
      ? "no change"
      : `+${item.introduced} / ${item.persistent} / -${item.resolved}`
    const totals = `${item.errorCount} error(s), ${item.warningCount} warning(s)`
    const status = item.status ? paint(` ${item.status}`, null, { dim: true }) : ""
    lines.push(`  ${paint(label, "white")}  ${paint(summary, "yellow", { bold: true })}  ${paint(totals, null, { dim: true })}${status}`)
  }
  if (rows.length > visible.length) {
    lines.push(paint(`  ... +${rows.length - visible.length} more diagnostics result(s)`, null, { dim: true }))
  }
  return lines
}
