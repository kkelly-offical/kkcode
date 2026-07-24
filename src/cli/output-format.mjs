export const OUTPUT_FORMATS = Object.freeze(["text", "json", "stream-json", "legacy"])
export const OUTPUT_SCHEMA_VERSION = "1"

export function resolveOutputFormat(requested, { stdoutIsTTY = process.stdout.isTTY } = {}) {
  const normalized = String(requested || "").trim().toLowerCase()
  if (normalized) {
    if (!OUTPUT_FORMATS.includes(normalized)) {
      throw new Error(`invalid output format "${requested}"; expected ${OUTPUT_FORMATS.join("|")}`)
    }
    return normalized
  }
  return stdoutIsTTY ? "legacy" : "text"
}

export function createOutputReporter(format, {
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const writeLine = (stream, value = "") => stream.write(`${String(value)}\n`)
  return {
    format,
    progress(message) {
      if (format === "legacy") writeLine(stdout, message)
      else if (message) writeLine(stderr, message)
    },
    warning(message) {
      if (message) writeLine(stderr, message)
    },
    delta(content) {
      if (!content) return
      if (format === "legacy") stdout.write(String(content))
      if (format === "stream-json") {
        writeLine(stdout, JSON.stringify({
          schemaVersion: OUTPUT_SCHEMA_VERSION,
          type: "assistant.delta",
          delta: String(content)
        }))
      }
    },
    finish(result) {
      const record = toPublicResult(result)
      if (format === "json") {
        writeLine(stdout, JSON.stringify(record))
      } else if (format === "stream-json") {
        writeLine(stdout, JSON.stringify({ ...record, type: "turn.result" }))
      } else if (format === "text") {
        writeLine(stdout, record.content)
      }
      return record
    }
  }
}

export function toPublicResult(result = {}) {
  const turnUsage = result.tokenMeter?.turn || result.usage || {}
  const status = result.budgetExceeded
    ? "blocked"
    : result.longagent?.status || (result.error ? "failed" : "succeeded")
  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    sessionId: result.sessionId || null,
    turnId: result.turnId || null,
    status,
    mode: result.mode || null,
    model: result.model || null,
    content: String(result.reply || ""),
    usage: {
      input: Number(turnUsage.input || 0),
      output: Number(turnUsage.output || 0),
      estimated: Boolean(result.tokenMeter?.estimated)
    },
    cost: Number(result.cost || 0),
    toolResults: Array.isArray(result.toolEvents) ? result.toolEvents : [],
    warnings: [
      ...(result.pricingWarnings || []),
      ...(result.budgetWarnings || [])
    ],
    error: result.error || null
  }
}
