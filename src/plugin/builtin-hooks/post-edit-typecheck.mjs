// Post-edit diagnostics + observability hook
// Captures baseline diagnostics before mutation tools and appends a concise
// post-edit diagnostics delta plus mutation summary after mutation tools run.

import {
  buildEditDiagnosticsReport,
  buildMutationObservability,
  collectDiagnosticsSnapshot,
  extractTouchedFiles,
  isDiagnosticsEligibleFile,
  isMutationTool
} from "../../observability/edit-diagnostics.mjs"

function normalizeToolName(payload = {}) {
  return String(payload.toolName || payload.tool || "").trim()
}

function isCompletedResult(result) {
  if (!result || typeof result !== "object") return true
  return !result.status || result.status === "completed"
}

function appendFeedback(result, reportText) {
  if (!reportText) return result
  if (typeof result === "string") return `${result}\n${reportText}`.trim()
  if (result && typeof result === "object") {
    return {
      ...result,
      output: `${String(result.output || "")}\n${reportText}`.trim()
    }
  }
  return result
}

function buildReportText({ observability, diagnostics }) {
  const lines = []
  if (observability?.changes?.length) {
    lines.push("Mutation summary:")
    lines.push(`- ${observability.summary}`)
  }
  if (diagnostics?.summary?.text) {
    lines.push("Diagnostics:")
    lines.push(`- ${diagnostics.summary.text}`)
    for (const issue of (diagnostics.delta?.added || []).slice(0, 2)) {
      lines.push(`- introduced ${issue.file || "unknown"} ${issue.code || ""} ${issue.message || ""}`.trim())
    }
    for (const issue of (diagnostics.delta?.resolved || []).slice(0, 2)) {
      lines.push(`- resolved ${issue.file || "unknown"} ${issue.code || ""} ${issue.message || ""}`.trim())
    }
  }
  return lines.join("\n")
}

export default {
  name: "post-edit-typecheck",
  tool: {
    async before(payload) {
      const toolName = normalizeToolName(payload)
      if (!isMutationTool(toolName)) return payload

      const cwd = payload.cwd || process.cwd()
      const files = extractTouchedFiles({ args: payload.args }).filter(isDiagnosticsEligibleFile)
      if (files.length === 0) return payload

      const baseline = await collectDiagnosticsSnapshot({ cwd, files }).catch(() => null)
      return {
        ...payload,
        _editObservability: {
          files,
          baseline
        }
      }
    },

    async after(payload) {
      const toolName = normalizeToolName(payload)
      if (!isMutationTool(toolName)) return payload
      if (!isCompletedResult(payload.result)) return payload

      const cwd = payload.cwd || process.cwd()
      const metadata = payload.result && typeof payload.result === "object" && payload.result.metadata && typeof payload.result.metadata === "object"
        ? { ...payload.result.metadata }
        : {}
      const files = (payload._editObservability?.files || extractTouchedFiles({ args: payload.args, metadata }))
        .filter(isDiagnosticsEligibleFile)

      const observability = buildMutationObservability(metadata)
      let diagnostics = null

      if (files.length > 0) {
        const current = await collectDiagnosticsSnapshot({ cwd, files }).catch(() => null)
        diagnostics = buildEditDiagnosticsReport({
          cwd,
          files,
          baseline: payload._editObservability?.baseline || {},
          current: current || {},
          reason: current ? "" : "snapshot_failed"
        })
      }

      if (!observability.changes.length && !diagnostics) {
        return payload
      }

      const reportText = buildReportText({ observability, diagnostics })
      let nextResult = appendFeedback(payload.result, reportText)

      if (nextResult && typeof nextResult === "object") {
        nextResult = {
          ...nextResult,
          metadata: {
            ...metadata,
            observability,
            ...(diagnostics ? { diagnostics } : {})
          }
        }
      }

      return {
        ...payload,
        result: nextResult
      }
    }
  }
}
