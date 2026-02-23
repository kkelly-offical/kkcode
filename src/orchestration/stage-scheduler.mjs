import { BackgroundManager } from "./background-manager.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { getAgent } from "../agent/agent.mjs"

const AGENT_HINTS = [
  { pattern: /\b(test|spec|jest|mocha|vitest|coverage)\b/i, agent: "tdd-guide" },
  { pattern: /\b(review|audit|lint|quality)\b/i, agent: "reviewer" },
  { pattern: /\b(secur|vuln|owasp|xss|inject|auth)\b/i, agent: "security-reviewer" },
  { pattern: /\b(ui|ux|frontend|front.?end|component|page|layout|style|css|tailwind|theme|responsive|landing|dashboard)\b/i, agent: "frontend-designer" },
  { pattern: /\b(architect|blueprint|interface|api.*design)\b/i, agent: "architect" },
  { pattern: /\b(build.*fix|compile.*error|type.*error|syntax.*error)\b/i, agent: "build-fixer" }
]

function inferSubagentType(taskPrompt, taskId) {
  const text = `${taskPrompt} ${taskId}`
  for (const { pattern, agent } of AGENT_HINTS) {
    if (pattern.test(text) && getAgent(agent)) return agent
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeFiles(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))]
}

function mergeUnique(...lists) {
  const merged = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    merged.push(...list)
  }
  return [...new Set(merged)]
}

function normalizeFileChanges(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((item) => ({
      path: String(item?.path || "").trim(),
      addedLines: Math.max(0, Number(item?.addedLines || 0)),
      removedLines: Math.max(0, Number(item?.removedLines || 0)),
      stageId: item?.stageId ? String(item.stageId) : "",
      taskId: item?.taskId ? String(item.taskId) : ""
    }))
    .filter((item) => item.path)
}

function mergeFileChanges(...lists) {
  const map = new Map()
  for (const list of lists) {
    for (const item of normalizeFileChanges(list)) {
      const key = `${item.path}::${item.stageId}::${item.taskId}`
      const prev = map.get(key) || { ...item, addedLines: 0, removedLines: 0 }
      prev.addedLines += item.addedLines
      prev.removedLines += item.removedLines
      map.set(key, prev)
    }
  }
  return [...map.values()]
}

function computeRemaining(planned = [], completed = []) {
  const done = new Set(normalizeFiles(completed))
  return normalizeFiles(planned).filter((file) => !done.has(file))
}

function stageConfig(config = {}) {
  const parallel = config.agent?.longagent?.parallel || {}
  return {
    maxConcurrency: Math.max(1, Number(parallel.max_concurrency || 3)),
    taskTimeoutMs: Math.max(1000, Number(parallel.task_timeout_ms || 600000)),
    taskMaxRetries: Math.max(0, Number(parallel.task_max_retries ?? 2)),
    budgetLimitUsd: Number(parallel.budget_limit_usd || 0),
    passRule: "all_success"
  }
}

function retryPrompt(taskPrompt, remainingFiles = [], attempt = 1, lastError = "") {
  const parts = [
    taskPrompt,
    "",
    `Retry attempt: ${attempt}`,
    "Continue from previous progress. Focus ONLY on remaining files."
  ]
  if (remainingFiles.length) {
    parts.push(`Remaining files: ${remainingFiles.join(", ")}`)
  }
  if (lastError) {
    parts.push(`Previous failure: ${lastError}`)
  }
  return parts.join("\n")
}

