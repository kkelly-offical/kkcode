import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Command } from "commander"
import { exportUsageCsv, readUsageStore, resetUsage } from "../usage/usage-meter.mjs"
import { buildContext } from "../context.mjs"

function printUsageLine(scope, usage) {
  console.log(
    `${scope.padEnd(12)} input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} cost=$${usage.cost.toFixed(4)} turns=${usage.turns}`
  )
}

export function createUsageCommand() {
  const cmd = new Command("usage").description("inspect and manage token/cost usage")

  cmd
    .command("show")
    .description("show usage summary")
    .option("--session <id>", "show only one session")
    .option("--json", "print as JSON", false)
    .action(async (options) => {
      const store = await readUsageStore()
      const ctx = await buildContext().catch(() => null)
      const budget = ctx?.configState?.config?.usage?.budget || {}
      if (options.json) {
        if (options.session) {
          console.log(JSON.stringify(store.sessions[options.session] ?? null, null, 2))
          return
        }
        console.log(JSON.stringify(store, null, 2))
        return
      }
      printUsageLine("global", store.global)
      if (budget.global_usd) {
        const ratio = (store.global.cost / budget.global_usd) * 100
        console.log(`global budget: $${store.global.cost.toFixed(4)} / $${budget.global_usd} (${ratio.toFixed(1)}%)`)
      }
      if (options.session) {
        const session = store.sessions[options.session]
        if (!session) {
          console.error(`session not found: ${options.session}`)
          process.exitCode = 1
          return
        }
        printUsageLine(`session:${options.session}`, session)
        if (budget.session_usd) {
          const ratio = (session.cost / budget.session_usd) * 100
          console.log(`session budget: $${session.cost.toFixed(4)} / $${budget.session_usd} (${ratio.toFixed(1)}%)`)
        }
        return
      }
      for (const [sessionId, usage] of Object.entries(store.sessions)) {
        printUsageLine(`session:${sessionId}`, usage)
      }
    })

  cmd
    .command("reset")
    .description("reset usage counters")
    .option("--session <id>", "reset only one session")
    .action(async (options) => {
      await resetUsage(options.session ?? null)
      console.log(options.session ? `usage reset: ${options.session}` : "usage reset: all")
    })

  cmd
    .command("export")
    .description("export usage as json or csv")
    .option("--format <format>", "json|csv", "json")
    .option("--out <file>", "output file path")
    .action(async (options) => {
      const format = String(options.format).toLowerCase()
      const outFile = path.resolve(options.out ?? `usage-export.${format}`)
      if (format === "json") {
        const store = await readUsageStore()
        await writeFile(outFile, JSON.stringify(store, null, 2) + "\n", "utf8")
        console.log(`usage exported: ${outFile}`)
        return
      }
      if (format === "csv") {
        const csv = await exportUsageCsv()
        await writeFile(outFile, csv, "utf8")
        console.log(`usage exported: ${outFile}`)
        return
      }
      console.error("unsupported format, expected json or csv")
      process.exitCode = 1
    })

  return cmd
}
