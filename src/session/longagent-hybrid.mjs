/**
 * LongAgent Hybrid 模式
 * 融合 4-Stage 的只读探索/规划/调试回滚 + Parallel 的脚手架/并行执行/门控
 *
 * 流程: H1:Preview → H2:Blueprint → H2.5:Git → H3:Scaffold → H4:Coding(并行) → H5:Debugging(回滚) → H6:Gates → H7:GitMerge
 */
import { LongAgentManager } from "../orchestration/longagent-manager.mjs"
import { processTurnLoop } from "./loop.mjs"
import { markSessionStatus } from "./store.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES, LONGAGENT_4STAGE_STAGES } from "../core/constants.mjs"
import { saveCheckpoint } from "./checkpoint.mjs"
import { getAgent } from "../agent/agent.mjs"
import { runStageBarrier } from "../orchestration/stage-scheduler.mjs"
import { runScaffoldPhase } from "./longagent-scaffold.mjs"
import {
  runUsabilityGates,
  hasGatePreferences,
  getGatePreferences,
  saveGatePreferences,
  buildGatePromptText,
  parseGateSelection
} from "./usability-gates.mjs"
import { validateAndNormalizeStagePlan, defaultStagePlan } from "./longagent-plan.mjs"
import { createValidator } from "./task-validator.mjs"
import { detectStageComplete, detectReturnToCoding, buildStageWrapper } from "./longagent-4stage.mjs"
import {
  isComplete,
  isLikelyActionableObjective,
  mergeCappedFileChanges,
  stageProgressStats,
  summarizeGateFailures,
  LONGAGENT_FILE_CHANGES_LIMIT
} from "./longagent-utils.mjs"
import * as git from "../util/git.mjs"

function stripFence(text = "") {
  const raw = String(text || "").trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced ? fenced[1].trim() : raw
}

function parseJsonLoose(text = "") {
  const raw = stripFence(text)
  try { return JSON.parse(raw) } catch { /* ignore */ }
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch { /* ignore */ }
  }
  return null
}

function parseBlueprintOutput(reply, objective, defaults) {
  // 1. 尝试提取 ```stage_plan_json ... ``` 块
  const jsonMatch = reply.match(/```stage_plan_json\s*([\s\S]*?)```/)
  if (jsonMatch) {
    const parsed = parseJsonLoose(jsonMatch[1])
    if (parsed?.stages) {
      const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
      if (!errors.length) {
        return { architectureText: reply.replace(/```stage_plan_json[\s\S]*?```/g, "").trim(), stagePlan: plan }
      }
    }
  }
  // 2. 回退：尝试任意 JSON 块
  const anyJson = reply.match(/```(?:json)?\s*([\s\S]*?)```/g)
  if (anyJson) {
    for (const block of anyJson) {
      const inner = block.replace(/```(?:json|stage_plan_json)?\s*/g, "").replace(/```/g, "").trim()
      const parsed = parseJsonLoose(inner)
      if (parsed?.stages) {
        const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
        if (!errors.length) return { architectureText: reply, stagePlan: plan }
      }
    }
  }
  // 3. 最终回退：单任务默认计划
  return { architectureText: reply, stagePlan: defaultStagePlan(objective, defaults) }
}

