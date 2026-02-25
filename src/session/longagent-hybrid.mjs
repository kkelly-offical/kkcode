/**
 * LongAgent Hybrid 模式
 * 融合 4-Stage 的只读探索/规划/调试回滚 + Parallel 的脚手架/并行执行/门控
 *
 * 流程: H0:Intake → H1:Preview → H2:Blueprint → H2.5:Git → H3:Scaffold → H4:Coding(并行) → H5:Debugging(回滚) → H5.5:Validation → H6:Gates → H7:GitMerge
 */
import { LongAgentManager } from "../orchestration/longagent-manager.mjs"
import { processTurnLoop } from "./loop.mjs"
import { markSessionStatus } from "./store.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES, LONGAGENT_4STAGE_STAGES } from "../core/constants.mjs"
import { saveCheckpoint, loadCheckpoint, saveTaskCheckpoint, loadTaskCheckpoints, cleanupCheckpoints } from "./checkpoint.mjs"
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
import { runIntakeDialogue, validateAndNormalizeStagePlan, defaultStagePlan } from "./longagent-plan.mjs"
import { createValidator } from "./task-validator.mjs"
import { detectStageComplete, detectReturnToCoding, buildStageWrapper } from "./longagent-4stage.mjs"
import {
  isComplete,
  isLikelyActionableObjective,
  mergeCappedFileChanges,
  stageProgressStats,
  summarizeGateFailures,
  LONGAGENT_FILE_CHANGES_LIMIT,
  createStuckTracker,
  classifyError,
  ERROR_CATEGORIES,
  createSemanticErrorTracker,
  createDegradationChain,
  generateRecoverySuggestions,
  stripFence,
  parseJsonLoose
} from "./longagent-utils.mjs"
import { TaskBus } from "./longagent-task-bus.mjs"
import { loadProjectMemory, saveProjectMemory, memoryToContext, parseMemoryFromPreview } from "./longagent-project-memory.mjs"
import * as git from "../util/git.mjs"

// Checkpoint 结构校验
function validateCheckpoint(cp) {
  if (!cp || !cp.stagePlan || !Array.isArray(cp.stagePlan.stages)) return false
  if (typeof cp.stageIndex !== "number" || cp.stageIndex < 0) return false
  if (cp.stageIndex > cp.stagePlan.stages.length) return false
  // Verify the previous stage exists for task checkpoint loading
  if (cp.stageIndex > 0 && !cp.stagePlan.stages[cp.stageIndex - 1]) return false
  return true
}

// Gate 修复策略路由 (Phase 8)
function getGateFixStrategy(failures) {
  const gateTypes = (failures || []).map(f => f.gate).filter(Boolean)
  if (gateTypes.includes("test")) return { agent: "debugging-agent", prefix: "Analyze test failures and fix:" }
  if (gateTypes.every(g => g === "build")) return { agent: "coding-agent", prefix: "Fix build errors:" }
  if (gateTypes.every(g => g === "lint")) return { autoFix: "npx eslint --fix .", agent: "coding-agent", prefix: "Fix lint errors:" }
  return { agent: "coding-agent", prefix: "Fix gate failures:" }
}

// #13 上下文压缩
async function compressContext(text, limit, { model, providerType, sessionId, configState, baseUrl, apiKeyEnv, signal, toolContext }) {
  if (text.length <= limit) return text
  const out = await processTurnLoop({
    prompt: [
      `Compress the following engineering context to max ${Math.round(limit * 0.6)} characters.`,
      "Preserve ONLY:",
      "- Concrete decisions made (technology choices, architecture patterns, API contracts)",
      "- File paths and function signatures that were created or modified",
      "- Error messages and their resolutions",
      "- Cross-task dependencies and integration points",
      "- Test results (pass/fail with specific failure reasons)",
      "Discard: exploration logs, verbose tool output, repeated information, reasoning chains.",
      "Output the compressed context directly — no preamble or explanation.",
      "",
      text.slice(0, limit * 2)
    ].join("\n"),
    mode: "ask", model, providerType, sessionId, configState, baseUrl, apiKeyEnv, signal, allowQuestion: false, toolContext
  })
  return (out.reply || text.slice(0, limit)).slice(0, limit)
}

