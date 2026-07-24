import { Command } from "commander"
import {
  exportAuditEntries,
  listAuditEntries,
  verifyAuditChain
} from "../storage/audit-store.mjs"

function parseSinceToTimestamp(value) {
  if (!value) return null
  const raw = String(value).trim().toLowerCase()
  if (!raw) return null

  if (/^\d+$/.test(raw)) {
    const asNumber = Number(raw)
    if (asNumber > 10_000_000_000) return asNumber
    return Date.now() - asNumber
  }

  const matched = raw.match(/^(\d+)([smhd])$/)
  if (matched) {
    const amount = Number(matched[1])
    const unit = matched[2]
    const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
    return Date.now() - amount * mult
  }

  const parsed = Date.parse(raw)
  if (!Number.isNaN(parsed)) return parsed
  return null
}

export function createAuditCommand() {
  const cmd = new Command("audit").description("query audit trail entries")

  cmd
    .command("list")
    .description("list audit entries")
    .option("--session <id>", "filter by session id")
    .option("--tool <name>", "filter by tool name")
    .option("--type <event>", "filter by audit type")
    .option("--trace <id>", "filter by trace id")
    .option("--provider <name>", "filter by provider")
    .option("--review <id>", "filter by review id")
    .option("--status <status>", "filter by status")
    .option("--since <window>", "time filter: 2h | 30m | epoch_ms | ISO datetime")
    .option("--limit <n>", "max returned rows", "100")
    .option("--json", "print JSON output", false)
    .action(async (options) => {
      const sinceMs = parseSinceToTimestamp(options.since || null)
      if (options.since && !sinceMs) {
        console.error(`invalid --since value: ${options.since}`)
        process.exitCode = 1
        return
      }

      const entries = await listAuditEntries({
        sessionId: options.session || null,
        tool: options.tool || null,
        type: options.type || null,
        traceId: options.trace || null,
        provider: options.provider || null,
        reviewId: options.review || null,
        status: options.status || null,
        sinceMs,
        limit: Number(options.limit || 100)
      })

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2))
        return
      }

      if (!entries.length) {
        console.log("no audit entries found")
        return
      }

      for (const entry of entries) {
        const time = new Date(entry.createdAt).toISOString()
        const session = entry.sessionId || "-"
        const tool = entry.tool || "-"
        const type = entry.type || "-"
        const status = entry.status || (entry.ok === false ? "error" : "ok")
        console.log(`${time}  ${type}  session=${session}  tool=${tool}  status=${status}`)
      }
    })

  cmd
    .command("verify")
    .description("verify the append-only audit hash chain")
    .option("--json", "print JSON output", false)
    .action(async (options) => {
      const result = await verifyAuditChain()
      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
      } else if (result.ok) {
        console.log(`audit chain verified: ${result.entries} chained, ${result.legacyEntries} legacy`)
        if (result.headHash) console.log(`head=${result.headHash}`)
      } else {
        console.error(`audit chain verification failed: ${result.errors.length} error(s)`)
        for (const error of result.errors) {
          console.error(`- ${error.eventId || `${error.file}:${error.line}`}: ${error.error}`)
        }
      }
      if (!result.ok) process.exitCode = 1
    })

  cmd
    .command("export")
    .description("export redacted audit entries")
    .option("--format <format>", "json | jsonl", "json")
    .option("--trace <id>", "filter by trace id")
    .option("--provider <name>", "filter by provider")
    .option("--review <id>", "filter by review id")
    .option("--status <status>", "filter by status")
    .option("--limit <n>", "max returned rows", "5000")
    .action(async (options) => {
      const format = String(options.format || "json").toLowerCase()
      if (!["json", "jsonl"].includes(format)) {
        console.error(`unsupported audit export format: ${format}`)
        process.exitCode = 1
        return
      }
      const output = await exportAuditEntries({
        format,
        traceId: options.trace || null,
        provider: options.provider || null,
        reviewId: options.review || null,
        status: options.status || null,
        limit: Number(options.limit || 5000)
      })
      process.stdout.write(output)
    })

  return cmd
}
