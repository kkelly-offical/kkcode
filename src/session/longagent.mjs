import { LongAgentManager } from "../orchestration/longagent-manager.mjs"
import { processTurnLoop } from "./loop.mjs"
import { markSessionStatus } from "./store.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { run4StageLongAgent } from "./longagent-4stage.mjs"
import { runHybridLongAgent } from "./longagent-hybrid.mjs"
import {
  isComplete,
  isLikelyActionableObjective,
  mergeCappedFileChanges,
  stageProgressStats,
  summarizeGateFailures,
  LONGAGENT_FILE_CHANGES_LIMIT,
  createStuckTracker
} from "./longagent-utils.mjs"
import { saveCheckpoint, loadCheckpoint, cleanupCheckpoints } from "./checkpoint.mjs"
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
import { createValidator } from "./task-validator.mjs"
import * as git from "../util/git.mjs"

async function runParallelLongAgent({
  prompt,
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  agent = null,
  maxIterations: maxIterationsParam = 0,
  signal = null,
  output = null,
  allowQuestion = true,
  toolContext = {}
}) {
  const longagentConfig = configState.config.agent.longagent || {}
  const maxIterations = Number(longagentConfig.max_iterations || maxIterationsParam)
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
      try {
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
      } finally {
        if (stashed) {
          await git.stashPop(cwd).catch(() => {})
        }
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

  let priorContext = ""
  const seenFilePaths = new Set() // #3 去重：跨阶段文件路径去重，避免 priorContext 重复提及

  while (stageIndex < stagePlan.stages.length) {
    const state = await LongAgentManager.get(sessionId)
    if (state?.retryStageId) {
      const targetIdx = stagePlan.stages.findIndex((stage) => stage.stageId === state.retryStageId)
      // Atomically clear retryStageId to prevent race with concurrent updates
      await LongAgentManager.update(sessionId, { retryStageId: null })
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

    // #4 计划锚点 — 每个阶段执行前重建，确保模型始终看到完整计划和当前进度
    const stageStatuses = stagePlan.stages.map((s, i) => {
      const marker = i < stageIndex ? "✓" : i === stageIndex ? "→" : " "
      return `[${marker}] 阶段${i + 1}: ${s.name || s.stageId}`
    }).join("\n")
    const planAnchor = `## 计划锚点\n目标: ${stagePlan.objective || prompt}\n进度: ${stageIndex + 1}/${stagePlan.stages.length}\n${stageStatuses}\n\n`

    const stageResult = await runStageBarrier({
      stage,
      sessionId,
      config: configState.config,
      model,
      providerType,
      seedTaskProgress: seeded,
      objective: prompt,
      stageIndex,
      stageCount: stagePlan.stages.length,
      priorContext: planAnchor + priorContext
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

    // #1 阶段级压缩 + #3 去重 — 结构化阶段摘要，文件路径跨阶段去重
    const taskSummaries = Object.values(stageResult.taskProgress || {})
      .filter(t => t.lastReply)
      .map(t => `  - [${t.taskId}] ${t.status}: ${t.lastReply.slice(0, 250)}`)
    const stageFiles = (stageResult.fileChanges || [])
      .map(f => (typeof f === "string" ? f : (f.path || f.file || "")))
      .filter(Boolean)
    const newFiles = stageFiles.filter(f => !seenFilePaths.has(f))
    newFiles.forEach(f => seenFilePaths.add(f))
    if (taskSummaries.length || newFiles.length) {
      const fileNote = newFiles.length ? `\n  新增/修改文件: ${newFiles.join(", ")}` : ""
      const failNote = !stageResult.allSuccess ? `\n  失败任务数: ${stageResult.failCount}` : ""
      priorContext += `### 阶段${stageIndex + 1}: ${stage.name || stage.stageId} (${stageResult.allSuccess ? "PASS" : "FAIL"})${failNote}\n${taskSummaries.join("\n")}${fileNote}\n\n`
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
      // Exponential backoff before retry
      const backoffMs = Math.min(1000 * 2 ** (recoveryCount - 1), 30000)
      await new Promise(r => setTimeout(r, backoffMs))
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
    recoveryCount = 0  // reset per-stage recovery counter after successful stage
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

    // --- Structured completion verification ---
    const validationLevel = longagentConfig.validation_level || "standard"
    let validationReport = null
    try {
      const validator = await createValidator({ cwd, configState })
      validationReport = await validator.validate({ todoState: toolContext?._todoState, level: validationLevel })
      gateStatus.validation = {
        status: validationReport.verdict === "BLOCK" ? "fail" : "pass",
        verdict: validationReport.verdict,
        reason: validationReport.verdict === "APPROVE"
          ? "all checks passed"
          : `${validationReport.results.filter(r => !r.passed).length} check(s) failed`
      }
    } catch (valErr) {
      gateStatus.validation = { status: "warn", reason: `validation skipped: ${valErr.message}` }
    }

    const validationContext = validationReport
      ? `\n\nVerification Report:\n${validationReport.message}`
      : ""

    if (!completionMarkerSeen) {
      const markerTurn = await processTurnLoop({
        prompt: [
          `Objective: ${prompt}`,
          "All planned stages are done.",
          validationContext,
          validationReport?.verdict === "BLOCK"
            ? "Verification found critical issues. Fix them, then include [TASK_COMPLETE]."
            : "Validate if the task is truly complete. If complete, include [TASK_COMPLETE] exactly once."
        ].filter(Boolean).join("\n"),
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
      // Use gate-specific backoff (not shared recoveryCount) to avoid over-aggressive delays
      const gateBackoffMs = Math.min(1000 * 2 ** (gateAttempt - 1), 30000)
      await new Promise(r => setTimeout(r, gateBackoffMs))

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

      // Re-run validation to give remediation agent fresh context
      let remediationContext = ""
      try {
        const reValidator = await createValidator({ cwd, configState })
        const reReport = await reValidator.validate({ todoState: toolContext?._todoState, level: validationLevel })
        remediationContext = `\n\nCurrent Verification:\n${reReport.message}`
      } catch { /* skip */ }

      const remediation = await processTurnLoop({
        prompt: [
          `Objective: ${prompt}`,
          "Usability gates failed.",
          `Failures: ${failureSummary || "unknown"}`,
          remediationContext,
          "Fix ALL failing checks, then include [TASK_COMPLETE] when fully usable."
        ].filter(Boolean).join("\n"),
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
        // Hold state lock during read-status → merge to prevent TOCTOU race
        await LongAgentManager.withLock(async () => {
          const doneState = await LongAgentManager.get(sessionId)
          if (doneState?.status !== "completed") return
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
            await EventBus.emit({
              type: EVENT_TYPES.LONGAGENT_ALERT,
              sessionId,
              payload: {
                kind: "git_merge_failed",
                message: `Git merge failed: ${mergeResult.message}. Staying on branch "${gitBranch}" — resolve conflicts manually.`
              }
            })
            const rollback = await git.checkoutBranch(gitBranch, cwd)
            if (!rollback.ok) {
              gateStatus.git = { ...gateStatus.git, rollbackFailed: true, rollbackError: rollback.message }
            }
          }
        }, cwd)
      }
    } catch (gitErr) {
      gateStatus.git = { ...gateStatus.git, error: gitErr.message }
      // Best-effort: try to return to feature branch
      try { await git.checkoutBranch(gitBranch, cwd) } catch { /* already on it or unrecoverable */ }
    }
  }

  // Checkpoint cleanup (same as hybrid mode)
  try {
    const cleanResult = await cleanupCheckpoints(sessionId, {
      maxKeep: 10,
      keepStageCheckpoints: true
    })
  } catch (cleanupErr) {
    console.warn(`[kkcode] checkpoint cleanup failed for session ${sessionId}: ${cleanupErr.message}`)
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


export async function runLongAgent(args) {
  const longagentConfig = args?.configState?.config?.agent?.longagent || {}
  // Runtime impl override (set via /longagent 4stage or /longagent hybrid)
  if (args?.longagentImpl === "4stage") {
    return run4StageLongAgent(args)
  }
  if (args?.longagentImpl === "hybrid") {
    return runHybridLongAgent(args)
  }
  // Hybrid mode (default): Preview → Blueprint → Git → Scaffold → Coding(并行) → Debugging(回滚) → Gates → GitMerge
  if (longagentConfig.hybrid?.enabled !== false) {
    return runHybridLongAgent(args)
  }
  // 4-stage mode: Preview → Blueprint → Coding → Debugging (Mark 研究用)
  if (longagentConfig.four_stage?.enabled === true) {
    return run4StageLongAgent(args)
  }
  // Parallel mode: 降级策略
  return runParallelLongAgent(args)
}
