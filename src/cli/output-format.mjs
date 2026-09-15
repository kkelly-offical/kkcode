export const OUTPUT_FORMATS = Object.freeze(["text", "json", "stream-json", "legacy"])
export const OUTPUT_SCHEMA_VERSION = "1"

/**
 * Headless JSONL 机器契约的事件类型表（1.0.0 阶段 5）—— 契约面的单一事实源，
 * 说明文档见 docs/headless-jsonl-contract.md（对照 Codex exec 契约，M1 §2.4）。
 *
 * `--output-format json` / `stream-json` 时 stdout 上每一行是一个事件：
 * 恰好一行 JSON（可 JSON.parse）、以 \n 结尾、带 schemaVersion 与 type，
 * 且 type 必在本表。进度/诊断/警告/审批提示一律走 stderr，绝不落在 stdout。
 *
 * stability 标记（对照 K2「事件面标 experimental 争取演进空间」）：
 *   - stable：字段名与语义在 schemaVersion "1" 内只做兼容追加（只加字段不改语义）
 *   - experimental：payload 形状可在次版本演进，消费方须容忍未知字段
 */
export const HEADLESS_JSONL_EVENTS = Object.freeze({
  "turn.result": Object.freeze({
    stability: "stable",
    summary: "回合终态结果。json 格式的唯一一行；stream-json 格式的最后一行。" +
      "status 取值：succeeded / failed（provider 级失败：error 带错误消息、进程退出码非零）/ " +
      "blocked（预算阻断）/ longagent 终态；失败语义自 1.0.0 起为 stable 契约。"
  }),
  "assistant.delta": Object.freeze({
    stability: "experimental",
    summary: "助手正文的增量片段（仅 stream-json）。按到达顺序拼接 delta 即得 turn.result.content。"
  })
})

/** 契约事件类型清单（e2e 断言与文档同步校验共用） */
export const HEADLESS_JSONL_EVENT_TYPES = Object.freeze(Object.keys(HEADLESS_JSONL_EVENTS))

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
      // json 与 stream-json 共用一个终态事件形状：一行一事件、带 type ——
      // stdout 上不存在无类型的「裸结果」行（阶段 5 前 json 格式没有 type 字段，
      // 属契约面的兼容追加：JSON 消费方按字段读取不受影响）。
      if (format === "json" || format === "stream-json") {
        writeLine(stdout, JSON.stringify({ type: "turn.result", ...record }))
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
