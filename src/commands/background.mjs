import { Command } from "commander"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { buildContext, printContextWarnings } from "../context.mjs"

async function withContext(action) {
  const ctx = await buildContext()
  printContextWarnings(ctx)
  await BackgroundManager.tick(ctx.configState.config)
  return action(ctx)
}

export function createBackgroundCommand() {
  const cmd = new Command("background").description("inspect background delegated tasks")

  cmd
    .command("list")
    .description("list background tasks")
    .action(async () => {
      await withContext(async () => {
        const list = await BackgroundManager.list()
        console.log(JSON.stringify(list, null, 2))
      })
    })

  cmd
    .command("show")
    .description("show one background task")
    .requiredOption("--id <id>", "task id")
    .action(async (options) => {
      await withContext(async () => {
        const task = await BackgroundManager.get(options.id)
        if (!task) {
          console.error(`not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        console.log(JSON.stringify(task, null, 2))
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
