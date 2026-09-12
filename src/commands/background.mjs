import { Command } from "commander"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { applyWorktreeResult, discardWorktreeResult } from "../orchestration/worktree-handoff.mjs"
import { printContextWarnings } from "../context.mjs"
import { createKernel } from "../kernel/index.mjs"
import { loadTheme } from "../theme/load-theme.mjs"

async function withContext(action) {
  // boot:false —— background 巡检只读 checkpoint 文件，不拉起扩展
  const kernel = await createKernel({ cwd: process.cwd(), boot: false })
  const themeState = await loadTheme(kernel.configState)
  printContextWarnings({ configState: kernel.configState, themeState })
  await BackgroundManager.tick(kernel.configState.config)
  return action(kernel)
}

function printTaskSummary(task) {
  const summary = BackgroundManager.summarize(task)
  if (!summary) return
  console.log(`[${summary.status}] ${summary.id} :: ${summary.description}`)
  console.log(`  attempt=${summary.attempt} subagent=${summary.subagent || "-"} execution_mode=${summary.execution_mode || "-"} session=${summary.session_id || "-"}`)
  if (summary.group_id) {
    console.log(`  group=${summary.group_id} label=${summary.group_label || "-"}`)
  }
  if (summary.interruption_reason) {
    console.log(`  interruption=${summary.interruption_reason}`)
  }
  if (summary.worktree_preserved && summary.worktree_path) {
    console.log(`  worktree=${summary.worktree_path} (preserved — changes NOT in workspace)`)
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
    .option("--status <status>", "filter by status")
    .action(async (options) => {
      await withContext(async () => {
        const list = (await BackgroundManager.list()).filter((task) => {
          if (!options.status) return true
          return String(task.status || "") === String(options.status || "")
        })
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
    .command("parallel")
    .description("show delegated background tasks grouped as parallel subagent lanes")
    .option("--json", "print raw JSON")
    .action(async (options) => {
      await withContext(async () => {
        const groups = BackgroundManager.summarizeParallel(await BackgroundManager.list())
        if (options.json) {
          console.log(JSON.stringify(groups, null, 2))
          return
        }
        if (groups.length === 0) {
          console.log("no parallel subagent groups")
          return
        }
        for (const group of groups) {
          console.log("[group] " + group.group_id + " :: " + group.group_label + " total=" + group.total + " active=" + group.active)
          for (const lane of group.lanes) {
            console.log("  [" + lane.status + "] " + lane.id + " subagent=" + (lane.subagent || "-") + " task=" + (lane.logical_task_id || "-") + " session=" + (lane.session_id || "-"))
            if (lane.result_preview) console.log("    preview=" + lane.result_preview)
          }
        }
      })
    })

  cmd
    .command("output")
    .description("print the terminal result payload for one background task")
    .requiredOption("--id <id>", "task id")
    .action(async (options) => {
      await withContext(async () => {
        const task = await BackgroundManager.get(options.id)
        if (!task) {
          console.error(`not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        if (!task.result) {
          console.log(JSON.stringify(BackgroundManager.summarize(task), null, 2))
          return
        }
        console.log(JSON.stringify(task.result, null, 2))
      })
    })

  cmd
    .command("wait")
    .description("wait for one background task to reach a terminal state")
    .requiredOption("--id <id>", "task id")
    .option("--timeout <ms>", "wait timeout in milliseconds", "30000")
    .option("--json", "print raw JSON")
    .action(async (options) => {
      await withContext(async (kernel) => {
        const task = await BackgroundManager.waitForTask(options.id, {
          timeoutMs: Number(options.timeout || 30000),
          config: kernel.configState.config
        })
        if (!task) {
          console.error(`not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        if (!["completed", "cancelled", "error", "interrupted"].includes(task.status)) {
          console.error(`timeout waiting for task: ${options.id} (status=${task.status})`)
          process.exitCode = 1
          return
        }
        if (options.json) {
          console.log(JSON.stringify(task, null, 2))
          return
        }
        printTaskSummary(task)
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
    .command("logs")
    .description("show recent log lines for one background task")
    .requiredOption("--id <id>", "task id")
    .option("--tail <n>", "number of lines to show", "20")
    .action(async (options) => {
      await withContext(async () => {
        const task = await BackgroundManager.get(options.id)
        if (!task) {
          console.error(`not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        const tailCount = Math.max(1, Number(options.tail || 20))
        const lines = Array.isArray(task.logs) ? task.logs.slice(-tailCount) : []
        if (!lines.length) {
          console.log(`no logs yet: ${options.id}`)
          return
        }
        for (const line of lines) {
          console.log(line)
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
    .command("stop")
    .description("alias for cancel")
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
      await withContext(async (kernel) => {
        const task = await BackgroundManager.retry(options.id, kernel.configState.config)
        if (!task) {
          console.error(`task not retryable or not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        console.log(`retry queued: ${task.id} (attempt=${task.attempt})`)
      })
    })

  cmd
    .command("apply")
    .description("apply a preserved worktree's changes back into the main checkout")
    .requiredOption("--id <id>", "task id")
    .option("--dry-run", "check applicability without modifying any file")
    .option("--force", "apply even when the main checkout has overlapping uncommitted changes")
    .option("--3way", "allow git apply --3way fallback (may leave conflict markers)")
    .option("--keep-worktree", "keep the worktree after a successful apply")
    .option("--json", "print raw JSON")
    .action(async (options) => {
      await withContext(async () => {
        const task = await BackgroundManager.get(options.id)
        if (!task) {
          console.error(`not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        const outcome = await applyWorktreeResult(task, {
          threeway: Boolean(options["3way"]),
          force: Boolean(options.force),
          keepWorktree: Boolean(options.keepWorktree),
          dryRun: Boolean(options.dryRun)
        })
        if (options.json) {
          console.log(JSON.stringify(outcome, null, 2))
          if (!outcome.ok) process.exitCode = 1
          return
        }
        if (outcome.dryRun) {
          if (outcome.empty) {
            console.log("dry-run: worktree has no changes to apply")
          } else {
            console.log(`dry-run: patch applies cleanly (${outcome.files.length} file(s))`)
            for (const file of outcome.files) console.log(`  ${file}`)
          }
          return
        }
        if (!outcome.ok) {
          console.error(`apply failed: ${outcome.error}`)
          for (const file of outcome.overlaps || []) console.error(`  overlap: ${file}`)
          for (const file of outcome.conflicts || []) console.error(`  conflict: ${file}`)
          if (outcome.snapshot) console.error(`  snapshot=${outcome.snapshot}`)
          process.exitCode = 1
          return
        }
        if (outcome.empty) {
          console.log(`worktree had no changes; cleanup=${outcome.cleanup}`)
          return
        }
        console.log(`applied ${outcome.files.length} file(s) from task ${options.id}`)
        for (const file of outcome.files) console.log(`  ${file}`)
        if (outcome.snapshot) console.log(`  snapshot=${outcome.snapshot}`)
        if (outcome.snapshot_error) console.log(`  snapshot failed: ${outcome.snapshot_error}`)
        console.log(`  worktree=${outcome.worktree}${outcome.cleanup_error ? ` (${outcome.cleanup_error})` : ""}`)
      })
    })

  cmd
    .command("discard")
    .description("discard a preserved worktree without applying its changes")
    .requiredOption("--id <id>", "task id")
    .action(async (options) => {
      await withContext(async () => {
        const task = await BackgroundManager.get(options.id)
        if (!task) {
          console.error(`not found: ${options.id}`)
          process.exitCode = 1
          return
        }
        const outcome = await discardWorktreeResult(task)
        if (!outcome.ok) {
          console.error(`discard failed: ${outcome.error}`)
          process.exitCode = 1
          return
        }
        console.log(`discarded preserved worktree for task ${options.id}`)
      })
    })

  cmd
    .command("clean")
    .description("remove old completed/cancelled/error/interrupted tasks")
    .option("--max-age <days>", "max age in days", "7")
    .action(async (options) => {
      await withContext(async () => {
        const maxAge = Number(options.maxAge || 7) * 24 * 60 * 60 * 1000
        const result = await BackgroundManager.clean({ maxAge })
        console.log(`removed ${result.removed.length} task(s)`)
        if (result.skipped_preserved.length) {
          console.log(`skipped ${result.skipped_preserved.length} task(s) with preserved worktrees: ${result.skipped_preserved.join(", ")} — apply or discard them first`)
        }
      })
    })

  return cmd
}
