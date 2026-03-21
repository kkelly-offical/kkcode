import { Command } from "commander"
import { readFile } from "node:fs/promises"
import { LongAgentManager } from "../orchestration/longagent-manager.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { loadConfig } from "../config/load-config.mjs"
import { eventLogPath } from "../storage/paths.mjs"

const NODE_MAJOR = Number.parseInt(String(process.versions?.node || process.version || "").replace(/^v/, "").split(".")[0] || "", 10)

function printNode25RuntimeHint() {
  if (!(Number.isFinite(NODE_MAJOR) && NODE_MAJOR >= 25)) return
  console.log(`runtime note: Node ${process.versions.node} still has a known worker-exit edge case; kkcode now reconciles longagent/background tasks more aggressively, but Node 22 remains the stable baseline.`)
}

function formatElapsedSince(timestamp) {
  const value = Number(timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return "-"
  const delta = Math.max(0, Date.now() - value)
  if (delta < 1000) return "just now"
  if (delta < 60000) return `${Math.round(delta / 1000)}s ago`
  if (delta < 3600000) return `${Math.round(delta / 60000)}m ago`
  return `${Math.round(delta / 3600000)}h ago`
}

function formatProgress(progress) {
  if (!progress || typeof progress !== "object") return "0%"
  const pct = Number(progress.percentage || 0)
  const step = Number(progress.currentStep || 0)
  const total = Number(progress.totalSteps || 0)
  if (total > 0) return `${pct}% (${step}/${total})`
  return `${pct}%`
}

function formatTimeline(session, task = null, maxItems = 5) {
  if (!session || typeof session !== "object") return []
  const reports = Array.isArray(session.stageReports) ? session.stageReports : []
  const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : []
  const items = []

  for (const report of reports.slice(-Math.max(0, maxItems))) {
    items.push([
      "stage",
      report.stageId || "-",
      String(report.status || "-").toUpperCase(),
      `ok=${report.successCount || 0}`,
      `fail=${report.failCount || 0}`
    ].join(" "))
  }

  for (const checkpoint of checkpoints.slice(-Math.max(0, maxItems))) {
    items.push([
      "checkpoint",
      checkpoint.id || "-",
      checkpoint.phase || "-",
      checkpoint.kind || "checkpoint",
      String(checkpoint.summary || "").trim()
    ].filter(Boolean).join(" "))
  }

  const bg = task || {}
  const backgroundTaskId = session.backgroundTaskId || bg.id
  if (backgroundTaskId) {
    items.push([
      "background",
      bg.status || session.backgroundTaskStatus || "unknown",
      `task=${backgroundTaskId}`,
      `attempt=${session.backgroundTaskAttempt || bg.attempt || 0}`
    ].join(" "))
  }

  return items.slice(-Math.max(0, maxItems))
}

function formatCheckpointList(session) {
  const checkpoints = Array.isArray(session?.checkpoints) ? session.checkpoints : []
  const recommended = recommendLongagentRecoveryAction(session)
  const recommendedCheckpointId = recommended?.kind === "recover-checkpoint"
    ? String(recommended.command.split("--checkpoint ")[1] || "").trim()
    : ""
  return checkpoints.slice().reverse().map((checkpoint, index) => {
    const flags = []
    if (index === 0) flags.push("latest")
    if (checkpoint.id === recommendedCheckpointId) flags.push("recommended")
    const suffix = flags.length ? ` [${flags.join(", ")}]` : ""
    return `${checkpoint.id}  ${checkpoint.phase || "-"}  ${checkpoint.kind || "checkpoint"}${suffix}  ${checkpoint.summary || ""}`.trim()
  })
}

export function recommendLongagentRecoveryAction(session, task = null) {
  if (!session || typeof session !== "object" || !session.sessionId) return null
  const bgStatus = task?.status || session.backgroundTaskStatus || ""
  if (["interrupted", "error", "cancel_requested"].includes(bgStatus)) {
    return {
      kind: "recover",
      command: `kkcode longagent recover --session ${session.sessionId}`,
      reason: `background task is ${bgStatus}`
    }
  }
  const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : []
  const latestCheckpointId = checkpoints.length ? checkpoints[checkpoints.length - 1].id : null
  if (session.lastStageReport?.status === "fail" && latestCheckpointId) {
    return {
      kind: "recover-checkpoint",
      command: `kkcode longagent recover-checkpoint --session ${session.sessionId} --checkpoint ${latestCheckpointId}`,
      reason: `last stage ${session.lastStageReport.stageId || "-"} failed`
    }
  }
  if (latestCheckpointId && Number(session.recoveryCount || 0) > 0) {
    return {
      kind: "recover-checkpoint",
      command: `kkcode longagent recover-checkpoint --session ${session.sessionId} --checkpoint ${latestCheckpointId}`,
      reason: `recovery_count=${session.recoveryCount}`
    }
  }
  return null
}

export function recommendLongagentRecoveryCommand(session, task = null) {
  return recommendLongagentRecoveryAction(session, task)?.command || null
}

export function formatLongagentSessionStatus(session, task = null) {
  const lines = []
  lines.push(`session: ${session.sessionId}`)
  lines.push(`status: ${session.status || "idle"} phase=${session.phase || "-"} gate=${session.currentGate || "-"}`)
  lines.push(`provider: ${session.providerType || "-"} model=${session.model || "-"}`)
  lines.push(`progress: ${formatProgress(session.progress)} recovery=${session.recoveryCount || 0} updated=${formatElapsedSince(session.updatedAt)}`)
  if (session.heartbeatAt) {
    lines.push(`heartbeat: ${formatElapsedSince(session.heartbeatAt)}`)
  }
  if (session.currentStageId || Number.isFinite(Number(session.stageCount || 0))) {
    const stageCount = Number(session.stageCount || 0)
    const stageIndex = Number(session.stageIndex || 0)
    const stageLabel = session.currentStageId || (stageCount > 0 ? `${Math.min(stageIndex + 1, stageCount)}/${stageCount}` : "-")
    lines.push(`stage: ${stageLabel} remaining=${session.remainingFilesCount ?? "-"} iterations=${session.iterations || 0}/${session.maxIterations || 0}`)
  }
  if (session.backgroundTaskId || task) {
    const bg = task || {}
    lines.push(
      `background: ${(bg.status || session.backgroundTaskStatus || "unknown")} task=${session.backgroundTaskId || bg.id || "-"} attempt=${session.backgroundTaskAttempt || bg.attempt || 0}`
    )
  }
  if (session.lastMessage) {
    lines.push(`last: ${session.lastMessage}`)
  }
  if (session.lastStageReport?.stageId) {
    const report = session.lastStageReport
    lines.push(
      `last stage: ${report.stageId} ${String(report.status || "-").toUpperCase()} ok=${report.successCount || 0} fail=${report.failCount || 0} retry=${report.retryCount || 0}`
    )
    if (Number(report.remainingFilesCount || 0) > 0) {
      lines.push(`remaining files: ${(report.remainingFiles || []).join(", ") || report.remainingFilesCount}`)
    }
  }
  const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : []
  if (checkpoints.length) {
    const latest = checkpoints[checkpoints.length - 1]
    lines.push(`latest checkpoint: ${latest.id} ${latest.kind || "checkpoint"} ${latest.phase || "-"} ${latest.summary || ""}`.trim())
  }
  const timeline = formatTimeline(session, task, 5)
  if (timeline.length) {
    lines.push("timeline:")
    for (const item of timeline) lines.push(`  - ${item}`)
  }
  const recovery = Array.isArray(session.recoverySuggestions) ? session.recoverySuggestions : []
  if (recovery.length) {
    lines.push("recovery suggestions:")
    for (const item of recovery.slice(0, 5)) lines.push(`  - ${item}`)
  }
  const recommended = recommendLongagentRecoveryAction(session, task)
  if (recommended) {
    lines.push(`recommended: ${recommended.command}`)
    lines.push(`recommended reason: ${recommended.reason}`)
  }
  if (session.backgroundTaskId && ["interrupted", "error", "cancel_requested"].includes(session.backgroundTaskStatus)) {
    lines.push(`hint: kkcode longagent recover --session ${session.sessionId}`)
  }
  if (checkpoints.length) {
    lines.push(`hint: kkcode longagent recover-checkpoint --session ${session.sessionId} --checkpoint ${checkpoints[checkpoints.length - 1].id}`)
  }
  return lines
}

function formatLongagentSessionList(sessions) {
  if (!sessions.length) return ["no longagent sessions"]
  return sessions.map((item) => {
    const stageCount = Number(item.stageCount || 0)
    const stageIndex = Number(item.stageIndex || 0)
    const stageLabel = item.currentStageId || (stageCount > 0 ? `${Math.min(stageIndex + 1, stageCount)}/${stageCount}` : "-")
    return [
      item.sessionId,
      item.status || "idle",
      item.phase || "-",
      `stage=${stageLabel}`,
      `progress=${formatProgress(item.progress)}`,
      item.backgroundTaskId ? `bg=${item.backgroundTaskStatus || "unknown"}` : null
    ].filter(Boolean).join("\t")
  })
}

export function createLongagentCommand() {
  const cmd = new Command("longagent").description("manage longagent sessions")

  async function loadTaskForSession(sessionId, config = null) {
    const item = await LongAgentManager.get(sessionId)
    if (!item?.backgroundTaskId) return { session: item, task: null }
    if (config) {
      await BackgroundManager.tick(config).catch(() => {})
    }
    const task = await BackgroundManager.get(item.backgroundTaskId)
    return { session: item, task }
  }

  async function relaunchBackgroundSession(session, config, {
    promptOverride = null,
    lastMessage = null,
    checkpointPatch = null
  } = {}) {
    const prompt = String(promptOverride || session?.objective || "").trim()
    if (!prompt) {
      throw new Error("session has no objective to recover")
    }
    const providerKey = session.providerType || config.provider?.default
    const providerConf = config.provider?.[providerKey] || {}
    const model = session.model || providerConf.default_model
    if (!model) {
      throw new Error(`no model configured for provider "${providerKey}"`)
    }
    const task = await BackgroundManager.launchLongAgentTask({
      description: `longagent session ${session.sessionId}`,
      payload: {
        workerType: "longagent_session",
        cwd: process.cwd(),
        prompt,
        providerType: providerKey,
        model,
        longagentSessionId: session.sessionId,
        maxIterations: Number(session.maxIterations || 0)
      },
      config
    })
    await LongAgentManager.linkBackgroundTask(session.sessionId, task)
    await LongAgentManager.update(session.sessionId, {
      status: "pending",
      objective: session.objective,
      providerType: providerKey,
      model,
      maxIterations: Number(session.maxIterations || 0),
      stopRequested: false,
      ...(checkpointPatch || {}),
      lastMessage: lastMessage || `background recovery queued (${task.id})`
    })
    return task
  }

  cmd
    .command("status")
    .description("show one longagent session or list all")
    .option("--session <id>", "session id")
    .option("--json", "output raw json", false)
    .action(async (options) => {
      if (!options.json) printNode25RuntimeHint()
      if (options.session) {
        const item = await LongAgentManager.get(options.session)
        if (!item) {
          console.error(`not found: ${options.session}`)
          process.exitCode = 1
          return
        }
        if (options.json) {
          console.log(JSON.stringify(item, null, 2))
          return
        }
        const configState = await loadConfig()
        const { task } = await loadTaskForSession(options.session, configState.config)
        for (const line of formatLongagentSessionStatus(item, task)) console.log(line)
        return
      }
      const list = await LongAgentManager.list()
      if (options.json) {
        console.log(JSON.stringify(list, null, 2))
        return
      }
      for (const line of formatLongagentSessionList(list)) console.log(line)
    })

  cmd
    .command("plan")
    .description("show frozen stage plan for a longagent session")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      const item = await LongAgentManager.get(options.session)
      if (!item) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      if (!item.stagePlan) {
        console.error(`no frozen plan found for session: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(JSON.stringify(item.stagePlan, null, 2))
    })

  cmd
    .command("checkpoints")
    .description("show checkpoints for a longagent session")
    .requiredOption("--session <id>", "session id")
    .option("--json", "output raw json", false)
    .action(async (options) => {
      const item = await LongAgentManager.get(options.session)
      if (!item) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      if (options.json) {
        console.log(JSON.stringify(item.checkpoints || [], null, 2))
        return
      }
      const checkpoints = formatCheckpointList(item)
      if (!checkpoints.length) {
        console.log("no checkpoints")
        return
      }
      console.log(`session: ${item.sessionId}`)
      for (const line of checkpoints) console.log(`- ${line}`)
      const recommended = recommendLongagentRecoveryAction(item)
      if (recommended) {
        console.log(`recommended: ${recommended.command}`)
        console.log(`reason: ${recommended.reason}`)
      }
    })

  cmd
    .command("task")
    .description("show linked background task for a longagent session")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      const configState = await loadConfig()
      const { session, task } = await loadTaskForSession(options.session, configState.config)
      if (!session) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      if (!session.backgroundTaskId) {
        console.error(`session has no linked background task: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(JSON.stringify(task || {
        id: session.backgroundTaskId,
        status: session.backgroundTaskStatus || "unknown",
        attempt: session.backgroundTaskAttempt || 0,
        updatedAt: session.backgroundTaskUpdatedAt || null
      }, null, 2))
    })

  cmd
    .command("cancel-task")
    .description("cancel linked background task for a longagent session")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      printNode25RuntimeHint()
      const configState = await loadConfig()
      const { session } = await loadTaskForSession(options.session, configState.config)
      if (!session) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      if (!session.backgroundTaskId) {
        console.error(`session has no linked background task: ${options.session}`)
        process.exitCode = 1
        return
      }
      const ok = await BackgroundManager.cancel(session.backgroundTaskId)
      if (!ok) {
        console.error(`background task not found: ${session.backgroundTaskId}`)
        process.exitCode = 1
        return
      }
      await LongAgentManager.update(options.session, {
        backgroundTaskStatus: "cancel_requested",
        backgroundTaskUpdatedAt: Date.now(),
        lastMessage: "background task cancellation requested"
      })
      console.log(`background cancel requested: ${session.backgroundTaskId}`)
    })

  cmd
    .command("retry-task")
    .description("retry linked interrupted/error background task for a longagent session")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      printNode25RuntimeHint()
      const configState = await loadConfig()
      const { session } = await loadTaskForSession(options.session, configState.config)
      if (!session) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      if (!session.backgroundTaskId) {
        console.error(`session has no linked background task: ${options.session}`)
        process.exitCode = 1
        return
      }
      const task = await BackgroundManager.retry(session.backgroundTaskId, configState.config)
      if (!task) {
        console.error(`linked background task is not retryable: ${session.backgroundTaskId}`)
        process.exitCode = 1
        return
      }
      await LongAgentManager.linkBackgroundTask(options.session, task)
      await LongAgentManager.update(options.session, {
        status: "pending",
        lastMessage: `background task retry queued (attempt ${task.attempt})`
      })
      console.log(`background retry queued: ${task.id} (attempt=${task.attempt})`)
    })

  cmd
    .command("recover-checkpoint")
    .description("recover a longagent session from a specific checkpoint")
    .requiredOption("--session <id>", "session id")
    .requiredOption("--checkpoint <id>", "checkpoint id")
    .action(async (options) => {
      printNode25RuntimeHint()
      const configState = await loadConfig()
      const session = await LongAgentManager.get(options.session)
      if (!session) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : []
      const checkpoint = checkpoints.find((item) => item.id === options.checkpoint)
      if (!checkpoint) {
        console.error(`checkpoint not found: ${options.checkpoint}`)
        process.exitCode = 1
        return
      }
      const objective = [
        session.objective,
        "",
        "Resume from checkpoint:",
        `- Kind: ${checkpoint.kind || "phase"}`,
        `- Phase: ${checkpoint.phase || "-"}`,
        checkpoint.stageId ? `- Stage: ${checkpoint.stageId}` : null,
        checkpoint.taskId ? `- Task: ${checkpoint.taskId}` : null,
        `- Summary: ${checkpoint.summary || ""}`
      ].filter(Boolean).join("\n")

      try {
        const task = await relaunchBackgroundSession(session, configState.config, {
          promptOverride: objective,
          checkpointPatch: {
            phase: checkpoint.phase || session.phase,
            currentStageId: checkpoint.stageId || session.currentStageId || null
          },
          lastMessage: `manual recovery queued from checkpoint ${checkpoint.id}`
        })
        await LongAgentManager.checkpoint(options.session, {
          phase: checkpoint.phase || session.phase,
          kind: "manual_recovery",
          stageId: checkpoint.stageId || null,
          taskId: checkpoint.taskId || null,
          summary: `manual recovery from checkpoint ${checkpoint.id}`
        }, process.cwd(), configState.config)
        console.log(`checkpoint recovery queued: ${task.id}`)
      } catch (error) {
        console.error(`checkpoint recovery failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  cmd
    .command("retry-task-run")
    .description("retry one longagent task by queuing a focused recovery turn")
    .requiredOption("--session <id>", "session id")
    .requiredOption("--task <id>", "task id")
    .action(async (options) => {
      printNode25RuntimeHint()
      const configState = await loadConfig()
      const session = await LongAgentManager.get(options.session)
      if (!session) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      const task = session.taskProgress?.[options.task]
      if (!task) {
        console.error(`task not found in session progress: ${options.task}`)
        process.exitCode = 1
        return
      }
      const objective = [
        session.objective,
        "",
        "Retry the failed task only.",
        `- Target task: ${options.task}`,
        session.currentStageId ? `- Stage: ${session.currentStageId}` : null,
        task.lastError ? `- Last error: ${String(task.lastError).slice(-2000)}` : null
      ].filter(Boolean).join("\n")

      try {
        const backgroundTask = await relaunchBackgroundSession(session, configState.config, {
          promptOverride: objective,
          checkpointPatch: {
            retryStageId: session.currentStageId || null
          },
          lastMessage: `manual retry queued for task ${options.task}`
        })
        await LongAgentManager.checkpoint(options.session, {
          phase: session.phase || "manual_retry",
          kind: "manual_task_retry",
          stageId: session.currentStageId || null,
          taskId: options.task,
          summary: `manual retry for task ${options.task}`
        }, process.cwd(), configState.config)
        console.log(`task retry queued: ${backgroundTask.id}`)
      } catch (error) {
        console.error(`task retry failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  cmd
    .command("recover")
    .description("recover a longagent session by re-attaching or relaunching its background task")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      printNode25RuntimeHint()
      const configState = await loadConfig()
      const { session, task } = await loadTaskForSession(options.session, configState.config)
      if (!session) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      if (session.stopRequested) {
        await LongAgentManager.clearStop(options.session)
      }
      if (task && ["pending", "running"].includes(task.status)) {
        console.log(`already active: ${task.id} (${task.status})`)
        return
      }
      if (task && ["error", "interrupted"].includes(task.status)) {
        const retried = await BackgroundManager.retry(task.id, configState.config)
        if (!retried) {
          console.error(`linked background task is not retryable: ${task.id}`)
          process.exitCode = 1
          return
        }
        await LongAgentManager.linkBackgroundTask(options.session, retried)
        await LongAgentManager.update(options.session, {
          status: "pending",
          lastMessage: `background recovery retry queued (attempt ${retried.attempt})`
        })
        console.log(`background recovery queued: ${retried.id} (attempt=${retried.attempt})`)
        return
      }
      try {
        const relaunched = await relaunchBackgroundSession(session, configState.config)
        console.log(`background recovery relaunched: ${relaunched.id}`)
      } catch (error) {
        console.error(`recovery failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  cmd
    .command("stop")
    .description("emergency stop for a running longagent session")
    .requiredOption("--session <id>", "session id")
    .option("--force", "confirm emergency stop")
    .action(async (options) => {
      if (!options.force) {
        console.error("longagent stop is emergency-only. re-run with --force to confirm.")
        process.exitCode = 1
        return
      }
      const result = await LongAgentManager.stop(options.session)
      if (!result) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(`emergency stop requested: ${options.session}`)
    })

  cmd
    .command("resume")
    .description("clear stop flag for session")
    .requiredOption("--session <id>", "session id")
    .action(async (options) => {
      const result = await LongAgentManager.clearStop(options.session)
      if (!result) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      console.log(`stop flag cleared: ${options.session}`)
    })

  cmd
    .command("stage-retry")
    .description("mark one stage for manual retry in longagent state")
    .requiredOption("--session <id>", "session id")
    .requiredOption("--stage <id>", "stage id")
    .action(async (options) => {
      const current = await LongAgentManager.get(options.session)
      if (!current) {
        console.error(`not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      const out = await LongAgentManager.update(options.session, {
        retryStageId: options.stage,
        stageStatus: "retry_requested",
        stopRequested: false
      })
      console.log(`stage retry requested: ${options.stage} (session=${out.sessionId})`)
    })

  cmd
    .command("logs")
    .description("view longagent event logs")
    .option("--session <id>", "filter by session id")
    .option("-n, --lines <n>", "number of recent lines", "50")
    .option("--json", "output raw JSON lines")
    .action(async (options) => {
      const logFile = eventLogPath()
      let raw
      try {
        raw = await readFile(logFile, "utf8")
      } catch {
        console.error(`no event log found at ${logFile}`)
        process.exitCode = 1
        return
      }
      const allLines = raw.trim().split("\n").filter(Boolean)
      let events = allLines.map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)

      if (options.session) {
        events = events.filter((e) => e.sessionId === options.session)
      }
      // filter longagent-related events
      events = events.filter((e) =>
        String(e.type || "").includes("longagent") ||
        String(e.type || "").includes("stage") ||
        String(e.type || "").includes("task")
      )
      const limit = Math.max(1, Number(options.lines) || 50)
      events = events.slice(-limit)

      if (options.json) {
        for (const e of events) console.log(JSON.stringify(e))
        return
      }
      if (!events.length) {
        console.log("no longagent events found")
        return
      }
      for (const e of events) {
        const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 19) : "??:??:??"
        const sid = e.sessionId ? e.sessionId.slice(0, 12) : "????????????"
        const payload = e.payload ? JSON.stringify(e.payload).slice(0, 120) : ""
        console.log(`${ts} [${sid}] ${e.type || "unknown"}${payload ? " " + payload : ""}`)
      }
    })

  cmd
    .command("config")
    .description("show effective longagent configuration")
    .option("--full", "show full merged config (not just longagent section)")
    .action(async (options) => {
      printNode25RuntimeHint()
      const configState = await loadConfig()
      if (options.full) {
        console.log(JSON.stringify(configState.config, null, 2))
        return
      }
      const la = configState.config.agent?.longagent || {}
      console.log("## longagent config")
      console.log(JSON.stringify(la, null, 2))
      console.log("\n## sources")
      console.log(`  user:    ${configState.source.userPath || "(none)"}`)
      console.log(`  project: ${configState.source.projectPath || "(none)"}`)
      console.log(`  env:     ${configState.source.envPath || "(none)"}`)
      if (configState.errors.length) {
        console.log("\n## errors")
        for (const e of configState.errors) console.log(`  - ${e}`)
      }
    })

  cmd
    .command("start")
    .description("launch a longagent session with a prompt")
    .argument("<prompt>", "task description for longagent")
    .option("--model <model>", "override model")
    .option("--provider <type>", "override provider type")
    .option("--max-iterations <n>", "max iterations (0=unlimited)", "0")
    .option("--background", "run longagent in background worker")
    .action(async (prompt, options) => {
      printNode25RuntimeHint()
      const configState = await loadConfig()
      const providerKey = options.provider || configState.config.provider.default
      const providerConf = configState.config.provider[providerKey] || {}
      const model = options.model || providerConf.default_model
      if (!model) {
        console.error(`no model configured for provider "${providerKey}"`)
        process.exitCode = 1
        return
      }
      const { executeTurn } = await import("../session/engine.mjs")
      const { newSessionId } = await import("../session/engine.mjs")
      const sessionId = newSessionId()
      const maxIterations = Number(options.maxIterations) || 0
      console.log(`starting longagent session: ${sessionId}`)
      console.log(`model: ${model}, provider: ${providerKey}`)
      if (options.background) {
        await LongAgentManager.update(sessionId, {
          status: "pending",
          objective: prompt,
          providerType: providerKey,
          model,
          maxIterations,
          lastMessage: "background longagent queued",
          backgroundTaskStatus: "pending",
          backgroundTaskUpdatedAt: Date.now()
        })
        const task = await BackgroundManager.launchLongAgentTask({
          description: `longagent session ${sessionId}`,
          payload: {
            workerType: "longagent_session",
            cwd: process.cwd(),
            prompt,
            providerType: providerKey,
            model,
            longagentSessionId: sessionId,
            maxIterations
          },
          config: configState.config
        })
        await LongAgentManager.linkBackgroundTask(sessionId, task)
        console.log(`background task queued: ${task.id}`)
        return
      }
      try {
        const result = await executeTurn({
          prompt,
          mode: "longagent",
          model,
          sessionId,
          configState: { config: configState.config, source: configState.source },
          providerType: providerKey,
          baseUrl: providerConf.base_url || null,
          apiKeyEnv: providerConf.api_key_env || null,
          maxIterations,
          output: { write: (t) => process.stdout.write(t) }
        })
        console.log(`\nsession ${sessionId} finished (status: ${result.status || "done"})`)
      } catch (err) {
        console.error(`longagent error: ${err.message}`)
        process.exitCode = 1
      }
    })

  return cmd
}
