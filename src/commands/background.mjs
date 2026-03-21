import { Command } from "commander"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { buildContext, printContextWarnings } from "../context.mjs"

const NODE_MAJOR = Number.parseInt(String(process.versions?.node || process.version || "").replace(/^v/, "").split(".")[0] || "", 10)

function printNode25RuntimeHint() {
  if (!(Number.isFinite(NODE_MAJOR) && NODE_MAJOR >= 25)) return
  console.log(`runtime note: Node ${process.versions.node} has a known worker lifecycle edge case; background tasks now self-heal better, but Node 22 remains the stable baseline for longagent/background workers.`)
}

function classifyTaskLabel(task) {
  const workerType = task?.payload?.workerType || ""
  if (workerType === "longagent_session") return "longagent"
  if (workerType === "delegate_task") return "delegate"
  if (String(task?.description || "").toLowerCase().includes("recover")) return "recovery"
  return "task"
}

function formatTaskSummary(task) {
  const label = classifyTaskLabel(task)
  const session = task?.payload?.longagentSessionId || task?.payload?.sessionId || "-"
  const target = task?.payload?.providerType && task?.payload?.model
    ? `${task.payload.providerType}::${task.payload.model}`
    : "-"
  return [
    task.id,
    label,
    task.status || "unknown",
    `attempt=${task.attempt || 1}`,
    session !== "-" ? `session=${session}` : null,
    target !== "-" ? `target=${target}` : null,
    task.error ? `error=${String(task.error).slice(0, 80)}` : null
  ].filter(Boolean).join("\t")
}

function summarizeTasks(tasks) {
  const summary = {
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    error: 0,
    interrupted: 0,
    cancelled: 0,
    longagent: 0,
    recovery: 0
  }
  for (const task of tasks) {
    if (summary[task.status] !== undefined) summary[task.status] += 1
    const label = classifyTaskLabel(task)
    if (label === "longagent") summary.longagent += 1
    if (label === "recovery") summary.recovery += 1
  }
  return summary
}

async function withContext(action) {
  const ctx = await buildContext()
  printContextWarnings(ctx)
  printNode25RuntimeHint()
  await BackgroundManager.tick(ctx.configState.config)
  return action(ctx)
}

export function createBackgroundCommand() {
  const cmd = new Command("background").description("inspect background delegated tasks")

  cmd
    .command("list")
    .description("list background tasks")
    .option("--json", "output raw json", false)
    .action(async (options) => {
      await withContext(async () => {
        const list = await BackgroundManager.list()
        if (options.json) {
          console.log(JSON.stringify(list, null, 2))
          return
        }
        if (!list.length) {
          console.log("no background tasks")
          return
        }
        for (const line of list.map(formatTaskSummary)) console.log(line)
      })
    })

  cmd
    .command("center")
    .description("show a compact task-center style summary")
    .option("--json", "output structured json", false)
    .action(async (options) => {
      await withContext(async () => {
        const tasks = await BackgroundManager.list()
        const summary = summarizeTasks(tasks)
        if (options.json) {
          console.log(JSON.stringify({
            summary,
            tasks
          }, null, 2))
          return
        }
        console.log(`tasks: total=${summary.total} running=${summary.running} pending=${summary.pending} interrupted=${summary.interrupted} error=${summary.error} completed=${summary.completed}`)
        console.log(`kinds: longagent=${summary.longagent} recovery=${summary.recovery}`)
        if (!tasks.length) return
        console.log("recent:")
        for (const line of tasks.slice(0, 8).map(formatTaskSummary)) {
          console.log(`  ${line}`)
        }
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
