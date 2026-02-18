import { LongAgentManager } from "../orchestration/longagent-manager.mjs"
import { processTurnLoop } from "./loop.mjs"
import { markSessionStatus } from "./store.mjs"
import { EventBus } from "../core/events.mjs"
import {
  EVENT_TYPES,
  DEFAULT_LONGAGENT_RETRY_STORM_THRESHOLD,
  DEFAULT_LONGAGENT_TOKEN_ALERT_THRESHOLD
} from "../core/constants.mjs"
import { saveCheckpoint, loadCheckpoint } from "./checkpoint.mjs"
import {
  runUsabilityGates,
  hasGatePreferences,
  getGatePreferences,
  saveGatePreferences,
  buildGatePromptText,
  parseGateSelection
} from "./usability-gates.mjs"
import { runIntakeDialogue, buildStagePlan } from "./longagent-plan.mjs"
import { runStageBarrier } from "../orchestration/stage-scheduler.mjs"
import { runScaffoldPhase } from "./longagent-scaffold.mjs"
import * as git from "../util/git.mjs"

function isComplete(text) {
  const lower = String(text || "").toLowerCase()
  if (lower.includes("[task_complete]")) return true
  if (lower.includes("task complete")) return true
  if (lower.includes("completed successfully")) return true
  return false
}

function normalizeReply(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ")
}

function extractStructuredProgress(text) {
  const str = String(text || "")
  const progressMatch = str.match(/\[PROGRESS:\s*(\d+)%\]/)
  const stepMatch = str.match(/\[STEP:\s*(\d+)\/(\d+)\]/)
  return {
    percentage: progressMatch ? Number(progressMatch[1]) : null,
    currentStep: stepMatch ? Number(stepMatch[1]) : null,
    totalSteps: stepMatch ? Number(stepMatch[2]) : null,
    hasStructuredSignal: Boolean(progressMatch || stepMatch)
  }
}

function detectProgress(currentReply, previousReplyNormalized) {
  const structured = extractStructuredProgress(currentReply)
  if (structured.hasStructuredSignal) {
    return { hasProgress: true, structured }
  }
  const normalized = normalizeReply(currentReply)
  if (normalized !== previousReplyNormalized && normalized.length > 10) {
    return { hasProgress: true, structured }
  }
  return { hasProgress: false, structured }
}

function buildNextPrompt(original, reply, iteration, progress) {
  const parts = [
    `Original objective: ${original}`,
    `Iteration: ${iteration}`
  ]
  if (progress?.percentage !== null) {
    parts.push(`Current progress: ${progress.percentage}%`)
  }
  if (progress?.currentStep !== null && progress?.totalSteps !== null) {
    parts.push(`Current step: ${progress.currentStep}/${progress.totalSteps}`)
  }
  parts.push("Latest result:", reply, "")
  parts.push("Continue execution. Report progress with [PROGRESS: X%] and [STEP: N/M] markers.")
  parts.push("When the entire task is complete, include [TASK_COMPLETE] in your final answer.")
  return parts.join("\n")
}

function buildRecoveryPrompt(original, reply, iteration, reason, progress, checkpoint = null) {
  const parts = [
    `Original objective: ${original}`,
    `Recovery reason: ${reason}`,
    `Current iteration: ${iteration}`
  ]
  if (progress?.percentage !== null) {
    parts.push(`Last known progress: ${progress.percentage}%`)
  }
  if (checkpoint) {
    parts.push(
      `Checkpoint restored: name=${checkpoint.name || "latest"} savedAt=${new Date(checkpoint.savedAt || Date.now()).toISOString()}`
    )
  }
  parts.push("")
  parts.push("Latest output that failed to advance:")
  parts.push(reply || "(empty)")
  parts.push("")
  parts.push("Enter recovery mode now. Diagnose blockers, apply concrete fixes, and continue execution.")
  parts.push("Do not stop early. Only mark completion when objective is fully usable and include [TASK_COMPLETE].")
  return parts.join("\n")
}

function summarizeGateFailures(failures = []) {
  if (!failures.length) return ""
  return failures
    .slice(0, 5)
    .map((item) => `${item.gate}:${item.reason}`)
    .join("; ")
}

function stageProgressStats(taskProgress = {}) {
  if (!taskProgress || typeof taskProgress !== "object") {
    return { done: 0, total: 0, remainingFiles: [], remainingFilesCount: 0 }
  }
  const items = Object.values(taskProgress)
  const done = items.filter((item) => item.status === "completed").length
  const total = items.length
  const remainingFiles = [...new Set(items.flatMap((item) => Array.isArray(item.remainingFiles) ? item.remainingFiles : []))]
  return {
    done,
    total,
    remainingFiles,
    remainingFilesCount: remainingFiles.length
  }
}

const LONGAGENT_FILE_CHANGES_LIMIT = 400

function normalizeFileChange(item = {}) {
  const path = String(item.path || "").trim()
  if (!path) return null
  return {
    path,
    addedLines: Math.max(0, Number(item.addedLines || 0)),
    removedLines: Math.max(0, Number(item.removedLines || 0)),
    stageId: item.stageId ? String(item.stageId) : "",
    taskId: item.taskId ? String(item.taskId) : ""
  }
}

function mergeCappedFileChanges(current = [], incoming = [], limit = LONGAGENT_FILE_CHANGES_LIMIT) {
  const maxEntries = Math.max(1, Number(limit || LONGAGENT_FILE_CHANGES_LIMIT))
  const map = new Map()

  const append = (entry) => {
    const normalized = normalizeFileChange(entry)
    if (!normalized) return
    const key = `${normalized.path}::${normalized.stageId}::${normalized.taskId}`
    const prev = map.get(key) || { ...normalized, addedLines: 0, removedLines: 0 }
    prev.addedLines += normalized.addedLines
    prev.removedLines += normalized.removedLines
    // keep newest insertion order so capped slice keeps most recent touched files
    map.delete(key)
    map.set(key, prev)
  }

  for (const item of current) append(item)
  for (const item of incoming) append(item)

  const merged = [...map.values()]
  return merged.length <= maxEntries ? merged : merged.slice(merged.length - maxEntries)
}