function buildEnrichedPrompt({ stage, task, logicalTask, objective, stageIndex, stageCount, allTasks, priorContext }) {
  const parts = []

  parts.push("## Your Role")
  parts.push("You are an IMPLEMENTATION agent. The scaffold files already contain detailed inline comments describing what to implement. Your job is to READ those comments and REPLACE them with working code.")
  parts.push("")

  parts.push("## Global Objective")
  parts.push(objective || "(not specified)")
  parts.push("")

  if (priorContext) {
    parts.push("## Prior Stage Results")
    parts.push(priorContext)
    parts.push("")
  }

  parts.push("## Current Stage")
  parts.push(`Stage ${stageIndex + 1}/${stageCount}: ${stage.name || stage.stageId}`)
  parts.push("")

  parts.push("## Your Task")
  parts.push(logicalTask.prompt)
  parts.push("")

  if (logicalTask.plannedFiles.length > 0) {
    parts.push("## Files You Own (ONLY modify these)")
    for (const file of logicalTask.plannedFiles) {
      parts.push(`- ${file}`)
    }
    parts.push("")
  }

  const siblings = (allTasks || []).filter((t) => t.taskId !== task.taskId)
  if (siblings.length > 0) {
    parts.push("## Other Tasks in This Stage (DO NOT touch their files)")
    for (const sibling of siblings) {
      const files = normalizeFiles(sibling.plannedFiles)
      parts.push(`- ${sibling.taskId}: ${files.length > 0 ? files.join(", ") : "(no files)"}`)
    }
    parts.push("")
  }

  if (logicalTask.acceptance.length > 0) {
    parts.push("## Acceptance Criteria")
    for (const criterion of logicalTask.acceptance) {
      parts.push(`- ${criterion}`)
    }
    parts.push("")
  }

  parts.push("## Workflow")
  parts.push("1. READ each file you own — the inline comments are your implementation spec")
  parts.push("2. IMPLEMENT by replacing comments with working code (keep the file header comment)")
  parts.push("3. VERIFY with acceptance criteria (run tests, syntax checks, etc.)")
  parts.push("4. Say [TASK_COMPLETE] when done")
  parts.push("")

  parts.push("## Tool Usage Guide")
  parts.push("USE `read` first — read your scaffold files to understand the implementation spec")
  parts.push("USE `edit` to replace comment blocks with real code (preferred over `write` for existing files)")
  parts.push("USE `write` only for files that don't exist yet or need full rewrite")
  parts.push("USE `bash` to run tests, syntax checks, or build commands from acceptance criteria")
  parts.push("USE `grep`/`glob` to find imports, references, or patterns in the codebase")
  parts.push("AVOID `bash` for file reading (use `read`), file editing (use `edit`), or file searching (use `grep`/`glob`)")
  parts.push("AVOID modifying files outside your ownership list")

  return parts.join("\n")
}

function checkFileIsolation(tasks) {
  const ownership = new Map()
  const overlaps = []
  for (const task of tasks) {
    for (const file of normalizeFiles(task.plannedFiles)) {
      if (ownership.has(file)) {
        overlaps.push({ file, tasks: [ownership.get(file), task.taskId] })
      } else {
        ownership.set(file, task.taskId)
      }
    }
  }
  return overlaps
}

async function launchTask({
  stage,
  task,
  logicalTask,
  config,
  sessionId,
  model,
  providerType,
  objective,
  stageIndex,
  stageCount,
  allTasks,
  priorContext
}) {
  const enrichedPrompt = buildEnrichedPrompt({
    stage,
    task,
    logicalTask,
    objective,
    stageIndex: stageIndex || 0,
    stageCount: stageCount || 1,
    allTasks,
    priorContext
  })

  const autoAgent = !task.subagentType ? inferSubagentType(logicalTask.prompt, task.taskId) : null

  const payload = {
    parentSessionId: sessionId,
    subSessionId: logicalTask.subSessionId,
    prompt: enrichedPrompt,
    cwd: process.cwd(),
    model,
    providerType,
    subagent: task.subagentType || autoAgent || null,
    category: task.category || null,
    subagentType: task.subagentType || autoAgent || null,
    stageId: stage.stageId,
    logicalTaskId: task.taskId,
    plannedFiles: logicalTask.plannedFiles,
    remainingFiles: logicalTask.remainingFiles,
    attempt: logicalTask.attempt,
    workerTimeoutMs: logicalTask.timeoutMs
  }

  const taskDescription = `${stage.stageId}:${task.taskId}#${logicalTask.attempt}`
  const bg = await BackgroundManager.launchDelegateTask({
    description: taskDescription,
    payload,
    config: {
      ...config,
      background: {
        ...(config.background || {}),
        max_parallel: Math.max(
          Number(config.background?.max_parallel || 1),
          Number(config.agent?.longagent?.parallel?.max_concurrency || 3)
        )
      }
    }
  })

  await EventBus.emit({
    type: EVENT_TYPES.LONGAGENT_STAGE_TASK_DISPATCHED,
    sessionId,
    payload: {
      stageId: stage.stageId,
      taskId: task.taskId,
      backgroundTaskId: bg.id,
      attempt: logicalTask.attempt
    }
  })

  return bg.id
}

