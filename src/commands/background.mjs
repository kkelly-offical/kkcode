import { Command } from "commander"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { buildContext, printContextWarnings } from "../context.mjs"

async function withContext(action) {
  const ctx = await buildContext()
  printContextWarnings(ctx)
  await BackgroundManager.tick(ctx.configState.config)
  return action(ctx)
}

function printTaskSummary(task) {
  const summary = BackgroundManager.summarize(task)
  if (!summary) return
  console.log(`[${summary.status}] ${summary.id} :: ${summary.description}`)
  console.log(`  attempt=${summary.attempt} subagent=${summary.subagent || "-"} execution_mode=${summary.execution_mode || "-"} session=${summary.session_id || "-"}`)
  if (summary.interruption_reason) {
    console.log(`  interruption=${summary.interruption_reason}`)
  }
  if (summary.result_preview) {
    console.log(`  preview=${summary.result_preview}`)
  }
  console.log(`  next=${summary.next_action}`)
}

export function createBackgroundCommand() {
  const cmd = new Command("background").description("inspect background delegated tasks")

  cmd
    .command("list")
    .description("list background tasks")
    .option("--json", "print raw JSON")
    .action(async (options) => {
      await withContext(async () => {
        const list = await BackgroundManager.list()
        if (options.json) {
          console.log(JSON.stringify(list, null, 2))
          return
        }
        const aggregate = BackgroundManager.summarizeList(list)
        console.log(`summary: total=${aggregate.total} active=${aggregate.active} pending=${aggregate.counts.pending} running=${aggregate.counts.running} completed=${aggregate.counts.completed} interrupted=${aggregate.counts.interrupted} error=${aggregate.counts.error}`)
        if (aggregate.recent_terminal.length) {
          console.log(`recent terminal: ${aggregate.recent_terminal.map((item) => `${item.id}:${item.status}`).join(" | ")}`)
        }
        if (!list.length) {
          console.log("no background tasks")
          return
        }
        for (const task of list) {
          printTaskSummary(task)
        }
      })
    })

  cmd
    .command("show")
    .description("show one background task")
    .requiredOption("--id <id>", "task id")
    .option("--json", "print raw JSON")
    .action(async (options) => {
      await withContext(async () => {
        const task = await BackgroundManager.get(options.id)
        if (!task) {
          console.error(`not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        if (options.json) {
          console.log(JSON.stringify(task, null, 2))
          return
        }
        printTaskSummary(task)
        const summary = BackgroundManager.summarize(task)
        if (summary?.log_tail?.length) {
          console.log("  log tail:")
          for (const line of summary.log_tail) {
            console.log(`    ${line}`)
          }
        }
        if (task.result) {
          console.log("  result:")
          console.log(JSON.stringify(task.result, null, 2))
        }
      })
    })

  cmd
    .command("cancel")
    .description("cancel one background task")
    .requiredOption("--id <id>", "task id")
    .action(async (options) => {
      await withContext(async () => {
        const ok = await BackgroundManager.cancel(options.id)
        if (!ok) {
          console.error(`not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        console.log(`cancel requested: ${options.id}`)
      })
    })

  cmd
    .command("retry")
    .description("retry one interrupted/error background task")
    .requiredOption("--id <id>", "task id")
    .action(async (options) => {
      await withContext(async (ctx) => {
        const task = await BackgroundManager.retry(options.id, ctx.configState.config)
        if (!task) {
          console.error(`task not retryable or not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        console.log(`retry queued: ${task.id} (attempt=${task.attempt})`)
      })
    })

  cmd
    .command("clean")
    .description("remove old completed/cancelled/error/interrupted tasks")
    .option("--max-age <days>", "max age in days", "7")
    .action(async (options) => {
      await withContext(async () => {
        const maxAge = Number(options.maxAge || 7) * 24 * 60 * 60 * 1000
        const removed = await BackgroundManager.clean({ maxAge })
        console.log(`removed ${removed.length} task(s)`)
      })
    })

  return cmd
}