function isLikelyActionableObjective(prompt) {
  const text = String(prompt || "").trim()
  if (!text) return false
  const lower = text.toLowerCase()
  const greetings = [
    "hi", "hello", "hey", "你好", "您好", "在吗", "yo", "嗨"
  ]
  const codingSignals = [
    "fix", "build", "implement", "refactor", "debug", "test", "review", "write", "create", "add", "optimize", "migrate", "deploy",
    "bug", "issue", "error", "code", "repo", "file", "function", "api",
    "修复", "实现", "重构", "调试", "测试", "优化", "迁移", "部署", "代码", "仓库", "文件", "函数", "接口", "需求", "功能", "报错"
  ]
  if (codingSignals.some((kw) => lower.includes(kw))) return true
  if (greetings.some((g) => lower === g || lower === `${g}!` || lower === `${g}！`)) return false
  if (text.length <= 8 && !/[./\\:_-]/.test(text)) return false
  return true
}

async function runParallelLongAgent({
  prompt,
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  agent = null,
  maxIterations = 0,
  signal = null,
  output = null,
  allowQuestion = true,
  toolContext = {}
}) {
  const longagentConfig = configState.config.agent.longagent || {}
  const plannerConfig = longagentConfig.planner || {}
  const intakeConfig = plannerConfig.intake_questions || {}
  const parallelConfig = longagentConfig.parallel || {}
  const noProgressLimit = Number(longagentConfig.no_progress_limit || 5)
  const checkpointInterval = Number(longagentConfig.checkpoint_interval || 5)
  const maxGateAttempts = Number(longagentConfig.max_gate_attempts || 5)

  const gitConfig = longagentConfig.git || {}
  const gitEnabled = gitConfig.enabled === true || gitConfig.enabled === "ask"
  const gitAsk = gitConfig.enabled === "ask"

  let iteration = 0
  let recoveryCount = 0
  let currentPhase = "L0"
  let currentGate = "intake"
  let gateStatus = {}
  let lastGateFailures = []
  let lastProgress = { percentage: 0, currentStep: 0, totalSteps: 0 }
  let finalReply = ""
  let stageIndex = 0
  let planFrozen = false
  let stagePlan = null
  let taskProgress = {}
  let fileChanges = []
  const fileChangesLimit = Math.max(20, Number(longagentConfig.file_changes_limit || LONGAGENT_FILE_CHANGES_LIMIT))
  const aggregateUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const toolEvents = []
  const startTime = Date.now()
  let completionMarkerSeen = false
  let gitBranch = null
  let gitBaseBranch = null
  let gitActive = false

  async function setPhase(nextPhase, reason = "") {
    if (currentPhase === nextPhase) return
    const prevPhase = currentPhase
    currentPhase = nextPhase
    await EventBus.emit({
      type: EVENT_TYPES.LONGAGENT_PHASE_CHANGED,
      sessionId,
      payload: { prevPhase, nextPhase, reason, iteration }
    })
  }

  async function syncState(patch = {}) {
    const stats = stageProgressStats(taskProgress)
    const stageCount = stagePlan?.stages?.length || 0
    const currentStage = stagePlan?.stages?.[stageIndex] || null
    await LongAgentManager.update(sessionId, {
      status: patch.status || "running",
      phase: currentPhase,
      gateStatus,
      currentGate,
      recoveryCount,
      lastGateFailures,
      iterations: iteration,
      heartbeatAt: Date.now(),
      noProgressCount: 0,
      progress: lastProgress,
      planFrozen,
      currentStageId: currentStage?.stageId || null,
      stageIndex,
      stageCount,
      stageStatus: patch.stageStatus || null,
      taskProgress,
      remainingFiles: stats.remainingFiles,
      remainingFilesCount: stats.remainingFilesCount,
      stageProgress: {
        done: stats.done,
        total: stats.total
      },
      ...patch
    })
  }

  await markSessionStatus(sessionId, "running-longagent")
  await syncState({
    status: "running",
    lastMessage: "longagent parallel mode started",
    stopRequested: false
  })

  if (!isLikelyActionableObjective(prompt)) {
    const blocked = "LongAgent 需要明确的编码目标。请直接描述要实现/修复的内容、涉及文件或验收标准。"
    await LongAgentManager.update(sessionId, {
      status: "blocked",
      phase: "L0",
      currentGate: "intake",
      gateStatus: {
        intake: {
          status: "blocked",
          reason: "objective_not_actionable"
        }
      },
      lastMessage: blocked
    })
    await markSessionStatus(sessionId, "active")
    return {
      sessionId,
      turnId: `turn_long_${Date.now()}`,
      reply: blocked,
      usage: aggregateUsage,
      toolEvents,
      iterations: 0,
      emittedText: false,
      context: null,
      status: "blocked",
      phase: "L0",
      gateStatus: { intake: { status: "blocked", reason: "objective_not_actionable" } },
      currentGate: "intake",
      lastGateFailures: [],
      recoveryCount: 0,
      progress: { percentage: 0, currentStep: 0, totalSteps: 0 },
      elapsed: 0,
      stageIndex: 0,
      stageCount: 0,
      currentStageId: null,
      planFrozen: false,
      taskProgress: {},
      stageProgress: { done: 0, total: 0, remainingFiles: [], remainingFilesCount: 0 },
      fileChanges: [],
      remainingFilesCount: 0
    }
  }

  await EventBus.emit({
    type: EVENT_TYPES.LONGAGENT_INTAKE_STARTED,
    sessionId,
    payload: { objective: prompt }
  })

  const intakeEnabled = intakeConfig.enabled !== false
  let intakeSummary = prompt
  if (intakeEnabled) {
    await setPhase("L0", "intake")
    const intake = await runIntakeDialogue({
      objective: prompt,
      model,
      providerType,
      sessionId,
      configState,
      baseUrl,
      apiKeyEnv,
      agent,
      signal,
      maxRounds: Number(intakeConfig.max_rounds || 6)
    })
    intakeSummary = intake.summary || prompt
    gateStatus.intake = {
      status: "pass",
      rounds: intake.transcript.length,
      summary: intakeSummary.slice(0, 500)
    }
    await syncState({
      lastMessage: `intake completed (${intake.transcript.length} qa pairs)`
    })
  }

  // --- Git branch creation (after intake, before planning) ---
  const cwd = process.cwd()
  const inGitRepo = gitEnabled && await git.isGitRepo(cwd)
  if (inGitRepo) {
    let userWantsGit = !gitAsk
    if (gitAsk && allowQuestion) {
      // Ask user via a lightweight turn
      const askResult = await processTurnLoop({
        prompt: [
          "[SYSTEM] Git 分支管理已就绪。是否为本次 LongAgent 会话创建独立分支？",
          "回复 yes/是 启用，no/否 跳过。",
          "启用后：自动创建特性分支 → 每阶段自动提交 → 完成后合并回主分支。"
        ].join("\n"),
        mode: "ask", model, providerType, sessionId, configState,
        baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext
      })
      const answer = String(askResult.reply || "").toLowerCase().trim()
      userWantsGit = ["yes", "是", "y", "ok", "好", "确认", "开启", "启用"].some(k => answer.includes(k))
      aggregateUsage.input += askResult.usage.input || 0
      aggregateUsage.output += askResult.usage.output || 0
    }

    if (userWantsGit) {
      gitBaseBranch = await git.currentBranch(cwd)
      const branchName = git.generateBranchName(sessionId, prompt)
      const clean = await git.isClean(cwd)
      let stashed = false
      if (!clean) {
        const stashResult = await git.stash("kkcode-auto-stash-before-branch", cwd)
        stashed = stashResult.ok
      }
      const created = await git.createBranch(branchName, cwd)
      if (created.ok) {
        gitBranch = branchName
        gitActive = true
        gateStatus.git = { status: "pass", branch: branchName, baseBranch: gitBaseBranch }
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_GIT_BRANCH_CREATED,
          sessionId,
          payload: { branch: branchName, baseBranch: gitBaseBranch }
        })
        await syncState({ lastMessage: `git branch created: ${branchName}` })
      } else {
        gateStatus.git = { status: "warn", reason: created.message }
      }
      if (stashed) {
        await git.stashPop(cwd)
      }
    }
  }

  await setPhase("L1", "plan_frozen")
  currentGate = "planning"
  const planResult = await buildStagePlan({
    objective: prompt,
    intakeSummary,
    model,
    providerType,
    sessionId,
    configState,
    baseUrl,
    apiKeyEnv,
    agent,
    signal,
    defaults: {
      timeoutMs: Number(parallelConfig.task_timeout_ms || 600000),
      maxRetries: Number(parallelConfig.task_max_retries ?? 2)
    }
  })

  stagePlan = planResult.plan
  planFrozen = true
  gateStatus.plan = {
    status: planResult.errors.length ? "warn" : "pass",
    errors: planResult.errors
  }

  await EventBus.emit({
    type: EVENT_TYPES.LONGAGENT_PLAN_FROZEN,
    sessionId,
    payload: {
      planId: stagePlan.planId,
      stageCount: stagePlan.stages.length,
      errors: planResult.errors
    }
  })

  await syncState({
    stagePlan,
    planFrozen: true,
    lastMessage: `plan frozen with ${stagePlan.stages.length} stage(s)`
  })

  // --- L1.5: Scaffolding Phase ---
  const scaffoldEnabled = longagentConfig.scaffold?.enabled !== false
  if (scaffoldEnabled && stagePlan.stages.length > 0) {
    await setPhase("L1.5", "scaffolding")
    currentGate = "scaffold"
    await syncState({ lastMessage: "creating stub files for parallel agents" })

    const scaffoldResult = await runScaffoldPhase({
      objective: prompt,
      stagePlan,
      model,
      providerType,
      sessionId,
      configState,
      baseUrl,
      apiKeyEnv,
      agent,
      signal,
      toolContext
    })

    gateStatus.scaffold = {
      status: scaffoldResult.scaffolded ? "pass" : "skip",
      fileCount: scaffoldResult.fileCount,
      files: scaffoldResult.files || []
    }

    if (scaffoldResult.usage) {
      aggregateUsage.input += scaffoldResult.usage.input || 0
      aggregateUsage.output += scaffoldResult.usage.output || 0
      aggregateUsage.cacheRead += scaffoldResult.usage.cacheRead || 0
      aggregateUsage.cacheWrite += scaffoldResult.usage.cacheWrite || 0
    }
    if (scaffoldResult.toolEvents?.length) {
      toolEvents.push(...scaffoldResult.toolEvents)
    }
    if (scaffoldResult.files?.length) {
      fileChanges = mergeCappedFileChanges(
        fileChanges,
        scaffoldResult.files.map((f) => ({
          path: f, addedLines: 0, removedLines: 0, stageId: "scaffold", taskId: "scaffold"
        })),
        fileChangesLimit
      )
    }

    await syncState({ lastMessage: `scaffolded ${scaffoldResult.fileCount} file(s)` })

    await EventBus.emit({
      type: EVENT_TYPES.LONGAGENT_SCAFFOLD_COMPLETE,
      sessionId,
      payload: { fileCount: scaffoldResult.fileCount, files: scaffoldResult.files || [] }
    })
  }
  // --- End L1.5 ---

  while (stageIndex < stagePlan.stages.length) {
    const state = await LongAgentManager.get(sessionId)
    if (state?.retryStageId) {
      const targetIdx = stagePlan.stages.findIndex((stage) => stage.stageId === state.retryStageId)
      if (targetIdx >= 0) {
        stageIndex = targetIdx
        // Clear progress for target stage AND all subsequent stages
        for (let si = targetIdx; si < stagePlan.stages.length; si++) {
          const stageTasks = new Set((stagePlan.stages[si].tasks || []).map((task) => task.taskId))
          for (const taskId of Object.keys(taskProgress)) {
            if (stageTasks.has(taskId)) delete taskProgress[taskId]
          }
        }
      }
      await LongAgentManager.update(sessionId, { retryStageId: null })
    }
    if (state?.stopRequested || signal?.aborted) {
      await LongAgentManager.update(sessionId, {
        status: "stopped",
        phase: currentPhase,
        currentGate,
        gateStatus,
        lastMessage: "stop requested by user"
      })
      await markSessionStatus(sessionId, "stopped")
      break
    }

    iteration += 1
    const stage = stagePlan.stages[stageIndex]
    currentGate = `stage:${stage.stageId}`
    await setPhase("L2", `stage_running:${stage.stageId}`)

    if (maxIterations > 0 && iteration >= maxIterations && iteration % Math.max(1, maxIterations) === 0) {
      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_GATE_CHECKED,
        sessionId,
        payload: { gate: "max_iterations", status: "warn", iteration, threshold: maxIterations }
      })
    }

    await syncState({
      stageStatus: "running",
      lastMessage: `running ${stage.stageId} (${stageIndex + 1}/${stagePlan.stages.length})`
    })

    const seeded = Object.fromEntries(
      stage.tasks
        .map((task) => [task.taskId, taskProgress[task.taskId]])
        .filter(([, value]) => Boolean(value))
    )

    const stageResult = await runStageBarrier({
      stage,
      sessionId,
      config: configState.config,
      model,
      providerType,
      seedTaskProgress: seeded,
      objective: prompt,
      stageIndex,
      stageCount: stagePlan.stages.length
    })

    for (const [taskId, progress] of Object.entries(stageResult.taskProgress || {})) {
      taskProgress[taskId] = {
        ...taskProgress[taskId],
        ...progress
      }
      if (String(progress.lastReply || "").toLowerCase().includes("[task_complete]")) {
        completionMarkerSeen = true
      }
    }
    if (stageResult.completionMarkerSeen) completionMarkerSeen = true
    if (Array.isArray(stageResult.fileChanges) && stageResult.fileChanges.length) {
      fileChanges = mergeCappedFileChanges(fileChanges, stageResult.fileChanges, fileChangesLimit)
    }

    gateStatus[stage.stageId] = {
      status: stageResult.allSuccess ? "pass" : "fail",
      successCount: stageResult.successCount,
      failCount: stageResult.failCount,
      retryCount: stageResult.retryCount,
      remainingFiles: stageResult.remainingFiles
    }
    lastProgress = {
      percentage: Math.round(((stageIndex + (stageResult.allSuccess ? 1 : 0)) / Math.max(1, stagePlan.stages.length)) * 100),
      currentStep: stageIndex + (stageResult.allSuccess ? 1 : 0),
      totalSteps: stagePlan.stages.length
    }

    await syncState({
      stageStatus: stageResult.allSuccess ? "completed" : "failed",
      lastMessage: stageResult.allSuccess
        ? `stage ${stage.stageId} completed`
        : `stage ${stage.stageId} failed (${stageResult.failCount})`
    })

    // --- Git: auto-commit after successful stage ---
    if (gitActive && stageResult.allSuccess && gitConfig.auto_commit_stages !== false) {
      const commitMsg = `[kkcode] stage ${stage.stageId} completed (${stageIndex + 1}/${stagePlan.stages.length})`
      const commitResult = await git.commitAll(commitMsg, cwd)
      if (commitResult.ok && !commitResult.empty) {
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_GIT_STAGE_COMMITTED,
          sessionId,
          payload: { stageId: stage.stageId, message: commitMsg }
        })
      }
    }

    if (!stageResult.allSuccess) {
      recoveryCount += 1
      lastGateFailures = Object.values(stageResult.taskProgress || {})
        .filter((item) => item.status !== "completed")
        .map((item) => `${item.taskId}:${item.lastError || item.status}`)

      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_RECOVERY_ENTERED,
        sessionId,
        payload: {
          reason: `stage_failed:${stage.stageId}`,
          stageId: stage.stageId,
          recoveryCount,
          iteration
        }
      })

      await setPhase("L2.5", `stage_recover:${stage.stageId}`)
      currentGate = "stage_recovery"
      await syncState({
        status: "recovering",
        stageStatus: "recovering",
        lastMessage: `recovering stage ${stage.stageId}`
      })

      if (recoveryCount >= noProgressLimit) {
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_ALERT,
          sessionId,
          payload: {
            kind: "retry_storm",
            message: `stage recovery count reached ${recoveryCount}`,
            recoveryCount,
            threshold: noProgressLimit,
            iteration
          }
        })
      }

      // Circuit breaker: abort stage after max recovery attempts
      const maxStageRecoveries = Number(longagentConfig.max_stage_recoveries ?? 3)
      if (recoveryCount >= maxStageRecoveries) {
        await setPhase("L2.5", `stage_abort:${stage.stageId}`)
        await syncState({
          status: "error",
          stageStatus: "aborted",
          lastMessage: `stage ${stage.stageId} aborted after ${recoveryCount} recovery attempts`
        })
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_ALERT,
          sessionId,
          payload: {
            kind: "stage_aborted",
            message: `stage ${stage.stageId} aborted: max recoveries (${maxStageRecoveries}) exceeded`,
            recoveryCount,
            stageId: stage.stageId
          }
        })
        break
      }

      if (longagentConfig.resume_incomplete_files !== false) {
        // Reset failed tasks so runStageBarrier will re-dispatch them
        for (const [taskId, tp] of Object.entries(taskProgress)) {
          if (tp.status === "error") {
            taskProgress[taskId] = { ...tp, status: "retrying", attempt: 0 }
          }
        }
        continue
      }
      break
    }

    stageIndex += 1
    // Always checkpoint after each stage for reliable recovery
    await saveCheckpoint(sessionId, {
      name: `stage_${stage.stageId}`,
      iteration,
      currentPhase,
      currentGate,
      recoveryCount,
      gateStatus,
      taskProgress,
      stageIndex,
      stagePlan,
      planFrozen,
      lastProgress
    })
  }

  if (stagePlan && stageIndex >= stagePlan.stages.length) {
    // --- Gate preference prompt (first run only) ---
    const gatesConfig = longagentConfig.usability_gates || {}
    const shouldPromptGates = gatesConfig.prompt_user === "first_run" || gatesConfig.prompt_user === "always"
    if (shouldPromptGates && allowQuestion) {
      const hasPrefs = await hasGatePreferences()
      if (!hasPrefs || gatesConfig.prompt_user === "always") {
        const gateAskResult = await processTurnLoop({
          prompt: buildGatePromptText(),
          mode: "ask", model, providerType, sessionId, configState,
          baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext
        })
        const gatePrefs = parseGateSelection(gateAskResult.reply)
        await saveGatePreferences(gatePrefs)
        // Apply preferences to runtime config
        for (const [gate, enabled] of Object.entries(gatePrefs)) {
          if (configState.config.agent.longagent.usability_gates[gate]) {
            configState.config.agent.longagent.usability_gates[gate].enabled = enabled
          }
        }
        aggregateUsage.input += gateAskResult.usage.input || 0
        aggregateUsage.output += gateAskResult.usage.output || 0
      } else {
        // Apply saved preferences
        const savedPrefs = await getGatePreferences()
        if (savedPrefs) {
          for (const [gate, enabled] of Object.entries(savedPrefs)) {
            if (configState.config.agent.longagent.usability_gates[gate]) {
              configState.config.agent.longagent.usability_gates[gate].enabled = enabled
            }
          }
        }
      }
    }

    if (!completionMarkerSeen) {
      const markerTurn = await processTurnLoop({
        prompt: [
          `Objective: ${prompt}`,
          "All planned stages are done. Validate if the task is truly complete.",
          "If complete, include [TASK_COMPLETE] exactly once."
        ].join("\n"),
        mode: "agent",
        model,
        providerType,
        sessionId,
        configState,
        baseUrl,
        apiKeyEnv,
        agent,
        signal,
        allowQuestion: plannerConfig.ask_user_after_plan_frozen === true && allowQuestion,
        toolContext
      })
      finalReply = markerTurn.reply
      aggregateUsage.input += markerTurn.usage.input || 0
      aggregateUsage.output += markerTurn.usage.output || 0
      aggregateUsage.cacheRead += markerTurn.usage.cacheRead || 0
      aggregateUsage.cacheWrite += markerTurn.usage.cacheWrite || 0
      toolEvents.push(...markerTurn.toolEvents)
      completionMarkerSeen = isComplete(markerTurn.reply)
      gateStatus.completionMarker = {
        status: completionMarkerSeen ? "pass" : "warn",
        reason: completionMarkerSeen ? "completion marker confirmed" : "marker missing"
      }
    } else {
      gateStatus.completionMarker = {
        status: "pass",
        reason: "completion marker present in stage outputs"
      }
    }

    let gateAttempt = 0
    while (gateAttempt < maxGateAttempts) {
      if (signal?.aborted) break
      const preState = await LongAgentManager.get(sessionId)
      if (preState?.stopRequested) break

      gateAttempt += 1
      currentGate = "usability_gates"
      await setPhase("L3", "usability-gate-check")
      const gateResult = await runUsabilityGates({
        sessionId,
        config: configState.config,
        cwd: process.cwd(),
        iteration
      })
      gateStatus.usability = gateResult.gates

      if (gateResult.allPass && completionMarkerSeen) {
        await LongAgentManager.update(sessionId, {
          status: "completed",
          phase: currentPhase,
          currentGate,
          gateStatus,
          recoveryCount,
          lastGateFailures: [],
          iterations: iteration,
          lastMessage: "parallel stages and usability gates passed"
        })
        await markSessionStatus(sessionId, "completed")
        break
      }

      const failureSummary = summarizeGateFailures(gateResult.failures)
      lastGateFailures = gateResult.failures.map((item) => `${item.gate}:${item.reason}`)
      recoveryCount += 1

      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_RECOVERY_ENTERED,
        sessionId,
        payload: {
          reason: `usability_gates_failed:${failureSummary || "unknown"}`,
          gateAttempt,
          recoveryCount,
          iteration
        }
      })

      await setPhase("L2.5", "gate_recovery")
      currentGate = "gate_recovery"
      await syncState({
        status: "recovering",
        stageStatus: "gate_recovery",
        lastMessage: `gate recovery #${gateAttempt}: ${failureSummary || "unknown"}`
      })

      const remediation = await processTurnLoop({
        prompt: [
          `Objective: ${prompt}`,
          "Usability gates failed.",
          `Failures: ${failureSummary || "unknown"}`,
          "Apply fixes, then include [TASK_COMPLETE] when fully usable."
        ].join("\n"),
        mode: "agent",
        model,
        providerType,
        sessionId,
        configState,
        baseUrl,
        apiKeyEnv,
        agent,
        signal,
        allowQuestion: false,
        toolContext
      })
      finalReply = remediation.reply
      aggregateUsage.input += remediation.usage.input || 0
      aggregateUsage.output += remediation.usage.output || 0
      aggregateUsage.cacheRead += remediation.usage.cacheRead || 0
      aggregateUsage.cacheWrite += remediation.usage.cacheWrite || 0
      toolEvents.push(...remediation.toolEvents)
      if (isComplete(remediation.reply)) {
        completionMarkerSeen = true
      }
    }

    // If gate loop exhausted without success, mark as failed
    const postGateState = await LongAgentManager.get(sessionId)
    if (postGateState?.status !== "completed" && gateAttempt >= maxGateAttempts) {
      await LongAgentManager.update(sessionId, {
        status: "failed",
        phase: currentPhase,
        currentGate,
        gateStatus,
        recoveryCount,
        lastGateFailures,
        iterations: iteration,
        lastMessage: `max gate recovery attempts (${maxGateAttempts}) exceeded`
      })
      await markSessionStatus(sessionId, "failed")
    }
  }

  // --- Git: final commit + merge back to base branch ---
  if (gitActive && gitBaseBranch && gitBranch) {
    try {
      await git.commitAll(`[kkcode] longagent session ${sessionId} completed`, cwd)
      if (gitConfig.auto_merge !== false) {
        const doneState = await LongAgentManager.get(sessionId)
        if (doneState?.status === "completed") {
          await git.checkoutBranch(gitBaseBranch, cwd)
          const mergeResult = await git.mergeBranch(gitBranch, cwd)
          if (mergeResult.ok) {
            await git.deleteBranch(gitBranch, cwd)
            gateStatus.git = { ...gateStatus.git, merged: true, mergeMessage: mergeResult.message }
            await EventBus.emit({
              type: EVENT_TYPES.LONGAGENT_GIT_MERGED,
              sessionId,
              payload: { branch: gitBranch, baseBranch: gitBaseBranch, merged: true }
            })
          } else {
            gateStatus.git = { ...gateStatus.git, merged: false, mergeError: mergeResult.message }
            // Rollback: return to feature branch so user can resolve manually
            const rollback = await git.checkoutBranch(gitBranch, cwd)
            if (!rollback.ok) {
              gateStatus.git = { ...gateStatus.git, rollbackFailed: true, rollbackError: rollback.message }
            }
          }
        }
      }
    } catch (gitErr) {
      gateStatus.git = { ...gateStatus.git, error: gitErr.message }
      // Best-effort: try to return to feature branch
      try { await git.checkoutBranch(gitBranch, cwd) } catch { /* already on it or unrecoverable */ }
    }
  }

  const done = await LongAgentManager.get(sessionId)
  const totalElapsed = Math.round((Date.now() - startTime) / 1000)
  const stats = stageProgressStats(taskProgress)

  return {
    sessionId,
    turnId: `turn_long_${Date.now()}`,
    reply: finalReply || done?.lastMessage || "longagent stopped",
    usage: aggregateUsage,
    toolEvents,
    iterations: iteration,
    recoveryCount,
    phase: done?.phase || currentPhase,
    gateStatus: done?.gateStatus || gateStatus,
    currentGate: done?.currentGate || currentGate,
    lastGateFailures: done?.lastGateFailures || lastGateFailures,
    status: done?.status || "unknown",
    progress: lastProgress,
    elapsed: totalElapsed,
    stageIndex,
    stageCount: stagePlan?.stages?.length || 0,
    currentStageId: stagePlan?.stages?.[Math.min(stageIndex, (stagePlan?.stages?.length || 1) - 1)]?.stageId || null,
    planFrozen,
    taskProgress,
    fileChanges,
    stageProgress: {
      done: stats.done,
      total: stats.total
    },
    remainingFilesCount: stats.remainingFilesCount
  }
}