export async function runStageBarrier({
  stage,
  sessionId,
  config,
  model,
  providerType,
  seedTaskProgress = {},
  objective = "",
  stageIndex = 0,
  stageCount = 1,
  priorContext = ""
}) {
  const cfg = stageConfig(config)
  const logical = new Map()

  // File isolation check: overlapping files = plan bug, fail-fast
  const overlaps = checkFileIsolation(stage.tasks || [])
  if (overlaps.length > 0) {
    const details = overlaps.map((o) => `"${o.file}" claimed by [${o.tasks.join(", ")}]`).join("; ")
    await EventBus.emit({
      type: EVENT_TYPES.LONGAGENT_STAGE_STARTED,
      sessionId,
      payload: { error: `File isolation violation in stage ${stage.stageId}: ${details}`, stageId: stage.stageId }
    })
    throw new Error(`Stage ${stage.stageId}: file isolation violation — ${details}. Fix the plan to avoid overlapping file ownership.`)
  }

  for (const task of stage.tasks || []) {
    const seeded = seedTaskProgress[task.taskId] || {}
    const planned = normalizeFiles(task.plannedFiles)
    const completed = normalizeFiles(seeded.completedFiles || [])
    const remaining = normalizeFiles(seeded.remainingFiles || computeRemaining(planned, completed))
    logical.set(task.taskId, {
      stageId: stage.stageId,
      taskId: task.taskId,
      subSessionId: seeded.subSessionId || `sub_${sessionId}_${task.taskId}`,
      plannedFiles: planned,
      completedFiles: completed,
      remainingFiles: remaining,
      acceptance: Array.isArray(task.acceptance) ? task.acceptance : [],
      prompt: seeded.prompt || task.prompt,
      status: seeded.status || "pending",
      attempt: Number(seeded.attempt || 0),
      maxRetries: Number(task.maxRetries ?? cfg.taskMaxRetries),
      timeoutMs: Number(task.timeoutMs || cfg.taskTimeoutMs),
      backgroundTaskId: null,
      lastError: seeded.lastError || "",
      fileChanges: normalizeFileChanges(seeded.fileChanges || [])
    })
  }

  await EventBus.emit({
    type: EVENT_TYPES.LONGAGENT_STAGE_STARTED,
    sessionId,
    payload: {
      stageId: stage.stageId,
      taskCount: logical.size,
      passRule: cfg.passRule
    }
  })

  while (true) {
    await BackgroundManager.tick({
      ...config,
      background: {
        ...(config.background || {}),
        max_parallel: Math.max(
          Number(config.background?.max_parallel || 1),
          cfg.maxConcurrency
        )
      }
    })

    let activeCount = [...logical.values()].filter((item) => item.status === "running").length
    if (activeCount < cfg.maxConcurrency) {
      const toLaunch = []
      for (const task of stage.tasks || []) {
        const item = logical.get(task.taskId)
        if (!item || item.backgroundTaskId) continue
        if (!["pending", "retrying"].includes(item.status)) continue
        if (activeCount + toLaunch.length >= cfg.maxConcurrency) break
        item.attempt += 1
        item.status = "running"
        if (item.attempt > 1) {
          item.prompt = retryPrompt(task.prompt, item.remainingFiles, item.attempt, item.lastError)
        }
        toLaunch.push({ task, item })
      }
      if (toLaunch.length > 0) {
        const bgIds = await Promise.all(toLaunch.map(({ task, item }) =>
          launchTask({ stage, task, logicalTask: item, config, sessionId, model, providerType, objective, stageIndex, stageCount, allTasks: stage.tasks || [], priorContext })
        ))
        for (let i = 0; i < toLaunch.length; i++) {
          toLaunch[i].item.backgroundTaskId = bgIds[i]
        }
      }
    }

    let pending = 0
    for (const item of logical.values()) {
      if (!item.backgroundTaskId) {
        if (["pending", "retrying", "running"].includes(item.status)) pending += 1
        continue
      }
      const bg = await BackgroundManager.get(item.backgroundTaskId)
      if (!bg) {
        item.status = "error"
        item.lastError = "background worker disappeared"
        item.backgroundTaskId = null
        continue
      }
      if (!["completed", "error", "interrupted", "cancelled"].includes(bg.status)) {
        pending += 1
        continue
      }

      const result = bg.result || {}
      const completedFromResult = mergeUnique(
        item.completedFiles,
        normalizeFiles(result.completed_files || result.completedFiles || [])
      )
      const remainingFromResult = normalizeFiles(
        result.remaining_files || result.remainingFiles || computeRemaining(item.plannedFiles, completedFromResult)
      )
      item.completedFiles = completedFromResult
      item.remainingFiles = remainingFromResult
      item.fileChanges = mergeFileChanges(
        item.fileChanges,
        result.file_changes || result.fileChanges || []
      )
      item.backgroundTaskId = null

      // Runtime file ownership check: warn if task touched files outside its plan
      const plannedSet = new Set(item.plannedFiles)
      const outOfScope = item.fileChanges
        .map(fc => fc.path)
        .filter(p => p && !plannedSet.has(p))
      if (outOfScope.length > 0) {
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_ALERT,
          sessionId,
          payload: {
            kind: "file_ownership_violation",
            message: `Task ${item.taskId} modified ${outOfScope.length} file(s) outside its plan: ${outOfScope.slice(0, 5).join(", ")}`,
            taskId: item.taskId,
            stageId: stage.stageId,
            outOfScopeFiles: outOfScope
          }
        })
      }

      if (bg.status === "completed" && remainingFromResult.length === 0) {
        item.status = "completed"
        item.lastError = ""
      } else if (bg.status === "completed" && remainingFromResult.length > 0) {
        item.status = item.attempt <= item.maxRetries ? "retrying" : "error"
        item.lastError = "task completed but remaining files still pending"
      } else {
        item.lastError = bg.error || "task failed"
        item.status = item.attempt <= item.maxRetries ? "retrying" : (bg.status === "cancelled" ? "cancelled" : "error")
      }
      item.lastReply = String(result.reply || "")
      item.lastCost = Number(result.cost || 0)

      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_STAGE_TASK_FINISHED,
        sessionId,
        payload: {
          stageId: stage.stageId,
          taskId: item.taskId,
          status: item.status,
          attempt: item.attempt,
          remainingFiles: item.remainingFiles
        }
      })

      if (["pending", "retrying", "running"].includes(item.status)) pending += 1
    }

    if (pending <= 0) break

    // Budget circuit breaker: abort remaining tasks if cost exceeds limit
    if (cfg.budgetLimitUsd > 0) {
      const spent = [...logical.values()].reduce((s, i) => s + (Number.isFinite(i.lastCost) ? i.lastCost : 0), 0)
      if (spent >= cfg.budgetLimitUsd) {
        for (const item of logical.values()) {
          if (["pending", "retrying"].includes(item.status)) {
            item.status = "error"
            item.lastError = `budget limit exceeded ($${spent.toFixed(2)} >= $${cfg.budgetLimitUsd})`
          }
          if (item.backgroundTaskId && item.status === "running") {
            await BackgroundManager.cancel(item.backgroundTaskId).catch(() => {})
          }
        }
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_ALERT,
          sessionId,
          payload: { kind: "budget_breaker", spent, limit: cfg.budgetLimitUsd, stageId: stage.stageId }
        })
        break
      }
    }

    await sleep(300)
  }

  const items = [...logical.values()]
  const successCount = items.filter((item) => item.status === "completed").length
  const failItems = items.filter((item) => item.status !== "completed")
  const retryCount = items.reduce((sum, item) => sum + Math.max(0, item.attempt - 1), 0)
  const remainingFiles = mergeUnique(...items.map((item) => item.remainingFiles))
  const completionMarkerSeen = items.some((item) => String(item.lastReply || "").toLowerCase().includes("[task_complete]"))
  const totalCost = items.reduce((sum, item) => sum + (Number.isFinite(item.lastCost) ? item.lastCost : 0), 0)
  const fileChanges = mergeFileChanges(...items.map((item) => item.fileChanges))

  const summary = {
    stageId: stage.stageId,
    successCount,
    failCount: failItems.length,
    retryCount,
    remainingFiles,
    completionMarkerSeen,
    totalCost,
    fileChanges,
    allSuccess: failItems.length === 0,
    taskProgress: Object.fromEntries(
      items.map((item) => [
        item.taskId,
        {
          taskId: item.taskId,
          attempt: item.attempt,
          status: item.status,
          plannedFiles: item.plannedFiles,
          completedFiles: item.completedFiles,
          remainingFiles: item.remainingFiles,
          fileChanges: item.fileChanges,
          lastError: item.lastError || "",
          lastReply: item.lastReply || ""
        }
      ])
    )
  }

  await EventBus.emit({
    type: EVENT_TYPES.LONGAGENT_STAGE_FINISHED,
    sessionId,
    payload: summary
  })

  return summary
}