// #3 动态计划修订解析
function parseReplanMarker(text) {
  const match = String(text || "").match(/\[REPLAN:\s*([\s\S]*?)\]/i)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

// #1 细粒度回滚：从 debugging 输出中提取失败的 taskId
function extractFailedTaskIds(text) {
  const ids = []
  const pattern = /\[FAILED_TASK:\s*(\S+)\]/gi
  let m
  while ((m = pattern.exec(text)) !== null) ids.push(m[1])
  return ids
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
  const adaptiveModels = hybridConfig.adaptive_models || {}
  const useAdaptiveModels = adaptiveModels.enabled === true
  function getModelForStage(stage) {
    if (!useSeparateModels) return { model, providerType }
    const m = { preview: separateModels.preview_model, blueprint: separateModels.blueprint_model, debugging: separateModels.debugging_model }
    return m[stage] ? { model: m[stage], providerType } : { model, providerType }
  }
  // #8 自适应模型路由：根据 task complexity 选择模型
  function getModelForTask(task) {
    if (!useAdaptiveModels) return model
    const tier = task?.complexity || "medium"
    return adaptiveModels[tier] || model
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
  const stuckTracker = createStuckTracker()
  // Phase 6: 降级链
  const degradationChain = createDegradationChain(hybridConfig.degradation || {})
  // Phase 2: 阶段超时配置
  const codingPhaseTimeoutMs = Number(hybridConfig.coding_phase_timeout_ms || 1800000)
  const debuggingPhaseTimeoutMs = Number(hybridConfig.debugging_phase_timeout_ms || 600000)
  // #4 TaskBus
  const taskBus = hybridConfig.task_bus !== false ? new TaskBus() : null
  // #5 Project Memory
  const cwd = process.cwd()
  let projectMemory = null
  if (hybridConfig.project_memory !== false) {
    try { projectMemory = await loadProjectMemory(cwd) } catch { projectMemory = null }
  }

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

  // #15 Checkpoint 恢复：如果有之前的检查点，跳过已完成阶段
  // #22: 增强为 task 级粒度恢复
  if (hybridConfig.checkpoint_resume !== false) {
    try {
      const cp = await loadCheckpoint(sessionId)
      if (cp?.stageIndex > 0 && cp?.stagePlan) {
        if (!validateCheckpoint(cp)) {
          // Invalid checkpoint structure — discard and start fresh
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_CHECKPOINT_INVALID, sessionId, payload: { reason: "structure_validation_failed" } })
        } else {
          stagePlan = cp.stagePlan; stageIndex = cp.stageIndex; planFrozen = true
          taskProgress = cp.taskProgress || {}; lastProgress = cp.lastProgress || lastProgress
          iteration = cp.iteration || 0
          // #22: Load task-level checkpoints to recover intra-stage progress
          if (stageIndex > 0) {
            const prevStage = cp.stagePlan.stages[stageIndex - 1]
            if (prevStage) {
              const taskCps = await loadTaskCheckpoints(sessionId, prevStage.stageId)
              for (const [tid, tData] of Object.entries(taskCps)) {
                if (!taskProgress[tid] || taskProgress[tid].status !== "completed") {
                  taskProgress[tid] = { ...taskProgress[tid], ...tData }
                }
              }
            }
          }
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_CHECKPOINT_RESUMED, sessionId, payload: { stageIndex, iteration } })
          await syncState({ lastMessage: `resumed from checkpoint at stage ${stageIndex}` })
        }
      }
    } catch { /* no checkpoint, start fresh */ }
  }

  // #5 Memory 事件
  if (projectMemory?.techStack?.length) {
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_MEMORY_LOADED, sessionId, payload: { techStack: projectMemory.techStack } })
  }

  // ========== H0: INTAKE (需求澄清) ==========
  let intakeSummary = prompt
  if (hybridConfig.intake !== false && !planFrozen) {
    await setPhase("H0", "intake")
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_INTAKE_STARTED, sessionId, payload: { objective: prompt } })
    await syncState({ lastMessage: "H0: intake dialogue — clarifying requirements" })

    const plannerConfig = longagentConfig.planner || {}
    const intakeConfig = plannerConfig.intake_questions || {}
    const intake = await runIntakeDialogue({
      objective: prompt,
      model, providerType, sessionId, configState,
      baseUrl, apiKeyEnv, agent, signal,
      maxRounds: Number(intakeConfig.max_rounds || 6)
    })
    intakeSummary = intake.summary || prompt
    accumulateUsage(intake)
    gateStatus.intake = { status: "pass", rounds: intake.transcript.length, summary: intakeSummary.slice(0, 500) }
    await syncState({ lastMessage: `H0: intake complete (${intake.transcript.length} qa pairs)` })
  }

  // ========== H1: PREVIEW (只读探索) ==========
  await setPhase("H1", "preview")
  currentGate = "preview"
  await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_PREVIEW_START, sessionId, payload: { objective: prompt } })
  await syncState({ lastMessage: "H1: preview agent exploring codebase" })

  const previewModel = getModelForStage("preview")
  // #5 注入 project memory 到 preview prompt
  const memCtx = projectMemory ? memoryToContext(projectMemory) : ""
  const previewPrompt = buildStageWrapper(LONGAGENT_4STAGE_STAGES.PREVIEW, { preview: null, blueprint: null, coding: null }, memCtx ? `${memCtx}\n\n${intakeSummary}` : intakeSummary)
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
    + [
      "\n\n## HYBRID MODE: STRUCTURED EXECUTION PLAN (REQUIRED)",
      "In addition to your architecture design, you MUST output a machine-parseable stage plan.",
      "",
      "Wrap it in a ```stage_plan_json ... ``` fenced block. Schema:",
      '{"planId":"...","objective":"...","stages":[{"stageId":"...","name":"...","passRule":"all_success","tasks":[{"taskId":"...","prompt":"detailed task prompt for sub-agent","plannedFiles":["file1.mjs","file2.mjs"],"acceptance":["node --check file1.mjs","node --test test/file1.test.mjs"],"timeoutMs":600000,"maxRetries":2,"complexity":"low|medium|high"}]}]}',
      "",
      "Rules for the stage plan:",
      "- Each task prompt must be SELF-CONTAINED: the sub-agent has NO access to your blueprint text",
      "- plannedFiles must list EVERY file the task will create or modify (no file in multiple tasks)",
      "- acceptance must be machine-verifiable commands (not subjective criteria)",
      "- Files that import each other MUST be in the same task",
      "- A module and its test file MUST be in the same task",
      "- Order stages by dependency: shared types → core logic → integration → validation"
    ].join("\n")
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

  // #9 Blueprint 语义验证
  if (hybridConfig.blueprint_validation !== false && stagePlan.stages.length > 0) {
    const totalTasks = stagePlan.stages.reduce((s, st) => s + (st.tasks?.length || 0), 0)
    const totalFiles = new Set(stagePlan.stages.flatMap(st => (st.tasks || []).flatMap(t => t.plannedFiles || []))).size
    const valid = totalTasks > 0 && totalFiles > 0
    gateStatus.blueprintValidation = { status: valid ? "pass" : "warn", totalTasks, totalFiles }
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_VALIDATED, sessionId, payload: { totalTasks, totalFiles, valid } })
  }

  // #2 人工审查检查点
  if (hybridConfig.blueprint_review === true && allowQuestion) {
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_REVIEW, sessionId, payload: { planId: stagePlan.planId } })
    const reviewOut = await processTurnLoop({
      prompt: `[SYSTEM] Blueprint 已生成，包含 ${stagePlan.stages.length} 个阶段。架构摘要:\n${architectureText.slice(0, 1500)}\n\n请确认是否继续执行？回复 yes/是 继续，no/否 中止。`,
      mode: "ask", model, providerType, sessionId, configState, baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext
    })
    accumulateUsage(reviewOut)
    const answer = String(reviewOut.reply || "").toLowerCase().trim()
    if (["no", "否", "n", "取消", "abort"].some(k => answer.includes(k))) {
      await LongAgentManager.update(sessionId, { status: "aborted", lastMessage: "user rejected blueprint" })
      await markSessionStatus(sessionId, "active")
      return { sessionId, turnId: `turn_long_${Date.now()}`, reply: "用户中止了 Blueprint 审查。", usage: aggregateUsage, toolEvents, iterations: iteration, status: "aborted", phase: "H2", gateStatus, currentGate, lastGateFailures: [], recoveryCount: 0, progress: lastProgress, elapsed: Math.round((Date.now() - startTime) / 1000), stageIndex: 0, stageCount: stagePlan.stages.length, planFrozen, taskProgress: {}, fileChanges: [], stageProgress: { done: 0, total: 0 }, remainingFilesCount: 0 }
    }
  }

  // ========== H2.5: GIT BRANCH (可选) ==========
  const gitEnabled = gitConfig.enabled === true || gitConfig.enabled === "ask"
  const gitAsk = gitConfig.enabled === "ask"
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
      // Guard: skip git flow if branch is empty or HEAD detached
      if (!gitBaseBranch || gitBaseBranch === "HEAD") {
        gateStatus.git = { status: "warn", reason: "detached HEAD or no branch" }
      } else {
        const branchName = git.generateBranchName(sessionId, prompt)
        const clean = await git.isClean(cwd)
        let stashed = false
        try {
          if (!clean) {
            const sr = await git.stash("kkcode-auto-stash", cwd)
            stashed = sr.ok
            if (!stashed) {
              // Stash failed — skip branch creation
              gateStatus.git = { status: "warn", reason: "git stash failed" }
            }
          }
          if (!stashed && !clean) {
            // stash failed, skip branch creation (already set gateStatus above)
          } else {
            const created = await git.createBranch(branchName, cwd)
            if (created.ok) {
              gitBranch = branchName; gitActive = true
              gateStatus.git = { status: "pass", branch: branchName, baseBranch: gitBaseBranch }
              await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_BRANCH_CREATED, sessionId, payload: { branch: branchName, baseBranch: gitBaseBranch } })
            } else {
              gateStatus.git = { status: "warn", reason: created.message }
            }
          }
        } finally {
          // Always restore stash on any exit path
          if (stashed) await git.stashPop(cwd).catch(() => {})
        }
      }
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
      baseUrl, apiKeyEnv, agent, signal, toolContext,
      tddMode: hybridConfig.tdd_mode === true
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
  const gatesConfig = longagentConfig.usability_gates || {}
  let priorContext = [
    "### Preview Findings", previewFindings.slice(0, 2000), "",
    "### Blueprint Architecture", architectureText.slice(0, 3000)
  ].join("\n")
  const seenFilePaths = new Set() // #3 去重：跨阶段文件路径去重

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
    const codingPhaseStart = Date.now()

    while (stageIndex < stagePlan.stages.length) {
      const state = await LongAgentManager.get(sessionId)
      if (state?.stopRequested || signal?.aborted) break

      // Phase 2: 阶段超时检测
      if (Date.now() - codingPhaseStart > codingPhaseTimeoutMs) {
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_PHASE_TIMEOUT, sessionId, payload: { phase: "H4", elapsed: Date.now() - codingPhaseStart } })
        if (degradationChain.canDegrade()) {
          const degCtx = { model, taskProgress, configState, shouldStop: false }
          const deg = degradationChain.apply(degCtx)
          if (degCtx.model !== model) model = degCtx.model
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_DEGRADATION_APPLIED, sessionId, payload: { strategy: deg.strategy, phase: "H4" } })
          if (deg.applied && deg.strategy === "graceful_stop") break
        } else {
          break
        }
      }

      iteration++
      const stage = stagePlan.stages[stageIndex]
      currentGate = `stage:${stage.stageId}`
      await syncState({ stageStatus: "running", lastMessage: `H4: running ${stage.stageId} (${stageIndex + 1}/${stagePlan.stages.length})` })

      const seeded = Object.fromEntries(
        stage.tasks.map(t => [t.taskId, taskProgress[t.taskId]]).filter(([, v]) => Boolean(v))
      )

      // #4 计划锚点 — 每阶段动态构建，不存入 priorContext 避免被压缩掉
      const stageStatuses = stagePlan.stages.map((s, i) => {
        const marker = i < stageIndex ? "✓" : i === stageIndex ? "→" : " "
        return `[${marker}] 阶段${i + 1}: ${s.name || s.stageId}`
      }).join("\n")
      const planAnchor = `## 计划锚点\n目标: ${stagePlan.objective || prompt}\n进度: ${stageIndex + 1}/${stagePlan.stages.length}\n${stageStatuses}\n\n`

      const stageResult = await runStageBarrier({
        stage, sessionId, config: configState.config, model, providerType,
        seedTaskProgress: seeded, objective: prompt,
        stageIndex, stageCount: stagePlan.stages.length, priorContext: planAnchor + priorContext,
        stuckTracker,
        onTaskComplete: async (taskData) => {
          await saveTaskCheckpoint(sessionId, taskData.stageId, taskData.taskId, taskData)
        },
        taskBus
      })

      // 合并结果
      for (const [taskId, progress] of Object.entries(stageResult.taskProgress || {})) {
        taskProgress[taskId] = { ...taskProgress[taskId], ...progress }
        if (String(progress.lastReply || "").toLowerCase().includes("[task_complete]")) completionMarkerSeen = true
        // #4 TaskBus: 解析 task 输出中的广播消息
        if (taskBus && progress.lastReply) taskBus.parseTaskOutput(taskId, progress.lastReply)
        // #3 动态重规划: 检测 [REPLAN:...] 标记
        const replan = parseReplanMarker(progress.lastReply)
        if (replan?.stages) {
          const { plan, errors } = validateAndNormalizeStagePlan(replan, { objective: prompt, defaults: planDefaults })
          if (!errors.length) {
            stagePlan = plan
            await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_REPLAN, sessionId, payload: { newStageCount: plan.stages.length } })
          }
        }
      }
      if (stageResult.completionMarkerSeen) completionMarkerSeen = true
      if (stageResult.fileChanges?.length) {
        fileChanges = mergeCappedFileChanges(fileChanges, stageResult.fileChanges, fileChangesLimit)
      }

      gateStatus[stage.stageId] = {
        status: stageResult.allSuccess ? "pass" : "fail",
        successCount: stageResult.successCount, failCount: stageResult.failCount
      }

      // #1 阶段级压缩 + #3 文件去重 — 结构化摘要，跨阶段去重文件路径
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
        const failNote = !stageResult.allSuccess ? ` 失败任务数: ${stageResult.failCount}` : ""
        priorContext += `\n### 阶段${stageIndex + 1}: ${stage.name || stage.stageId} (${stageResult.allSuccess ? "PASS" : "FAIL"}${failNote})\n${taskSummaries.join("\n")}${fileNote}\n`
      }
      // #4 TaskBus 注入到 priorContext
      if (taskBus) {
        const busCtx = taskBus.toContextString()
        if (busCtx) priorContext += `\n${busCtx}\n`
      }
      // #13 上下文压缩
      const pressureLimit = Number(hybridConfig.context_pressure_limit || 8000)
      if (priorContext.length > pressureLimit) {
        priorContext = await compressContext(priorContext, pressureLimit, { model, providerType, sessionId, configState, baseUrl, apiKeyEnv, signal, toolContext })
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_CONTEXT_COMPRESSED, sessionId, payload: { newLength: priorContext.length } })
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

      // #10 增量门控：每个 stage 完成后运行轻量检查
      if (hybridConfig.incremental_gates !== false && stageResult.allSuccess && stageIndex < stagePlan.stages.length - 1) {
        const stageFiles = (stageResult.fileChanges || []).map(f => f.path).filter(Boolean)
        if (stageFiles.length > 0) {
          const miniGate = await runUsabilityGates({
            sessionId, configState, model, providerType, baseUrl, apiKeyEnv, signal, toolContext,
            objective: `Verify stage ${stage.stageId}: ${stage.name || ""}`, fileChanges: stageResult.fileChanges || [],
            gatesConfig: { ...gatesConfig, lint: true, typecheck: true, test: false, security: false, build: false }, allowQuestion: false
          })
          if (miniGate.usage) accumulateUsage(miniGate)
          gateStatus[`gate_${stage.stageId}`] = { status: miniGate.allPassed ? "pass" : "warn" }
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_INCREMENTAL_GATE, sessionId, payload: { stageId: stage.stageId, passed: miniGate.allPassed } })
          // #18: Feed gate results into priorContext so subsequent stages see lint/typecheck feedback
          if (!miniGate.allPassed && miniGate.failures?.length) {
            const gateFeedback = miniGate.failures.slice(0, 3).map(f => `${f.gate}: ${(f.reason || "").slice(0, 150)}`).join("; ")
            priorContext += `\n### Incremental Gate Warning (${stage.stageId})\n${gateFeedback}\n`
          }
        }
      }

      // #14 预算感知：检查 token 消耗是否超限
      // #21: 增加基于历史平均值的预算预测
      if (hybridConfig.budget_awareness !== false) {
        const totalTokens = aggregateUsage.input + aggregateUsage.output
        const budgetLimit = Number(longagentConfig.token_budget || 2000000)

        // #21: Predict remaining budget based on average per-stage cost
        const completedStages = stageIndex + (stageResult.allSuccess ? 1 : 0)
        const remainingStages = stagePlan.stages.length - completedStages
        if (completedStages > 0 && remainingStages > 0) {
          const avgPerStage = totalTokens / completedStages
          const predicted = totalTokens + avgPerStage * remainingStages
          if (predicted > budgetLimit && totalTokens <= budgetLimit * 0.9) {
            await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_BUDGET_WARNING, sessionId, payload: { totalTokens, budgetLimit, predicted: Math.round(predicted), percentage: Math.round(totalTokens / budgetLimit * 100), forecast: true } })
            await syncState({ lastMessage: `H4: budget forecast — predicted ${Math.round(predicted / 1000)}k tokens (limit ${Math.round(budgetLimit / 1000)}k)` })
          }
        }

        if (totalTokens > budgetLimit * 0.9) {
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_BUDGET_WARNING, sessionId, payload: { totalTokens, budgetLimit, percentage: Math.round(totalTokens / budgetLimit * 100) } })
          await syncState({ lastMessage: `H4: budget warning — ${Math.round(totalTokens / budgetLimit * 100)}% used` })
        }
        if (totalTokens > budgetLimit) {
          // Phase 6: 尝试降级而非直接 break
          if (degradationChain.canDegrade()) {
            const degCtx2 = { model, taskProgress, configState, shouldStop: false }
            const deg = degradationChain.apply(degCtx2)
            if (degCtx2.model !== model) model = degCtx2.model
            await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_DEGRADATION_APPLIED, sessionId, payload: { strategy: deg.strategy, phase: "H4", reason: "budget_exceeded" } })
            if (deg.applied && deg.strategy === "graceful_stop") {
              await syncState({ status: "budget_exceeded", lastMessage: `H4: budget exceeded, graceful stop` })
              break
            }
          } else {
            await syncState({ status: "budget_exceeded", lastMessage: `H4: budget exceeded (${totalTokens}/${budgetLimit})` })
            break
          }
        }
      }

      if (!stageResult.allSuccess) {
        recoveryCount++
        const backoffMs = Math.min(1000 * 2 ** (recoveryCount - 1), 30000)
        await new Promise(r => setTimeout(r, backoffMs))
        const maxStageRecoveries = Number(longagentConfig.max_stage_recoveries ?? 3)
        if (recoveryCount >= maxStageRecoveries) {
          // Phase 6: 尝试降级而非直接 abort
          if (degradationChain.canDegrade()) {
            const degCtx3 = { model, taskProgress, configState, shouldStop: false }
            const deg = degradationChain.apply(degCtx3)
            if (degCtx3.model !== model) model = degCtx3.model
            await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_DEGRADATION_APPLIED, sessionId, payload: { strategy: deg.strategy, phase: "H4", reason: "max_recoveries" } })
            if (deg.applied && deg.strategy === "graceful_stop") {
              await syncState({ status: "error", lastMessage: `stage ${stage.stageId} aborted after degradation` })
              break
            }
            // 降级成功但非 graceful_stop，重置 recoveryCount 继续
            recoveryCount = 0
          } else {
            await syncState({ status: "error", lastMessage: `stage ${stage.stageId} aborted after ${recoveryCount} recoveries` })
            break
          }
        }
        // Phase 1: 根据错误类别决定是否重试
        for (const [taskId, tp] of Object.entries(taskProgress)) {
          if (tp.status === "error") {
            const category = classifyError(tp.lastError)
            if (category === ERROR_CATEGORIES.PERMANENT || category === ERROR_CATEGORIES.UNKNOWN) {
              taskProgress[taskId] = { ...tp, status: "error", skipReason: `${category} error` }
            } else {
              taskProgress[taskId] = { ...tp, status: "retrying", attempt: 0 }
            }
          }
        }
        continue
      }

      stageIndex++
      recoveryCount = 0  // reset per-stage recovery counter after successful stage
      await saveCheckpoint(sessionId, { name: `hybrid_stage_${stage.stageId}`, iteration, currentPhase, stageIndex, stagePlan, taskProgress, planFrozen, lastProgress })
    }

    // #11 Cross-review：H4 完成后、H5 之前，让独立 agent 审查代码
    if (hybridConfig.cross_review !== false && fileChanges.length > 0) {
      await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_CROSS_REVIEW, sessionId, payload: { fileCount: fileChanges.length } })
      const reviewFiles = fileChanges.slice(0, 20).map(f => f.path).join(", ")
      const reviewOut = await processTurnLoop({
        prompt: [
          "You are the CROSS-REVIEW agent. Multiple parallel sub-agents just completed their coding tasks independently.",
          "Your job: verify that their outputs are compatible, correct, and integrate properly.",
          "",
          "## Files to review:",
          reviewFiles,
          "",
          "## Review Checklist",
          "1. IMPORT RESOLUTION: Do all cross-file imports resolve? Are exported symbols correct?",
          "2. INTERFACE COMPATIBILITY: Do function signatures match what callers expect?",
          "3. ERROR HANDLING: Are errors properly caught, propagated, or thrown? No silent failures?",
          "4. RESOURCE CLEANUP: Are timers cleared, listeners removed, handles closed in all code paths?",
          "5. EDGE CASES: Null/undefined checks, empty arrays, concurrent access guards?",
          "6. CONSISTENCY: Same naming conventions, error patterns, async style across files?",
          "",
          `## Original Objective: ${prompt}`,
          "",
          "## Output Format",
          "For each issue found, output: [FAILED_TASK: taskId] with a description of the problem.",
          "If no issues found, state that the cross-review passed.",
          "Focus on REAL bugs that would cause runtime failures — not style preferences."
        ].join("\n"),
        mode: "agent", agent: getAgent("debugging-agent"),
        model, providerType, sessionId, configState, baseUrl, apiKeyEnv, signal, output, allowQuestion: false, toolContext
      })
      accumulateUsage(reviewOut)
      // 将审查发现注入 priorContext
      if (reviewOut.reply) priorContext += `\n### Cross-Review Findings\n${reviewOut.reply.slice(0, 1500)}\n`
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
    const semanticTracker = createSemanticErrorTracker(3)
    const debugPhaseStart = Date.now()

    while (!debugDone && debugIter < maxDebugIterations) {
      debugIter++
      iteration++
      const state = await LongAgentManager.get(sessionId)
      if (state?.stopRequested || signal?.aborted) break

      // Phase 2: debugging 阶段超时检测
      if (Date.now() - debugPhaseStart > debuggingPhaseTimeoutMs) {
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_PHASE_TIMEOUT, sessionId, payload: { phase: "H5", elapsed: Date.now() - debugPhaseStart } })
        if (degradationChain.canDegrade()) {
          const degCtx4 = { model, taskProgress, configState, shouldStop: false }
          const deg = degradationChain.apply(degCtx4)
          if (degCtx4.model !== model) model = degCtx4.model
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_DEGRADATION_APPLIED, sessionId, payload: { strategy: deg.strategy, phase: "H5" } })
          if (deg.applied && deg.strategy === "graceful_stop") break
        } else {
          break
        }
      }

      const debugOut = await processTurnLoop({
        prompt: debugPrompt, mode: "agent", agent: getAgent("debugging-agent"),
        model: debugModel.model, providerType: debugModel.providerType,
        sessionId, configState, baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
      })
      accumulateUsage(debugOut)
      finalReply = debugOut.reply || ""

      // 防卡死检测
      if (debugOut.toolEvents?.length) {
        const stuckResult = stuckTracker.track(debugOut.toolEvents)
        if (stuckResult.isStuck) {
          stuckTracker.resetReadOnlyCount()
          await EventBus.emit({
            type: EVENT_TYPES.LONGAGENT_ALERT, sessionId,
            payload: { kind: "stuck_warning", stage: "H5:debugging", reason: stuckResult.reason, debugIter }
          })
          await syncState({ lastMessage: `H5: stuck detected (${stuckResult.reason}), iter ${debugIter}` })
        }
      }

      // Phase 5: 语义级错误检测
      const semResult = semanticTracker.track(finalReply)
      if (semResult.isRepeated) {
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_SEMANTIC_ERROR_REPEATED, sessionId,
          payload: { error: semResult.error, count: semResult.count, debugIter }
        })
        // 注入更详细的错误分析提示，避免无限循环
        await syncState({ lastMessage: `H5: repeated error detected (${semResult.count}x): ${(semResult.error || "").slice(0, 80)}` })
      }

      if (detectStageComplete(finalReply, LONGAGENT_4STAGE_STAGES.DEBUGGING)) {
        debugDone = true
        gateStatus.debugging = { status: "pass", iterations: debugIter }
      }

      if (detectReturnToCoding(finalReply)) {
        codingRollbackCount++
        rerunCoding = true
        // #1 细粒度回滚：优先只重置被标记的失败 task
        const failedIds = extractFailedTaskIds(finalReply)
        if (failedIds.length > 0) {
          for (const fid of failedIds) {
            if (taskProgress[fid]) taskProgress[fid] = { ...taskProgress[fid], status: "retrying", attempt: 0 }
          }
        } else {
          // 回退：重置所有 error 状态的 task
          for (const [taskId, tp] of Object.entries(taskProgress)) {
            if (tp.status === "error") taskProgress[taskId] = { ...tp, status: "retrying", attempt: 0 }
          }
        }
        gateStatus.debugging = { status: "rollback", iterations: debugIter, rollbackCount: codingRollbackCount, failedTaskIds: failedIds }
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_RETURN_TO_CODING, sessionId, payload: { rollbackCount: codingRollbackCount, failedTaskIds: failedIds } })
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

  // ========== H5.5: COMPLETION VALIDATION ==========
  if (hybridConfig.completion_validation !== false) {
    await setPhase("H5.5", "completion_validation")
    await syncState({ lastMessage: "H5.5: validating completion" })

    const cwd = process.cwd()
    try {
      const validator = await createValidator({ cwd, configState })
      const report = await validator.validate({ todoState: toolContext?._todoState, level: "standard" })
      gateStatus.completionValidation = {
        status: report.verdict === "BLOCK" ? "fail" : "pass",
        verdict: report.verdict,
        failedChecks: report.results?.filter(r => !r.passed).length || 0
      }

      if (report.verdict === "BLOCK" && !completionMarkerSeen) {
        const fixPrompt = [
          "## Completion Validation Failed — Fix Required",
          "",
          `Original objective: ${prompt}`,
          "",
          "## Validation Issues Found:",
          report.message,
          "",
          "## Fix Instructions",
          "1. Read each failing check and identify the root cause",
          "2. Fix the issue in the source code (not by suppressing the check)",
          "3. Re-run the relevant verification command to confirm the fix",
          "4. If a fix requires changes to multiple files, ensure cross-file consistency",
          "",
          "When ALL issues are resolved and verified, include [TASK_COMPLETE] in your response."
        ].join("\n")
        const fixOut = await processTurnLoop({
          prompt: fixPrompt, mode: "agent", agent: getAgent("coding-agent"),
          model, providerType, sessionId, configState,
          baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
        })
        accumulateUsage(fixOut)
        iteration++
        if (/\[TASK_COMPLETE\]/i.test(fixOut.reply || "")) completionMarkerSeen = true
        finalReply = fixOut.reply || finalReply
      }
    } catch (valErr) {
      gateStatus.completionValidation = { status: "warn", reason: `skipped: ${valErr.message}` }
    }
  }

  // ========== H6: USABILITY GATES ==========
  await setPhase("H6", "gates")
  currentGate = "gates"
  await syncState({ lastMessage: "H6: running usability gates" })

  // Gate 偏好提示（首次运行时询问用户）
  const shouldPromptGates = gatesConfig.prompt_user === "first_run" || gatesConfig.prompt_user === "always"
  if (shouldPromptGates && allowQuestion) {
    const hasPrefs = await hasGatePreferences()
    if (!hasPrefs || gatesConfig.prompt_user === "always") {
      const gateAskResult = await processTurnLoop({
        prompt: buildGatePromptText(),
        mode: "ask", model, providerType, sessionId, configState,
        baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext
      })
      accumulateUsage(gateAskResult)
      const gatePrefs = parseGateSelection(gateAskResult.reply)
      await saveGatePreferences(gatePrefs)
      for (const [gate, enabled] of Object.entries(gatePrefs)) {
        if (configState.config.agent.longagent.usability_gates[gate]) {
          configState.config.agent.longagent.usability_gates[gate].enabled = enabled
        }
      }
    } else {
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

    // 修复循环：根据 gate 类型选择修复策略 (Phase 8)
    const strategy = getGateFixStrategy(lastGateFailures)

    // lint 失败时先尝试自动修复
    if (strategy.autoFix) {
      try {
        const { execSync } = await import("node:child_process")
        execSync(strategy.autoFix, { cwd: process.cwd(), timeout: 30000, stdio: "ignore" })
      } catch { /* autofix failed, fall through to agent */ }
    }

    const gateFailureSummary = summarizeGateFailures(lastGateFailures)
    const fixPrompt = [
      `## Quality Gate Failures — Attempt ${gateAttempt}/${maxGateAttempts}`,
      "",
      `${strategy.prefix || "Fix the following quality gate failures:"}`,
      "",
      gateFailureSummary,
      "",
      "## Fix Protocol",
      "1. Read the error output carefully — identify the ROOT CAUSE, not just the symptom",
      "2. Fix the source code (do NOT disable or skip the gate check)",
      "3. Re-run the failing command to verify the fix works",
      "4. If the fix touches shared code, verify no regressions in other modules",
      "",
      `Original objective: ${prompt}`
    ].join("\n")
    const fixOut = await processTurnLoop({
      prompt: fixPrompt, mode: "agent", agent: getAgent(strategy.agent || "coding-agent"),
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
      // Phase 9: 自愈式 Git 操作
      if (git.isConflictError(err)) {
        try {
          const conflictFiles = await git.getConflictFiles(cwd)
          if (conflictFiles.length > 0) {
            await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_CONFLICT_RESOLUTION, sessionId, payload: { files: conflictFiles } })
            const conflictPrompt = [
              "## Git Merge Conflict Resolution",
              "",
              "The following files have merge conflicts that must be resolved:",
              ...conflictFiles.map(f => `- ${f}`),
              "",
              "## Resolution Protocol",
              "1. Read each conflicted file and locate ALL conflict markers (<<<<<<< ======= >>>>>>>)",
              "2. For each conflict block:",
              "   - Understand what BOTH sides intended (ours = feature branch, theirs = base branch)",
              "   - Keep the feature branch changes (our work) unless they break base branch functionality",
              "   - If both sides modified the same logic, merge them intelligently (not just pick one)",
              "   - Remove ALL conflict markers — no <<<<<<< or ======= or >>>>>>> should remain",
              "3. After resolving, run syntax check on each file (node --check / python -m py_compile)",
              "4. Verify imports still resolve correctly across resolved files"
            ].join("\n")
            const conflictOut = await processTurnLoop({
              prompt: conflictPrompt, mode: "agent", agent: getAgent("coding-agent"),
              model, providerType, sessionId, configState,
              baseUrl, apiKeyEnv, signal, output, allowQuestion: false, toolContext
            })
            accumulateUsage(conflictOut)
            const commitResult = await git.commitAll(`[kkcode-hybrid] resolved merge conflicts`, cwd)
            if (commitResult.ok) {
              gateStatus.gitMerge = { status: "pass", branch: gitBranch, baseBranch: gitBaseBranch, conflictsResolved: true }
              await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_MERGED, sessionId, payload: { branch: gitBranch, baseBranch: gitBaseBranch } })
            } else {
              await git.mergeAbort(cwd)
              gateStatus.gitMerge = { status: "warn", reason: "conflict resolution failed, staying on feature branch" }
            }
          } else {
            gateStatus.gitMerge = { status: "warn", reason: err.message }
          }
        } catch (resolveErr) {
          await git.mergeAbort(cwd).catch(() => {})
          gateStatus.gitMerge = { status: "warn", reason: `conflict resolution error: ${resolveErr.message}` }
        }
      } else {
        gateStatus.gitMerge = { status: "warn", reason: err.message }
      }
    }
  }

  // #5 保存 project memory
  if (hybridConfig.project_memory !== false && previewFindings) {
    try {
      const newMemory = parseMemoryFromPreview(previewFindings)
      if (newMemory.techStack.length) {
        const merged = { ...projectMemory, techStack: [...new Set([...(projectMemory?.techStack || []), ...newMemory.techStack])].slice(0, 20), patterns: [...new Set([...(projectMemory?.patterns || []), ...newMemory.patterns])].slice(0, 20), conventions: projectMemory?.conventions || [] }
        await saveProjectMemory(cwd, merged)
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_MEMORY_SAVED, sessionId, payload: { techStackCount: merged.techStack.length } })
      }
    } catch { /* ignore memory save errors */ }
  }

  // Phase 10: Checkpoint 清理
  if (hybridConfig.checkpoint_cleanup !== false) {
    try {
      const cleanResult = await cleanupCheckpoints(sessionId, {
        maxKeep: Number(hybridConfig.checkpoint_max_keep || 10),
        keepStageCheckpoints: true
      })
      if (cleanResult.removed > 0) {
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_CHECKPOINT_CLEANED, sessionId, payload: { removed: cleanResult.removed } })
      }
    } catch { /* ignore cleanup errors */ }
  }

  // ========== 完成 ==========
  const elapsed = Math.round((Date.now() - startTime) / 1000)
  const finalStatus = completionMarkerSeen ? "completed" : "done"
  await LongAgentManager.update(sessionId, { status: finalStatus, lastMessage: "hybrid longagent complete", elapsed })
  await markSessionStatus(sessionId, finalStatus === "completed" ? "completed" : "active")

  const stats = stageProgressStats(taskProgress)

  // Phase 11: 恢复建议生成
  let recoverySuggestions = null
  if (finalStatus !== "completed") {
    recoverySuggestions = generateRecoverySuggestions({
      status: finalStatus,
      taskProgress,
      gateStatus,
      phase: currentPhase,
      recoveryCount,
      fileChanges
    })
  }

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
    gitBranch, gitBaseBranch,
    recoverySuggestions
  }
}