async function runLegacyLongAgent({
  prompt,
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  agent = null,
  maxIterations = 0,
  signal = null,
  fromCheckpoint = null,
  output = null,
  allowQuestion = true,
  toolContext = {}
}) {
  const longagentConfig = configState.config.agent.longagent || {}
  const noProgressWarning = Number(longagentConfig.no_progress_warning || 3)
  const noProgressLimit = Number(longagentConfig.no_progress_limit || 5)
  const heartbeatTimeoutMs = Number(longagentConfig.heartbeat_timeout_ms || 120000)
  const checkpointInterval = Number(longagentConfig.checkpoint_interval || 5)
  const retryStormThreshold = Number(longagentConfig.retry_storm_threshold || DEFAULT_LONGAGENT_RETRY_STORM_THRESHOLD)
  const tokenAlertThreshold = Number(longagentConfig.token_alert_threshold || DEFAULT_LONGAGENT_TOKEN_ALERT_THRESHOLD)

  let iteration = 0
  let noProgressCount = 0
  let recoveryCount = 0
  let currentPhase = "L0"
  let currentPrompt = prompt
  let finalReply = ""
  let previousReplyNormalized = ""
  let lastProgress = { percentage: null, currentStep: null, totalSteps: null }
  let gateStatus = {}
  let currentGate = "execution"
  let lastGateFailures = []
  const aggregateUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const toolEvents = []
  const startTime = Date.now()
  const lastAlertAtIteration = new Map()

  function shouldEmitAlert(key, every = 1) {
    const prev = Number(lastAlertAtIteration.get(key) || 0)
    if (iteration - prev < Math.max(1, every)) return false
    lastAlertAtIteration.set(key, iteration)
    return true
  }

  async function emitAlert(kind, message, payload = {}, every = 1) {
    if (!shouldEmitAlert(kind, every)) return
    await EventBus.emit({
      type: EVENT_TYPES.LONGAGENT_ALERT,
      sessionId,
      payload: {
        kind,
        message,
        iteration,
        phase: currentPhase,
        ...payload
      }
    })
  }

  async function saveRuntimeCheckpoint(name = "latest") {
    await saveCheckpoint(sessionId, {
      name,
      iteration,
      noProgressCount,
      recoveryCount,
      currentPhase,
      currentPrompt,
      previousReplyNormalized,
      lastProgress,
      gateStatus,
      currentGate,
      lastGateFailures
    })
  }

  async function setPhase(nextPhase, reason) {
    if (currentPhase === nextPhase) return
    const prevPhase = currentPhase
    currentPhase = nextPhase
    await EventBus.emit({
      type: EVENT_TYPES.LONGAGENT_PHASE_CHANGED,
      sessionId,
      payload: { prevPhase, nextPhase, reason, iteration }
    })
  }

  async function enterRecovery(reason) {
    recoveryCount += 1
    const checkpoint = await loadCheckpoint(sessionId, "latest")
    lastGateFailures = [reason]
    gateStatus = {
      ...gateStatus,
      lastRecoveryReason: reason,
      recoveryCount
    }
    await saveRuntimeCheckpoint(`recovery_${recoveryCount}`)
    currentPrompt = buildRecoveryPrompt(prompt, finalReply, iteration, reason, lastProgress, checkpoint)
    noProgressCount = 0
    currentGate = "recovery"
    await setPhase("L0", `recovery:${reason}`)
    await LongAgentManager.update(sessionId, {
      status: "recovering",
      phase: currentPhase,
      gateStatus,
      currentGate,
      recoveryCount,
      lastGateFailures,
      heartbeatAt: Date.now(),
      lastMessage: `recovery #${recoveryCount}: ${reason}`,
      iterations: iteration,
      noProgressCount
    })
    await EventBus.emit({
      type: EVENT_TYPES.LONGAGENT_RECOVERY_ENTERED,
      sessionId,
      payload: { reason, iteration, recoveryCount }
    })
    await emitAlert("recovery_entered", `entered recovery (${reason})`, { recoveryCount }, 1)
    await markSessionStatus(sessionId, "running-longagent")
  }

  if (fromCheckpoint) {
    const cp = await loadCheckpoint(sessionId, fromCheckpoint)
    if (cp) {
      iteration = cp.iteration || 0
      noProgressCount = cp.noProgressCount || 0
      recoveryCount = cp.recoveryCount || 0
      currentPhase = cp.currentPhase || "L0"
      currentPrompt = cp.currentPrompt || prompt
      previousReplyNormalized = cp.previousReplyNormalized || ""
      lastProgress = cp.lastProgress || lastProgress
      gateStatus = cp.gateStatus || {}
      currentGate = cp.currentGate || currentGate
      lastGateFailures = cp.lastGateFailures || []
    }
  }

  await LongAgentManager.update(sessionId, {
    status: "running",
    phase: currentPhase,
    gateStatus,
    currentGate,
    recoveryCount,
    stopRequested: false,
    iterations: iteration,
    heartbeatAt: Date.now(),
    lastMessage: fromCheckpoint ? `resumed from checkpoint (iteration ${iteration})` : "longagent started",
    noProgressCount,
    progress: lastProgress
  })
  await markSessionStatus(sessionId, "running-longagent")

  if (!isLikelyActionableObjective(prompt)) {
    const blocked = "LongAgent 需要明确的编码目标。请直接描述要实现/修复的内容、涉及文件或验收标准。"
    await LongAgentManager.update(sessionId, {
      status: "blocked",
      phase: "L0",
      currentGate: "execution",
      gateStatus: {
        intake: {
          status: "blocked",
          reason: "objective_not_actionable"
        }
      },
      lastMessage: blocked
    })
    await markSessionStatus(sessionId, "active")
    return {
      sessionId,
      turnId: `turn_long_${Date.now()}`,
      reply: blocked,
      usage: aggregateUsage,
      toolEvents,
      iterations: 0,
      emittedText: false,
      context: null,
      status: "blocked",
      phase: "L0",
      gateStatus: { intake: { status: "blocked", reason: "objective_not_actionable" } },
      currentGate: "execution",
      lastGateFailures: [],
      recoveryCount: 0,
      progress: { percentage: null, currentStep: null, totalSteps: null },
      elapsed: 0
    }
  }

  while (true) {
    const state = await LongAgentManager.get(sessionId)
    if (state?.stopRequested || signal?.aborted) {
      await saveRuntimeCheckpoint("stopped")
      await LongAgentManager.update(sessionId, {
        status: "stopped",
        phase: currentPhase,
        gateStatus,
        currentGate,
        recoveryCount,
        lastGateFailures,
        lastMessage: "stop requested by user"
      })
      await markSessionStatus(sessionId, "stopped")
      break
    }

    const staleHeartbeat = state?.heartbeatAt && Date.now() - state.heartbeatAt > heartbeatTimeoutMs
    if (staleHeartbeat) {
      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_GATE_CHECKED,
        sessionId,
        payload: { gate: "heartbeat", status: "warn", thresholdMs: heartbeatTimeoutMs, iteration }
      })
      await emitAlert("heartbeat_timeout", `heartbeat timeout (${heartbeatTimeoutMs}ms)`)
      await enterRecovery(`heartbeat_timeout(${heartbeatTimeoutMs}ms)`)
      continue
    }

    iteration += 1
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    const progressLabel = lastProgress.percentage !== null ? `${lastProgress.percentage}%` : "..."

    if (iteration <= 1) await setPhase("L0", "bootstrap")
    else await setPhase("L1", "execution")

    if (maxIterations > 0 && iteration >= maxIterations && iteration % Math.max(1, maxIterations) === 0) {
      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_GATE_CHECKED,
        sessionId,
        payload: { gate: "max_iterations", status: "warn", iteration, threshold: maxIterations }
      })
      await emitAlert("max_iterations_warn", `iteration reached warning threshold ${maxIterations}`, { maxIterations }, maxIterations)
    }

    await LongAgentManager.update(sessionId, {
      status: "running",
      phase: currentPhase,
      gateStatus,
      currentGate,
      recoveryCount,
      lastGateFailures,
      iterations: iteration,
      heartbeatAt: Date.now(),
      lastMessage: `iteration ${iteration}${maxIterations > 0 ? "/" + maxIterations : ""} | phase=${currentPhase} | gate=${currentGate} | progress: ${progressLabel} | elapsed: ${elapsed}s`,
      noProgressCount,
      progress: lastProgress
    })
    await EventBus.emit({
      type: EVENT_TYPES.LONGAGENT_HEARTBEAT,
      sessionId,
      payload: {
        iteration,
        maxIterations,
        noProgressCount,
        progress: lastProgress,
        elapsed,
        phase: currentPhase,
        gate: currentGate
      }
    })

    if (typeof output?.write === "function") {
      output.write(`\n--- Iteration ${iteration}${maxIterations > 0 ? "/" + maxIterations : ""} | phase=${currentPhase} | gate=${currentGate} | progress: ${progressLabel} | elapsed: ${elapsed}s ---\n`)
    }

    const turn = await processTurnLoop({
      prompt: currentPrompt,
      mode: "agent",
      model,
      providerType,
      sessionId,
      configState,
      baseUrl,
      apiKeyEnv,
      agent,
      signal,
      output,
      allowQuestion,
      toolContext
    })

    finalReply = turn.reply
    aggregateUsage.input += turn.usage.input || 0
    aggregateUsage.output += turn.usage.output || 0
    aggregateUsage.cacheRead += turn.usage.cacheRead || 0
    aggregateUsage.cacheWrite += turn.usage.cacheWrite || 0
    toolEvents.push(...turn.toolEvents)

    const progressDetection = detectProgress(turn.reply, previousReplyNormalized)
    if (progressDetection.structured.hasStructuredSignal) {
      lastProgress = {
        percentage: progressDetection.structured.percentage ?? lastProgress.percentage,
        currentStep: progressDetection.structured.currentStep ?? lastProgress.currentStep,
        totalSteps: progressDetection.structured.totalSteps ?? lastProgress.totalSteps
      }
    }

    if (progressDetection.hasProgress) {
      noProgressCount = 0
      gateStatus = { ...gateStatus, progress: "pass" }
    } else {
      noProgressCount += 1
      gateStatus = { ...gateStatus, progress: "warn" }
    }
    previousReplyNormalized = normalizeReply(turn.reply)

    const totalTokens = aggregateUsage.input + aggregateUsage.output
    if (totalTokens >= tokenAlertThreshold) {
      await emitAlert(
        "token_pressure",
        `high token usage (${totalTokens})`,
        { totalTokens, threshold: tokenAlertThreshold },
        3
      )
    }
    if (recoveryCount >= retryStormThreshold) {
      await emitAlert(
        "retry_storm",
        `recovery entered ${recoveryCount} times`,
        { recoveryCount, threshold: retryStormThreshold },
        2
      )
    }

    if (isComplete(turn.reply)) {
      currentGate = "usability_gates"
      await setPhase("L2", "usability-gate-check")
      const gateResult = await runUsabilityGates({
        sessionId,
        config: configState.config,
        cwd: process.cwd(),
        iteration
      })
      gateStatus = gateResult.gates

      if (gateResult.allPass) {
        gateStatus = {
          ...gateStatus,
          completionMarker: { status: "pass", reason: "completion marker confirmed by gates" }
        }
        await setPhase("L3", "completion-marker")
        await LongAgentManager.update(sessionId, {
          status: "completed",
          phase: currentPhase,
          gateStatus,
          currentGate,
          recoveryCount,
          lastGateFailures: [],
          heartbeatAt: Date.now(),
          lastMessage: "completion marker detected and usability gates passed",
          noProgressCount,
          progress: lastProgress
        })
        await markSessionStatus(sessionId, "completed")
        break
      }

      const failureSummary = summarizeGateFailures(gateResult.failures)
      lastGateFailures = gateResult.failures.map((item) => `${item.gate}:${item.reason}`)
      await emitAlert(
        "gate_failed",
        `usability gates failed: ${failureSummary}`,
        { failures: gateResult.failures },
        1
      )
      await enterRecovery(`usability_gates_failed(${failureSummary || "unknown"})`)
      continue
    }

    if (noProgressCount >= noProgressLimit) {
      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_GATE_CHECKED,
        sessionId,
        payload: { gate: "progress", status: "warn", noProgressCount, limit: noProgressLimit, iteration }
      })
      await emitAlert(
        "no_progress_limit",
        `no progress limit reached (${noProgressCount}/${noProgressLimit})`,
        { noProgressCount, noProgressLimit }
      )
      await enterRecovery(`no_progress_limit(${noProgressCount}/${noProgressLimit})`)
      continue
    }

    if (noProgressCount >= noProgressWarning) {
      if (noProgressCount === noProgressWarning || noProgressCount % noProgressWarning === 0) {
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_GATE_CHECKED,
          sessionId,
          payload: {
            gate: "progress",
            status: "warn",
            noProgressCount,
            warningThreshold: noProgressWarning,
            iteration
          }
        })
      }
    }

    if (checkpointInterval > 0 && iteration % checkpointInterval === 0) {
      await saveRuntimeCheckpoint(`cp_${iteration}`)
    }

    currentGate = "execution"
    currentPrompt = buildNextPrompt(prompt, turn.reply, iteration, lastProgress)
  }

  const done = await LongAgentManager.get(sessionId)
  const totalElapsed = Math.round((Date.now() - startTime) / 1000)
  await EventBus.emit({
    type: EVENT_TYPES.LONGAGENT_ALERT,
    sessionId,
    payload: {
      kind: "summary",
      message: `LongAgent ${done?.status || "unknown"} | ${iteration} iterations | ${totalElapsed}s`,
      iteration,
      elapsed: totalElapsed
    }
  })
  return {
    sessionId,
    turnId: `turn_long_${Date.now()}`,
    reply: finalReply || done?.lastMessage || "longagent stopped",
    usage: aggregateUsage,
    toolEvents,
    iterations: iteration,
    recoveryCount,
    phase: done?.phase || currentPhase,
    gateStatus: done?.gateStatus || gateStatus,
    currentGate: done?.currentGate || currentGate,
    lastGateFailures: done?.lastGateFailures || lastGateFailures,
    status: done?.status || "unknown",
    progress: lastProgress,
    elapsed: totalElapsed
  }
}

export async function runLongAgent(args) {
  const longagentConfig = args?.configState?.config?.agent?.longagent || {}
  const parallelEnabled = longagentConfig.parallel?.enabled === true
  if (parallelEnabled) {
    return runParallelLongAgent(args)
  }
  return runLegacyLongAgent(args)
}