export async function runHybridLongAgent({
  prompt, model, providerType, sessionId, configState,
  baseUrl = null, apiKeyEnv = null, agent = null,
  maxIterations = 0, signal = null, output = null,
  allowQuestion = true, toolContext = {}
}) {
  const longagentConfig = configState.config.agent.longagent || {}
  const hybridConfig = longagentConfig.hybrid || {}
  const parallelConfig = longagentConfig.parallel || {}
  const gitConfig = longagentConfig.git || {}
  const noProgressLimit = Number(longagentConfig.no_progress_limit || 5)
  const maxGateAttempts = Number(longagentConfig.max_gate_attempts || 5)
  const fileChangesLimit = Math.max(20, Number(longagentConfig.file_changes_limit || LONGAGENT_FILE_CHANGES_LIMIT))

  // 每阶段模型选择
  const separateModels = hybridConfig.separate_models || {}
  const useSeparateModels = separateModels.enabled === true
  function getModelForStage(stage) {
    if (!useSeparateModels) return { model, providerType }
    const m = { preview: separateModels.preview_model, blueprint: separateModels.blueprint_model, debugging: separateModels.debugging_model }
    return m[stage] ? { model: m[stage], providerType } : { model, providerType }
  }

  let iteration = 0, recoveryCount = 0, stageIndex = 0
  let currentPhase = "H0", currentGate = "init"
  let gateStatus = {}, lastGateFailures = []
  let lastProgress = { percentage: 0, currentStep: 0, totalSteps: 0 }
  let finalReply = "", planFrozen = false, stagePlan = null
  let taskProgress = {}, fileChanges = []
  let completionMarkerSeen = false
  let gitBranch = null, gitBaseBranch = null, gitActive = false
  const aggregateUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const toolEvents = []
  const startTime = Date.now()

  function accumulateUsage(turn) {
    aggregateUsage.input += turn.usage?.input || 0
    aggregateUsage.output += turn.usage?.output || 0
    aggregateUsage.cacheRead += turn.usage?.cacheRead || 0
    aggregateUsage.cacheWrite += turn.usage?.cacheWrite || 0
    if (turn.toolEvents?.length) toolEvents.push(...turn.toolEvents)
  }

  async function setPhase(next, reason = "") {
    if (currentPhase === next) return
    const prev = currentPhase
    currentPhase = next
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_PHASE_CHANGED, sessionId, payload: { prevPhase: prev, nextPhase: next, reason, iteration } })
  }

  async function syncState(patch = {}) {
    const stats = stageProgressStats(taskProgress)
    await LongAgentManager.update(sessionId, {
      status: patch.status || "running", phase: currentPhase, gateStatus, currentGate,
      recoveryCount, lastGateFailures, iterations: iteration, heartbeatAt: Date.now(),
      progress: lastProgress, planFrozen, stageIndex,
      stageCount: stagePlan?.stages?.length || 0,
      taskProgress, stageProgress: { done: stats.done, total: stats.total },
      remainingFilesCount: stats.remainingFilesCount,
      ...patch
    })
  }

  await markSessionStatus(sessionId, "running-longagent")
  await syncState({ status: "running", lastMessage: "hybrid mode started" })

  // 前置检查
  if (!isLikelyActionableObjective(prompt)) {
    const blocked = "LongAgent 需要明确的编码目标。请直接描述要实现/修复的内容。"
    await LongAgentManager.update(sessionId, { status: "blocked", phase: "H0", lastMessage: blocked })
    await markSessionStatus(sessionId, "active")
    return { sessionId, turnId: `turn_long_${Date.now()}`, reply: blocked, usage: aggregateUsage, toolEvents, iterations: 0, status: "blocked", phase: "H0", gateStatus: {}, currentGate: "init", lastGateFailures: [], recoveryCount: 0, progress: lastProgress, elapsed: 0, stageIndex: 0, stageCount: 0, planFrozen: false, taskProgress: {}, fileChanges: [], stageProgress: { done: 0, total: 0 }, remainingFilesCount: 0 }
  }

  // ========== H1: PREVIEW (只读探索) ==========
  await setPhase("H1", "preview")
  currentGate = "preview"
  await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_PREVIEW_START, sessionId, payload: { objective: prompt } })
  await syncState({ lastMessage: "H1: preview agent exploring codebase" })

  const previewModel = getModelForStage("preview")
  const previewPrompt = buildStageWrapper(LONGAGENT_4STAGE_STAGES.PREVIEW, { preview: null, blueprint: null, coding: null }, prompt)
  const previewOut = await processTurnLoop({
    prompt: previewPrompt, mode: "agent", agent: getAgent("preview-agent"),
    model: previewModel.model, providerType: previewModel.providerType,
    sessionId, configState, baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
  })
  accumulateUsage(previewOut)
  const previewFindings = previewOut.reply || ""

  gateStatus.preview = { status: "pass", findingsLength: previewFindings.length }
  await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_PREVIEW_COMPLETE, sessionId, payload: { findingsLength: previewFindings.length } })
  await syncState({ lastMessage: `H1: preview complete (${previewFindings.length} chars)` })

  // ========== H2: BLUEPRINT (只读规划 + 结构化 stagePlan) ==========
  await setPhase("H2", "blueprint")
  currentGate = "blueprint"
  await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_START, sessionId, payload: {} })
  await syncState({ lastMessage: "H2: blueprint agent designing architecture" })

  const blueprintModel = getModelForStage("blueprint")
  const blueprintPrompt = buildStageWrapper(LONGAGENT_4STAGE_STAGES.BLUEPRINT, { preview: previewFindings, blueprint: null, coding: null }, prompt)
    + "\n\n## HYBRID MODE REQUIREMENT\nYou MUST also output a structured stage plan JSON block wrapped in ```stage_plan_json ... ```. See your system prompt for the exact schema."
  const blueprintOut = await processTurnLoop({
    prompt: blueprintPrompt, mode: "agent", agent: getAgent("blueprint-agent"),
    model: blueprintModel.model, providerType: blueprintModel.providerType,
    sessionId, configState, baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
  })
  accumulateUsage(blueprintOut)

  const planDefaults = { timeoutMs: Number(parallelConfig.task_timeout_ms || 600000), maxRetries: Number(parallelConfig.task_max_retries ?? 2) }
  const { architectureText, stagePlan: parsedPlan } = parseBlueprintOutput(blueprintOut.reply || "", prompt, planDefaults)
  stagePlan = parsedPlan
  planFrozen = true

  gateStatus.blueprint = { status: "pass", hasArchitecture: architectureText.length > 100, stageCount: stagePlan.stages.length }
  await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_COMPLETE, sessionId, payload: { planId: stagePlan.planId, stageCount: stagePlan.stages.length } })
  await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_PLAN_FROZEN, sessionId, payload: { planId: stagePlan.planId, stageCount: stagePlan.stages.length, errors: [] } })
  await syncState({ planFrozen: true, lastMessage: `H2: blueprint complete, ${stagePlan.stages.length} stage(s)` })

  // ========== H2.5: GIT BRANCH (可选) ==========
  const gitEnabled = gitConfig.enabled === true || gitConfig.enabled === "ask"
  const gitAsk = gitConfig.enabled === "ask"
  const cwd = process.cwd()
  const inGitRepo = gitEnabled && await git.isGitRepo(cwd)

  if (inGitRepo) {
    await setPhase("H2.5", "git_branch")
    let userWantsGit = !gitAsk
    if (gitAsk && allowQuestion) {
      const askResult = await processTurnLoop({
        prompt: "[SYSTEM] 是否为本次 Hybrid LongAgent 创建独立 Git 分支？回复 yes/是 启用，no/否 跳过。",
        mode: "ask", model, providerType, sessionId, configState, baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext
      })
      const answer = String(askResult.reply || "").toLowerCase().trim()
      userWantsGit = ["yes", "是", "y", "ok", "好", "确认"].some(k => answer.includes(k))
      accumulateUsage(askResult)
    }
    if (userWantsGit) {
      gitBaseBranch = await git.currentBranch(cwd)
      const branchName = git.generateBranchName(sessionId, prompt)
      const clean = await git.isClean(cwd)
      let stashed = false
      if (!clean) { const sr = await git.stash("kkcode-auto-stash", cwd); stashed = sr.ok }
      const created = await git.createBranch(branchName, cwd)
      if (created.ok) {
        gitBranch = branchName; gitActive = true
        gateStatus.git = { status: "pass", branch: branchName, baseBranch: gitBaseBranch }
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_BRANCH_CREATED, sessionId, payload: { branch: branchName, baseBranch: gitBaseBranch } })
      } else {
        gateStatus.git = { status: "warn", reason: created.message }
      }
      if (stashed) await git.stashPop(cwd)
    }
  }

  // ========== H3: SCAFFOLD (脚手架) ==========
  const scaffoldEnabled = longagentConfig.scaffold?.enabled !== false
  if (scaffoldEnabled && stagePlan.stages.length > 0) {
    await setPhase("H3", "scaffolding")
    currentGate = "scaffold"
    await syncState({ lastMessage: "H3: creating stub files" })

    const scaffoldResult = await runScaffoldPhase({
      objective: `${prompt}\n\n=== BLUEPRINT ARCHITECTURE ===\n${architectureText.slice(0, 4000)}`,
      stagePlan, model, providerType, sessionId, configState,
      baseUrl, apiKeyEnv, agent, signal, toolContext
    })

    gateStatus.scaffold = { status: scaffoldResult.scaffolded ? "pass" : "skip", fileCount: scaffoldResult.fileCount }
    if (scaffoldResult.usage) accumulateUsage(scaffoldResult)
    if (scaffoldResult.files?.length) {
      fileChanges = mergeCappedFileChanges(fileChanges,
        scaffoldResult.files.map(f => ({ path: f, addedLines: 0, removedLines: 0, stageId: "scaffold", taskId: "scaffold" })),
        fileChangesLimit)
    }
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_SCAFFOLD_COMPLETE, sessionId, payload: { fileCount: scaffoldResult.fileCount, files: scaffoldResult.files || [] } })
    await syncState({ lastMessage: `H3: scaffolded ${scaffoldResult.fileCount} file(s)` })
  }

  // ========== H4+H5: CODING(并行) + DEBUGGING(回滚) 循环 ==========
  let priorContext = [
    "### Preview Findings", previewFindings.slice(0, 2000), "",
    "### Blueprint Architecture", architectureText.slice(0, 3000)
  ].join("\n")

  let codingRollbackCount = 0
  const maxCodingRollbacks = Number(hybridConfig.max_coding_rollbacks || 2)
  const maxDebugIterations = Number(hybridConfig.debugging_max_iterations || 20)
  let rerunCoding = true

  while (rerunCoding && codingRollbackCount <= maxCodingRollbacks) {
    rerunCoding = false

    // --- H4: CODING (并行 stage 执行) ---
    await setPhase("H4", "coding")
    currentGate = "coding"
    stageIndex = 0

    while (stageIndex < stagePlan.stages.length) {
      const state = await LongAgentManager.get(sessionId)
      if (state?.stopRequested || signal?.aborted) break

      iteration++
      const stage = stagePlan.stages[stageIndex]
      currentGate = `stage:${stage.stageId}`
      await syncState({ stageStatus: "running", lastMessage: `H4: running ${stage.stageId} (${stageIndex + 1}/${stagePlan.stages.length})` })

      const seeded = Object.fromEntries(
        stage.tasks.map(t => [t.taskId, taskProgress[t.taskId]]).filter(([, v]) => Boolean(v))
      )

      const stageResult = await runStageBarrier({
        stage, sessionId, config: configState.config, model, providerType,
        seedTaskProgress: seeded, objective: prompt,
        stageIndex, stageCount: stagePlan.stages.length, priorContext
      })

      // 合并结果
      for (const [taskId, progress] of Object.entries(stageResult.taskProgress || {})) {
        taskProgress[taskId] = { ...taskProgress[taskId], ...progress }
        if (String(progress.lastReply || "").toLowerCase().includes("[task_complete]")) completionMarkerSeen = true
      }
      if (stageResult.completionMarkerSeen) completionMarkerSeen = true
      if (stageResult.fileChanges?.length) {
        fileChanges = mergeCappedFileChanges(fileChanges, stageResult.fileChanges, fileChangesLimit)
      }

      gateStatus[stage.stageId] = {
        status: stageResult.allSuccess ? "pass" : "fail",
        successCount: stageResult.successCount, failCount: stageResult.failCount
      }

      // 知识传递
      const taskSummaries = Object.values(stageResult.taskProgress || {})
        .filter(t => t.lastReply)
        .map(t => `[${t.taskId}] ${t.status}: ${t.lastReply.slice(0, 300)}`)
      if (taskSummaries.length) {
        priorContext += `\n### Stage ${stageIndex + 1}: ${stage.name || stage.stageId} (${stageResult.allSuccess ? "PASS" : "FAIL"})\n${taskSummaries.join("\n")}\n`
      }

      lastProgress = {
        percentage: Math.round(((stageIndex + (stageResult.allSuccess ? 1 : 0)) / Math.max(1, stagePlan.stages.length)) * 100),
        currentStep: stageIndex + (stageResult.allSuccess ? 1 : 0),
        totalSteps: stagePlan.stages.length
      }

      // Git: 每 stage 自动 commit
      if (gitActive && stageResult.allSuccess && gitConfig.auto_commit_stages !== false) {
        const msg = `[kkcode-hybrid] stage ${stage.stageId} completed (${stageIndex + 1}/${stagePlan.stages.length})`
        await git.commitAll(msg, cwd)
      }

      if (!stageResult.allSuccess) {
        recoveryCount++
        const backoffMs = Math.min(1000 * 2 ** (recoveryCount - 1), 30000)
        await new Promise(r => setTimeout(r, backoffMs))
        const maxStageRecoveries = Number(longagentConfig.max_stage_recoveries ?? 3)
        if (recoveryCount >= maxStageRecoveries) {
          await syncState({ status: "error", lastMessage: `stage ${stage.stageId} aborted after ${recoveryCount} recoveries` })
          break
        }
        // 重置失败 task 重试
        for (const [taskId, tp] of Object.entries(taskProgress)) {
          if (tp.status === "error") taskProgress[taskId] = { ...tp, status: "retrying", attempt: 0 }
        }
        continue
      }

      stageIndex++
      await saveCheckpoint(sessionId, { name: `hybrid_stage_${stage.stageId}`, iteration, currentPhase, stageIndex, stagePlan, taskProgress, planFrozen, lastProgress })
    }

    // --- H5: DEBUGGING (回滚检测) ---
    await setPhase("H5", "debugging")
    currentGate = "debugging"
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_DEBUGGING_START, sessionId, payload: { codingRollbackCount } })
    await syncState({ lastMessage: "H5: debugging agent verifying implementation" })

    const debugModel = getModelForStage("debugging")
    const debugPrompt = buildStageWrapper(LONGAGENT_4STAGE_STAGES.DEBUGGING, {
      preview: previewFindings.slice(0, 2000),
      blueprint: architectureText.slice(0, 3000),
      coding: priorContext.slice(0, 4000)
    }, prompt)

    let debugIter = 0
    let debugDone = false
    while (!debugDone && debugIter < maxDebugIterations) {
      debugIter++
      iteration++
      const state = await LongAgentManager.get(sessionId)
      if (state?.stopRequested || signal?.aborted) break

      const debugOut = await processTurnLoop({
        prompt: debugPrompt, mode: "agent", agent: getAgent("debugging-agent"),
        model: debugModel.model, providerType: debugModel.providerType,
        sessionId, configState, baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
      })
      accumulateUsage(debugOut)
      finalReply = debugOut.reply || ""

      if (detectStageComplete(finalReply, LONGAGENT_4STAGE_STAGES.DEBUGGING)) {
        debugDone = true
        gateStatus.debugging = { status: "pass", iterations: debugIter }
      }

      if (detectReturnToCoding(finalReply)) {
        codingRollbackCount++
        rerunCoding = true
        gateStatus.debugging = { status: "rollback", iterations: debugIter, rollbackCount: codingRollbackCount }
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_RETURN_TO_CODING, sessionId, payload: { rollbackCount: codingRollbackCount } })
        // 重置失败 task
        for (const [taskId, tp] of Object.entries(taskProgress)) {
          if (tp.status === "error") taskProgress[taskId] = { ...tp, status: "retrying", attempt: 0 }
        }
        break
      }

      if (/\[TASK_COMPLETE\]/i.test(finalReply)) { completionMarkerSeen = true; debugDone = true }
      await syncState({ lastMessage: `H5: debugging iteration ${debugIter}/${maxDebugIterations}` })
    }

    if (!debugDone && !rerunCoding) {
      gateStatus.debugging = { status: "timeout", iterations: debugIter }
    }

    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_DEBUGGING_COMPLETE, sessionId, payload: { debugIter, rollback: rerunCoding } })
    await syncState({ lastMessage: rerunCoding ? `H5: rollback to coding (attempt ${codingRollbackCount})` : `H5: debugging complete` })
  } // end while(rerunCoding)

  // ========== H6: USABILITY GATES ==========
  await setPhase("H6", "gates")
  currentGate = "gates"
  await syncState({ lastMessage: "H6: running usability gates" })

  const gatesConfig = longagentConfig.usability_gates || {}
  let gateAttempt = 0

  while (gateAttempt < maxGateAttempts) {
    gateAttempt++
    const state = await LongAgentManager.get(sessionId)
    if (state?.stopRequested || signal?.aborted) break

    const gateResult = await runUsabilityGates({
      sessionId, configState, model, providerType,
      baseUrl, apiKeyEnv, signal, toolContext,
      objective: prompt, fileChanges,
      gatesConfig, allowQuestion
    })
    if (gateResult.usage) accumulateUsage(gateResult)

    if (gateResult.allPassed) {
      gateStatus.usabilityGates = { status: "pass", attempt: gateAttempt }
      break
    }

    lastGateFailures = gateResult.failures || []
    gateStatus.usabilityGates = { status: "fixing", attempt: gateAttempt, failures: summarizeGateFailures(lastGateFailures) }
    await syncState({ lastMessage: `H6: gate failures (attempt ${gateAttempt}/${maxGateAttempts}), fixing...` })

    // 修复循环：让 coding agent 修复 gate 失败
    const fixPrompt = `Fix the following usability gate failures:\n${summarizeGateFailures(lastGateFailures)}\n\nOriginal objective: ${prompt}`
    const fixOut = await processTurnLoop({
      prompt: fixPrompt, mode: "agent", agent: getAgent("coding-agent"),
      model, providerType, sessionId, configState,
      baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
    })
    accumulateUsage(fixOut)
    iteration++
  }

  if (gateAttempt >= maxGateAttempts && lastGateFailures.length) {
    gateStatus.usabilityGates = { status: "fail", attempt: gateAttempt, failures: summarizeGateFailures(lastGateFailures) }
  }

  // ========== H7: GIT MERGE ==========
  if (gitActive && gitBaseBranch && gitBranch) {
    await setPhase("H7", "git_merge")
    try {
      await git.commitAll(`[kkcode-hybrid] session ${sessionId} completed`, cwd)
      if (gitConfig.auto_merge !== false) {
        await git.checkoutBranch(gitBaseBranch, cwd)
        await git.mergeBranch(gitBranch, cwd)
        await git.deleteBranch(gitBranch, cwd)
        gateStatus.gitMerge = { status: "pass", branch: gitBranch, baseBranch: gitBaseBranch }
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_MERGED, sessionId, payload: { branch: gitBranch, baseBranch: gitBaseBranch } })
      }
    } catch (err) {
      gateStatus.gitMerge = { status: "warn", reason: err.message }
    }
  }

  // ========== 完成 ==========
  const elapsed = Math.round((Date.now() - startTime) / 1000)
  const finalStatus = completionMarkerSeen ? "completed" : "done"
  await LongAgentManager.update(sessionId, { status: finalStatus, lastMessage: "hybrid longagent complete", elapsed })
  await markSessionStatus(sessionId, finalStatus === "completed" ? "completed" : "active")

  const stats = stageProgressStats(taskProgress)
  return {
    sessionId, turnId: `turn_long_${Date.now()}`,
    reply: finalReply || "hybrid longagent complete",
    usage: aggregateUsage, toolEvents, iterations: iteration,
    status: finalStatus, phase: currentPhase,
    gateStatus, currentGate, lastGateFailures, recoveryCount,
    progress: lastProgress, elapsed,
    stageIndex, stageCount: stagePlan?.stages?.length || 0,
    planFrozen, taskProgress, fileChanges,
    stageProgress: { done: stats.done, total: stats.total },
    remainingFilesCount: stats.remainingFilesCount,
    gitBranch, gitBaseBranch
  }
}
