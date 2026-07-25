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
import { EVENT_TYPES } from "../core/constants.mjs"
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
import { detectStageComplete, detectReturnToCoding, buildStageWrapper, ULTRA_STAGES, ACCEPTANCE_RULES, buildGoalPlanContract } from "./ultra-stages.mjs"
import { classifyGoalIntent, normalizeGoal, freezeGoal, intentProfile, planSignature } from "./goal-model.mjs"
import { verifyGoal, GOAL_MET, GOAL_BLOCKED_MANUAL } from "./goal-verifier.mjs"
import { verifyStageObjective, OBJECTIVE_MET } from "./stage-objective.mjs"
import { hasPromptHandler, askQuestionInteractive } from "../tool/question-prompt.mjs"
import {
  isComplete,
  isLikelyActionableObjective,
  mergeCappedFileChanges,
  stageProgressStats,
  summarizeGateFailures,
  formatGateFailureDetail,
  LONGAGENT_FILE_CHANGES_LIMIT,
  createStuckTracker,
  classifyError,
  ERROR_CATEGORIES,
  createSemanticErrorTracker,
  createDegradationChain,
  generateRecoverySuggestions,
  stripFence,
  parseJsonLoose,
  detectFrontendTask,
  buildFrontendDesignPrompt
} from "./longagent-utils.mjs"
import { TaskBus } from "./longagent-task-bus.mjs"
import { loadProjectMemory, saveProjectMemory, memoryToContext, parseMemoryFromPreview } from "./longagent-project-memory.mjs"
import YAML from "yaml"
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
    mode: "assistant", model, providerType, sessionId, configState, baseUrl, apiKeyEnv, signal, allowQuestion: false, toolContext
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

function buildConflictResolutionPrompt(conflictFiles) {
  return [
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
}


function parseBlueprintOutput(reply, objective, defaults) {
  const parseErrors = []

  // 1. 尝试提取 ```stage_plan_json ... ``` 块
  const jsonMatch = reply.match(/```stage_plan_json\s*([\s\S]*?)```/)
  if (jsonMatch) {
    const parsed = parseJsonLoose(jsonMatch[1])
    if (parsed?.stages) {
      const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
      if (!errors.length) {
        return { architectureText: reply.replace(/```stage_plan_json[\s\S]*?```/g, "").trim(), stagePlan: plan, parseErrors: [] }
      }
      parseErrors.push(`stage_plan_json block validation: ${errors.join("; ")}`)
    } else {
      parseErrors.push("stage_plan_json block found but no stages field")
    }
  }

  // 2. 回退：尝试任意 JSON 围栏块（排除已处理的 stage_plan_json）
  const anyJson = reply.match(/```(?:json)?\s*([\s\S]*?)```/g)
  if (anyJson) {
    for (const block of anyJson) {
      if (/```stage_plan_json/.test(block)) continue
      const inner = block.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim()
      const parsed = parseJsonLoose(inner)
      if (parsed?.stages) {
        const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
        if (!errors.length) return { architectureText: reply, stagePlan: plan, parseErrors: [] }
        parseErrors.push(`json block validation: ${errors.join("; ")}`)
      }
    }
  }

  // 3. 回退：裸 JSON — 定位含 "stages" 的最外层 {} 块
  const stripped = reply.replace(/```[\s\S]*?```/g, "")
  let braceDepth = 0, objStart = -1
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "{") { if (braceDepth === 0) objStart = i; braceDepth++ }
    else if (stripped[i] === "}") {
      braceDepth--
      if (braceDepth === 0 && objStart >= 0) {
        const candidate = stripped.slice(objStart, i + 1)
        if (candidate.includes('"stages"')) {
          const parsed = parseJsonLoose(candidate)
          if (parsed?.stages) {
            const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
            if (!errors.length) return { architectureText: reply, stagePlan: plan, parseErrors: [] }
            parseErrors.push(`bare JSON validation: ${errors.join("; ")}`)
          }
        }
        objStart = -1
      }
    }
  }

  // 4. 回退：YAML 围栏块（```yaml ... ```）
  const yamlBlocks = reply.match(/```ya?ml\s*([\s\S]*?)```/g)
  if (yamlBlocks) {
    for (const block of yamlBlocks) {
      const inner = block.replace(/```ya?ml?\s*/g, "").replace(/```/g, "").trim()
      try {
        const parsed = YAML.parse(inner)
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) continue
        if (parsed?.stages) {
          const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
          if (!errors.length) return { architectureText: reply, stagePlan: plan, parseErrors: [] }
          parseErrors.push(`yaml block validation: ${errors.join("; ")}`)
        }
      } catch (e) {
        parseErrors.push(`yaml parse error: ${e.message}`)
      }
    }
  }

  // 5. 最终回退：单任务默认计划
  if (!parseErrors.length) parseErrors.push("no JSON/YAML with stages field found in reply")
  return { architectureText: reply, stagePlan: defaultStagePlan(objective, defaults), parseErrors }
}

export function resolveHybridCompletionStatus({ completionMarkerSeen, usabilityGatesPassed }) {
  if (!usabilityGatesPassed) return "failed"
  return completionMarkerSeen ? "completed" : "done"
}

/**
 * Ultra 的入口。真正的流水线在 runHybridPipeline 里，这一层只管生命周期收尾。
 *
 * 0.4.x 没有这一层，代价是：Ctrl+C 抛出的 "provider stream cancelled"、
 * provider 异常、以及 runStageBarrier 对依赖环 / 文件所有权冲突抛出的错误，
 * 都会直接穿透整个函数 —— EventBus 上的 stop 监听器不退订（每中断一次泄漏
 * 一个），LongAgentManager 里的会话永久停在 running-longagent，checkpoint
 * 不清理。此外 blueprint 审查被拒的**正常**返回路径也漏了退订（另外两条
 * 早退路径有）。
 *
 * 现在退订只有一处：下面的 finally。
 */
export async function runHybridLongAgent(args) {
  const lifecycle = { unsubscribeStop: null }
  try {
    return await runHybridPipeline(args, lifecycle)
  } catch (err) {
    const sessionId = args?.sessionId
    if (sessionId) {
      // 中断是用户意图不是故障：会话保持 active 以便 resume；其余才算失败。
      const aborted = Boolean(args?.signal?.aborted) ||
        err?.code === "ABORT_ERR" || err?.errorClass === "aborted"
      const detail = String(err?.message || err).slice(0, 300)
      await LongAgentManager.update(sessionId, {
        status: aborted ? "aborted" : "fatal",
        lastMessage: `${aborted ? "已中断" : "内部错误"}: ${detail}`
      }).catch(() => {})
      await markSessionStatus(sessionId, aborted ? "active" : "failed").catch(() => {})
    }
    throw err
  } finally {
    lifecycle.unsubscribeStop?.()
  }
}

/**
 * runSpec 被显式接收但不向阶段透传：runSpecRole() 会整体覆盖 agent，而
 * Ultra 的每个阶段都有自己的角色（preview / blueprint / debugging），
 * 覆盖会抹掉阶段语义。0.3.x 靠解构签名里没有这个字段来「静默丢弃」，
 * 这里改为写明意图。
 */
async function runHybridPipeline({
  prompt, model, providerType, sessionId, configState,
  baseUrl = null, apiKeyEnv = null, agent = null,
  maxIterations = 0, signal = null, output = null,
  allowQuestion = true, toolContext = {}, runSpec: _runSpec = null,
  // 测试缝。生产不传，全部落到真实实现；测试据此控制门禁结果与用户交互，
  // 其余（模型回复、后台任务）走 provider 与 BackgroundManager 的既有 mock 通道。
  deps = {}
}, lifecycle) {
  const io = {
    runUsabilityGates: deps.runUsabilityGates || runUsabilityGates,
    verifyStageObjective: deps.verifyStageObjective || verifyStageObjective,
    askQuestionInteractive: deps.askQuestionInteractive || askQuestionInteractive,
    hasPromptHandler: deps.hasPromptHandler || hasPromptHandler,
    stat: deps.stat || null
  }
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
  // 同一 stage 的累计尝试次数。recoveryCount 会在每次降级后清零，
  // 这个总账不清零，作为无限重跑的硬上限。
  let stageAttempts = 0
  let currentPhase = "H0", currentGate = "init", currentStageId = null
  let gateStatus = {}, lastGateFailures = []
  let lastProgress = { percentage: 0, currentStep: 0, totalSteps: 0 }
  let finalReply = "", planFrozen = false, stagePlan = null, goal = null, goalVerification = null
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
  const maxStageAttempts = Number(longagentConfig.max_stage_attempts ?? 12)
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
      progress: lastProgress, planFrozen, stageIndex, currentStageId,
      stageCount: stagePlan?.stages?.length || 0,
      taskProgress, stageProgress: { done: stats.done, total: stats.total },
      remainingFilesCount: stats.remainingFilesCount,
      ...patch
    })
  }

  /**
   * 尝试降级一档，并在**真的降了级时**才通知用户。
   *
   * 0.4.x 的四个降级点各自内联了同一段代码，并且无条件 emit
   * LONGAGENT_DEGRADATION_APPLIED —— 不看 apply() 的返回值。默认配置下
   * 没有任何一档能生效，用户看到的那行「switch_model applied in H4」是假的。
   *
   * @returns {{applied: boolean, strategy: string|null, level?: number,
   *            skipped: string[], exhausted?: boolean, disabled?: boolean}}
   */
  async function tryDegrade({ phase, reason = "" }) {
    const ctx = { model, taskProgress, configState, shouldStop: false }
    const deg = degradationChain.apply(ctx)
    if (ctx.model !== model) model = ctx.model
    if (deg.applied) {
      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_DEGRADATION_APPLIED,
        sessionId,
        payload: { strategy: deg.strategy, level: deg.level, phase, reason, skipped: deg.skipped }
      })
    }
    return deg
  }

  // Phase 2: 事件驱动 stop 检测 — 用内存标志替代磁盘轮询
  let stopFlag = false
  // 退订句柄交给外层的 finally，见 runHybridLongAgent。
  lifecycle.unsubscribeStop = EventBus.subscribe((evt) => {
    if (evt.type === EVENT_TYPES.LONGAGENT_STOP_REQUESTED && evt.sessionId === sessionId) {
      stopFlag = true
    }
  })

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
          goal = stagePlan.goal || null   // goal 随 stagePlan 一起冻结与恢复
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

    // Task 2: 用户可见的需求确认 — 展示 intake 摘要，请用户确认或补充
    if (allowQuestion && hybridConfig.intake_user_confirm !== false) {
      const confirmPrompt = [
        "[SYSTEM] H0 需求分析完成。以下是对任务的理解摘要：",
        "",
        intakeSummary.slice(0, 1200),
        "",
        "请使用 question 工具询问用户：",
        "1. 以上需求理解是否准确？",
        "2. 是否有需要补充或修改的地方？",
        "3. 如果没有补充，回复 [确认] 或 [继续] 即可开始执行。",
        "",
        "根据用户的回复更新 intakeSummary（如有补充则合并到需求中）。"
      ].join("\n")
      const confirmOut = await processTurnLoop({
        prompt: confirmPrompt,
        mode: "assistant", model, providerType, sessionId, configState,
        baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext, output
      })
      accumulateUsage(confirmOut)
      // 如果用户提供了补充，将其合并到 intakeSummary
      const userAddition = String(confirmOut.reply || "").trim()
      const cancelKeywords = ["abort", "cancel", "取消", "中止", "停止"]
      if (cancelKeywords.some(k => userAddition.toLowerCase().includes(k))) {
        await LongAgentManager.update(sessionId, { status: "aborted", lastMessage: "user cancelled at intake confirmation" })
        await markSessionStatus(sessionId, "active")
        return { sessionId, turnId: `turn_long_${Date.now()}`, reply: "用户在需求确认阶段取消了任务。", usage: aggregateUsage, toolEvents, iterations: iteration, status: "aborted", phase: "H0", gateStatus, currentGate, lastGateFailures: [], recoveryCount: 0, progress: lastProgress, elapsed: Math.round((Date.now() - startTime) / 1000), stageIndex: 0, stageCount: 0, planFrozen: false, taskProgress: {}, fileChanges: [], stageProgress: { done: 0, total: 0 }, remainingFilesCount: 0 }
      }
      if (userAddition && !["确认", "继续", "ok", "yes", "是", "好", "没有", "no addition"].some(k => userAddition.toLowerCase().includes(k))) {
        intakeSummary = `${intakeSummary}\n\n[用户补充]\n${userAddition}`
        gateStatus.intake = { ...gateStatus.intake, userConfirmed: true, userAddition: userAddition.slice(0, 200) }
      } else {
        gateStatus.intake = { ...gateStatus.intake, userConfirmed: true }
      }
      await syncState({ lastMessage: "H0: user confirmed requirements" })
    }
  }

  // ========== H1: PREVIEW (只读探索) ==========
  await setPhase("H1", "preview")
  currentGate = "preview"
  await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_PREVIEW_START, sessionId, payload: { objective: prompt } })
  await syncState({ lastMessage: "H1: preview agent exploring codebase" })

  const previewModel = getModelForStage("preview")
  // #5 注入 project memory 到 preview prompt
  const memCtx = projectMemory ? memoryToContext(projectMemory) : ""
  const previewPrompt = buildStageWrapper(ULTRA_STAGES.PREVIEW, { preview: null, blueprint: null, coding: null }, memCtx ? `${memCtx}\n\n${intakeSummary}` : intakeSummary)
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
  // Task 4: 检测前端任务，注入设计风格提示词
  const isFrontend = detectFrontendTask(prompt)
  const frontendBlock = isFrontend
    ? "\n\n" + buildFrontendDesignPrompt(configState.config.agent?.design_style || "")
    : ""
  const goalIntent = classifyGoalIntent(prompt)
  const blueprintPrompt = buildStageWrapper(ULTRA_STAGES.BLUEPRINT, { preview: previewFindings, blueprint: null, coding: null }, prompt)
    + frontendBlock
    + [
      "\n\n## HYBRID MODE: STRUCTURED EXECUTION PLAN (REQUIRED)",
      "In addition to your architecture design, you MUST output a machine-parseable stage plan.",
      "",
      "Wrap it in a ```stage_plan_json ... ``` fenced block. Schema:",
      '{"planId":"...","objective":"...","goal":{...see GOAL CONTRACT below...},"stages":[{"stageId":"...","name":"...","passRule":"all_success","tasks":[{"taskId":"...","prompt":"detailed task prompt for sub-agent","plannedFiles":["file1.mjs","file2.mjs"],"acceptance":["node --check file1.mjs","node --test test/file1.test.mjs"],"timeoutMs":600000,"maxRetries":2,"complexity":"low|medium|high"}]}]}',
      "",
      "Rules for the stage plan:",
      "- Each task prompt must be SELF-CONTAINED: the sub-agent has NO access to your blueprint text",
      "- plannedFiles must list EVERY file the task will create or modify (no file in multiple tasks)",
      // 判据书写规则单一来源（ultra-stages.mjs），三处重复合并于此
      ...ACCEPTANCE_RULES,
      "- Files that import each other MUST be in the same task",
      "- A module and its test file MUST be in the same task",
      "- Order stages by dependency: shared types → core logic → integration → validation",
      "",
      buildGoalPlanContract(goalIntent)
    ].join("\n")
  const blueprintOut = await processTurnLoop({
    prompt: blueprintPrompt, mode: "agent", agent: getAgent("blueprint-agent"),
    model: blueprintModel.model, providerType: blueprintModel.providerType,
    sessionId, configState, baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
  })
  accumulateUsage(blueprintOut)

  const planDefaults = { timeoutMs: Number(parallelConfig.task_timeout_ms || 600000), maxRetries: Number(parallelConfig.task_max_retries ?? 2) }
  let { architectureText, stagePlan: parsedPlan, parseErrors } = parseBlueprintOutput(blueprintOut.reply || "", prompt, planDefaults)

  // Blueprint 解析失败重试：用 repair prompt 要求 LLM 只输出合法 JSON
  const maxBlueprintRetries = Number(hybridConfig.blueprint_parse_retries || 1)
  if (parseErrors.length > 0 && maxBlueprintRetries > 0) {
    for (let retryIdx = 0; retryIdx < maxBlueprintRetries; retryIdx++) {
      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_ALERT, sessionId,
        payload: {
          kind: "blueprint_parse_retry",
          message: `第 ${retryIdx + 1} 次重解析 blueprint：${parseErrors.join("; ").slice(0, 200)}`,
          attempt: retryIdx + 1,
          errors: parseErrors
        }
      })
      const repairPrompt = [
        "Your previous blueprint output could not be parsed into a valid stage plan.",
        `Parse errors: ${parseErrors.join("; ")}`,
        "",
        "Output ONLY a valid JSON object (no markdown, no explanation) with this schema:",
        '{"planId":"...","objective":"...","stages":[{"stageId":"...","name":"...","tasks":[{"taskId":"...","prompt":"...","plannedFiles":["..."],"acceptance":["..."],"timeoutMs":600000,"maxRetries":2,"complexity":"medium"}]}]}',
        "",
        `Objective: ${prompt}`
      ].join("\n")
      const repairOut = await processTurnLoop({
        prompt: repairPrompt, mode: "assistant",
        model: blueprintModel.model, providerType: blueprintModel.providerType,
        sessionId, configState, baseUrl, apiKeyEnv, signal,
        output: { write: () => {} }, allowQuestion: false
      })
      accumulateUsage(repairOut)
      const retry = parseBlueprintOutput(repairOut.reply || "", prompt, planDefaults)
      if (retry.parseErrors.length === 0) {
        architectureText = architectureText || retry.architectureText
        parsedPlan = retry.stagePlan
        parseErrors = []
        break
      }
      parseErrors = retry.parseErrors
    }
  }

  stagePlan = parsedPlan
  planFrozen = true

  // ===== Goal 冻结 =====
  // blueprint 随计划输出的 goal 块（validateAndNormalizeStagePlan 已归一化到
  // plan.goal）。没有输出时按目标类型合成兜底：task 级 acceptanceChecks 提升为
  // goal 判据；一条都没有就落一条 manual —— 目标至少要有一个「谁说了算」，
  // 而「没人说了算」的诚实答案是问用户。
  goal = stagePlan.goal || null
  let goalSource = "blueprint"
  if (!goal) {
    goalSource = "synthesized"
    const promoted = stagePlan.stages
      .flatMap((s) => (s.tasks || []).flatMap((t) => t.acceptanceChecks || []))
      .slice(0, 8)
    const { goal: synthesized } = normalizeGoal({
      objective: prompt,
      intent: goalIntent,
      criteria: promoted.length ? promoted : [`请人工确认目标已达成：${prompt.slice(0, 120)}`]
    }, { objective: prompt, stageIds: stagePlan.stages.map((s) => s.stageId) })
    goal = synthesized
  } else if (stagePlan.goalErrors?.length) {
    goalSource = "blueprint_with_errors"
  }
  goal = freezeGoal(goal, { round: 1 })
  stagePlan.goal = goal
  gateStatus.goal = {
    status: "frozen",
    intent: goal.intent,
    criteriaCount: goal.criteria.length,
    subGoalCount: goal.subGoals.length,
    source: goalSource
  }

  const blueprintFellBack = parseErrors.length > 0
  gateStatus.blueprint = {
    status: blueprintFellBack ? "warn" : "pass",
    hasArchitecture: architectureText.length > 100,
    stageCount: stagePlan.stages.length,
    parseErrors: blueprintFellBack ? parseErrors : undefined
  }
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

  // #2 人工审查检查点（Task 2: 默认 ON，用户可见的 Blueprint 确认）
  if (hybridConfig.blueprint_review !== false && allowQuestion) {
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_BLUEPRINT_REVIEW, sessionId, payload: { planId: stagePlan.planId } })
    const stageList = stagePlan.stages.map((s, i) => `  ${i + 1}. ${s.name || s.stageId} (${(s.tasks || []).length} 个任务)`).join("\n")
    const reviewOut = await processTurnLoop({
      prompt: [
        `[SYSTEM] H2 Blueprint 已生成，包含 ${stagePlan.stages.length} 个执行阶段：`,
        stageList,
        "",
        "架构摘要：",
        architectureText.slice(0, 1200),
        "",
        "请使用 question 工具询问用户：",
        "1. 以上执行计划是否符合预期？",
        "2. 是否有需要调整的阶段或任务？",
        "3. 确认后将开始执行，输入 [确认]/[继续]/yes 开始，输入 [取消]/abort 中止。",
        "",
        "根据用户回复决定是否继续执行。"
      ].join("\n"),
      mode: "assistant", model, providerType, sessionId, configState, baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext, output
    })
    accumulateUsage(reviewOut)
    const answer = String(reviewOut.reply || "").toLowerCase().trim()
    if (["no", "否", "n", "取消", "abort", "cancel", "中止", "停止"].some(k => answer.includes(k))) {
      await LongAgentManager.update(sessionId, { status: "aborted", lastMessage: "user rejected blueprint" })
      await markSessionStatus(sessionId, "active")
      return { sessionId, turnId: `turn_long_${Date.now()}`, reply: "用户中止了 Blueprint 审查。", usage: aggregateUsage, toolEvents, iterations: iteration, status: "aborted", phase: "H2", gateStatus, currentGate, lastGateFailures: [], recoveryCount: 0, progress: lastProgress, elapsed: Math.round((Date.now() - startTime) / 1000), stageIndex: 0, stageCount: stagePlan.stages.length, planFrozen, taskProgress: {}, fileChanges: [], stageProgress: { done: 0, total: 0 }, remainingFilesCount: 0 }
    }
    gateStatus.blueprintReview = { status: "pass", userConfirmed: true }
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
        mode: "assistant", model, providerType, sessionId, configState, baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext
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
      if (stopFlag || signal?.aborted) break

      // Phase 2: 阶段超时检测
      if (Date.now() - codingPhaseStart > codingPhaseTimeoutMs) {
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_PHASE_TIMEOUT, sessionId, payload: { phase: "H4", elapsed: Date.now() - codingPhaseStart } })
        // 降不动了就停。0.4.x 在 apply() 返回 !applied 时既不 break 也不降级，
        // 于是每次迭代都重新 emit 一遍超时事件，刷屏且永不收敛。
        const deg = await tryDegrade({ phase: "H4", reason: "phase_timeout" })
        if (!deg.applied || deg.strategy === "graceful_stop") break
      }

      iteration++
      const stage = stagePlan.stages[stageIndex]
      currentGate = `stage:${stage.stageId}`
      currentStageId = stage.stageId
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

      let stageResult
      try {
        stageResult = await runStageBarrier({
          stage, sessionId, config: configState.config, model, providerType,
          seedTaskProgress: seeded, objective: prompt,
          stageIndex, stageCount: stagePlan.stages.length, priorContext: planAnchor + priorContext,
          stuckTracker,
          onTaskComplete: async (taskData) => {
            await saveTaskCheckpoint(sessionId, taskData.stageId, taskData.taskId, taskData)
          },
          taskBus
        })
      } catch (barrierErr) {
        // 计划结构缺陷：文件所有权重叠、或 task 之间存在依赖环。
        // stage-scheduler 对这两种情况直接 throw，而 0.4.x 这里没有 try/catch,
        // 异常穿透整个 runHybridLongAgent —— 用户拿到一句裸错误，已完成的
        // 工作全部丢失。这是计划本身的毛病，重跑同一个计划不会有任何改善，
        // 所以放弃 H4 但带着已有产物走完后续流程。
        // （0.5.0 阶段 4 会把这里改成触发重规划而不是放弃。）
        const detail = String(barrierErr?.message || barrierErr).slice(0, 300)
        gateStatus[stage.stageId] = { status: "fail", kind: "plan_defect", reason: detail }
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_ALERT,
          sessionId,
          payload: {
            kind: "plan_defect",
            message: `stage ${stage.stageId} 计划缺陷：${detail}`,
            stageId: stage.stageId
          }
        })
        await syncState({
          status: "error",
          stageStatus: "fail",
          lastMessage: `H4: ${stage.stageId} 计划缺陷，放弃编码阶段 — ${detail}`
        })
        break
      }

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
      // #4 TaskBus 增量注入到 priorContext（只包含本阶段新消息）
      if (taskBus) {
        const busCtx = taskBus.toDeltaString()
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
        // LONGAGENT_GIT_STAGE_COMMITTED 的渲染分支一直都在，只是从来没有人发过。
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_GIT_STAGE_COMMITTED,
          sessionId,
          payload: { stageId: stage.stageId, message: msg }
        })
      }

      // #10 增量门控：每个 stage 完成后运行轻量检查
      if (hybridConfig.incremental_gates !== false && stageResult.allSuccess && stageIndex < stagePlan.stages.length - 1) {
        const stageFiles = (stageResult.fileChanges || []).map(f => f.path).filter(Boolean)
        if (stageFiles.length > 0) {
          const miniGate = await io.runUsabilityGates({
            sessionId,
            config: configState.config,
            cwd,
            iteration
          })
          gateStatus[`gate_${stage.stageId}`] = { status: miniGate.allPass ? "pass" : "warn" }
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_INCREMENTAL_GATE, sessionId, payload: { stageId: stage.stageId, passed: miniGate.allPass } })
          // #18: Feed gate results into priorContext so subsequent stages see lint/typecheck feedback
          if (!miniGate.allPass && miniGate.failures?.length) {
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
          const deg = await tryDegrade({ phase: "H4", reason: "budget_exceeded" })
          if (!deg.applied || deg.strategy === "graceful_stop") {
            await syncState({ status: "budget_exceeded", lastMessage: `H4: budget exceeded (${totalTokens}/${budgetLimit})` })
            break
          }
        }
      }

      if (!stageResult.allSuccess) {
        // 重跑之前先问一句「目标是不是其实已经达成了」。allSuccess 只反映
        // worker 有没有吐出完成标记；文件早就写好、测试早就通过却因为缺个
        // 标记而重跑整个 stage，是 H4 迟迟不收敛的主因。
        const objective = await io.verifyStageObjective({
          stage,
          cwd: process.cwd(),
          config: configState.config,
          sessionId,
          iteration,
          deps: { runUsabilityGates: io.runUsabilityGates, ...(io.stat ? { stat: io.stat } : {}) }
        })
        if (objective.status === OBJECTIVE_MET) {
          await EventBus.emit({
            type: EVENT_TYPES.LONGAGENT_STAGE_FINISHED,
            sessionId,
            payload: { stageId: stage.stageId, via: "objective_verified", reason: objective.reason }
          })
          await syncState({
            stageStatus: "pass",
            lastMessage: `H4: ${stage.stageId} objective verified (${objective.reason})`
          })
          stageIndex++
          recoveryCount = 0
          stageAttempts = 0
          continue
        }

        recoveryCount++
        const backoffMs = Math.min(1000 * 2 ** (recoveryCount - 1), 30000)
        // 同上：渲染分支早就写好了，但没有任何地方发这个事件 —— 于是 stage
        // 反复重跑时用户只看到长时间没有输出，不知道后台正在退避重试。
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_RECOVERY_ENTERED,
          sessionId,
          payload: {
            recoveryCount,
            reason: `stage ${stage.stageId} 失败 ${stageResult.failCount} 个任务，${Math.round(backoffMs / 1000)}s 后重试`,
            stageId: stage.stageId,
            backoffMs
          }
        })
        await new Promise(r => setTimeout(r, backoffMs))
        const maxStageRecoveries = Number(longagentConfig.max_stage_recoveries ?? 3)
        if (recoveryCount >= maxStageRecoveries) {
          // Phase 6: 尝试降级而非直接 abort
          const deg = await tryDegrade({ phase: "H4", reason: "max_recoveries" })
          if (!deg.applied || deg.strategy === "graceful_stop") {
            await syncState({
              status: "error",
              lastMessage: deg.applied
                ? `stage ${stage.stageId} aborted after degradation`
                : `stage ${stage.stageId} aborted after ${recoveryCount} recoveries`
            })
            break
          }
          // 降级成功但非 graceful_stop，重置 recoveryCount 继续。
          // 但要记总账：不然每次降级都清零计数，同一个 stage 可以一直
          // 重跑到阶段超时为止。
          stageAttempts += recoveryCount
          recoveryCount = 0
          if (stageAttempts >= maxStageAttempts) {
            await syncState({
              status: "error",
              lastMessage: `stage ${stage.stageId} aborted after ${stageAttempts} total attempts`
            })
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
      stageAttempts = 0
      await saveCheckpoint(sessionId, { name: `hybrid_stage_${stage.stageId}`, iteration, currentPhase, stageIndex, stagePlan, taskProgress, planFrozen, lastProgress })
    }

    // #11 Cross-review + H5 ghost commit 并行化
    // Phase 2 改进: ghost commit 不依赖 cross-review 结果，提前启动并行执行
    const ghostCommitPromise = gitActive
      ? git.createGhostCommit(cwd, `[kkcode] pre-debug savepoint session ${sessionId}`).catch(() => null)
      : Promise.resolve(null)

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
      if (reviewOut.reply) priorContext += `\n### Cross-Review Findings\n${reviewOut.reply.slice(0, 1500)}\n`
    }

    // --- H5: DEBUGGING (回滚检测) ---
    await setPhase("H5", "debugging")
    currentGate = "debugging"

    // 等待并行启动的 ghost commit 完成
    const gcResult = await ghostCommitPromise
    const debugSavepoint = gcResult?.ok ? (gcResult.ghostCommit?.commitHash || null) : null

    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_HYBRID_DEBUGGING_START, sessionId, payload: { codingRollbackCount, debugSavepoint } })
    await syncState({ lastMessage: "H5: debugging agent verifying implementation" })

    const debugModel = getModelForStage("debugging")
    const debugPrompt = buildStageWrapper(ULTRA_STAGES.DEBUGGING, {
      preview: previewFindings.slice(0, 2000),
      blueprint: architectureText.slice(0, 3000),
      coding: priorContext.slice(0, 4000)
    }, prompt)

    let debugIter = 0
    let debugDone = false
    let debugRecoveryHint = "" // Phase 2 改进: stuck 恢复提示注入
    const semanticTracker = createSemanticErrorTracker(3)
    const debugPhaseStart = Date.now()

    while (!debugDone && debugIter < maxDebugIterations) {
      debugIter++
      iteration++
      if (stopFlag || signal?.aborted) break

      // Phase 2: debugging 阶段超时检测
      if (Date.now() - debugPhaseStart > debuggingPhaseTimeoutMs) {
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_PHASE_TIMEOUT, sessionId, payload: { phase: "H5", elapsed: Date.now() - debugPhaseStart } })
        const deg = await tryDegrade({ phase: "H5", reason: "phase_timeout" })
        if (!deg.applied || deg.strategy === "graceful_stop") break
      }

      const effectiveDebugPrompt = debugRecoveryHint ? `${debugRecoveryHint}\n\n${debugPrompt}` : debugPrompt
      const debugOut = await processTurnLoop({
        prompt: effectiveDebugPrompt, mode: "agent", agent: getAgent("debugging-agent"),
        model: debugModel.model, providerType: debugModel.providerType,
        sessionId, configState, baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
      })
      accumulateUsage(debugOut)
      finalReply = debugOut.reply || ""
      debugRecoveryHint = "" // 每次迭代后清空恢复提示

      // 防卡死检测
      if (debugOut.toolEvents?.length) {
        const stuckResult = stuckTracker.track(debugOut.toolEvents)
        if (stuckResult.isStuck) {
          stuckTracker.resetReadOnlyCount()
          await EventBus.emit({
            type: EVENT_TYPES.LONGAGENT_ALERT, sessionId,
            payload: {
              kind: "stuck_warning",
              message: `H5 第 ${debugIter} 轮原地打转：${stuckResult.reason}`,
              stage: "H5:debugging",
              reason: stuckResult.reason,
              debugIter
            }
          })
          await syncState({ lastMessage: `H5: stuck detected (${stuckResult.reason}), iter ${debugIter}` })
          // Phase 2 改进: 注入恢复提示，引导 agent 换策略
          debugRecoveryHint = [
            "## Recovery Hint — Stuck Pattern Detected",
            `Previous iteration was stuck: ${stuckResult.reason}.`,
            "You MUST change your approach. Try one of these strategies:",
            "1. If reading the same files repeatedly — stop reading and start making changes",
            "2. If the same test keeps failing — re-read the error, check a different root cause",
            "3. If edits are not taking effect — verify the file path and check for syntax errors",
            "4. Consider reverting recent changes and trying a fundamentally different fix"
          ].join("\n")
        }
      }

      // Phase 5: 语义级错误检测
      const semResult = semanticTracker.track(finalReply)
      if (semResult.isRepeated) {
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_SEMANTIC_ERROR_REPEATED, sessionId,
          payload: { error: semResult.error, count: semResult.count, debugIter }
        })
        await syncState({ lastMessage: `H5: repeated error detected (${semResult.count}x): ${(semResult.error || "").slice(0, 80)}` })
        // Phase 2 改进: 语义重复错误超阈值强制退出，防止无限循环
        const maxSemanticRepeats = 5
        if (semResult.count >= maxSemanticRepeats) {
          debugDone = true
          gateStatus.debugging = { status: "force_exit", reason: "semantic_repeat_limit", error: (semResult.error || "").slice(0, 200), iterations: debugIter }
          await EventBus.emit({
            type: EVENT_TYPES.LONGAGENT_ALERT,
            sessionId,
            payload: {
              kind: "semantic_force_exit",
              message: `同一个错误重复 ${semResult.count} 次，强制退出 H5：${String(semResult.error || "").slice(0, 120)}`,
              count: semResult.count,
              error: semResult.error,
              debugIter
            }
          })
          await syncState({ lastMessage: `H5: force exit — same error repeated ${semResult.count} times` })
        }
      }

      if (detectStageComplete(finalReply, ULTRA_STAGES.DEBUGGING)) {
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
    const needsAsking = !hasPrefs || gatesConfig.prompt_user === "always"
    // 问得出结果吗？没有 TUI handler 又没有 TTY，askQuestionInteractive 只会
    // 返回空串 —— 那不是用户的选择，不能当成回答。必须现场判断，不能缓存：
    // REPL 退出流程会把 handler 置空。
    const canAskUser = io.hasPromptHandler() || Boolean(process.stdout.isTTY && process.stdin.isTTY)

    if (needsAsking && !canAskUser) {
      // 0.4.x 在这里照问不误：空回复被 parseGateSelection 解析成「全部关闭」，
      // 再被 saveGatePreferences 永久写进用户级 gate-preferences.json，
      // 此后该用户所有项目、所有 Ultra 会话的门禁统统失效且毫无提示。
      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_ALERT,
        sessionId,
        payload: {
          kind: "gate_prefs_skipped",
          message: "非交互环境，跳过门禁偏好询问，沿用当前配置（不写入用户偏好）"
        }
      })
    } else if (needsAsking) {
      const gateAssistantResult = await processTurnLoop({
        prompt: buildGatePromptText(),
        mode: "assistant", model, providerType, sessionId, configState,
        baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext
      })
      accumulateUsage(gateAssistantResult)
      const gatePrefs = parseGateSelection(gateAssistantResult.reply)
      if (!gatePrefs) {
        // 回复里一个门禁名都没有 —— 没问出结果，别乱写盘
        await EventBus.emit({
          type: EVENT_TYPES.LONGAGENT_ALERT,
          sessionId,
          payload: {
            kind: "gate_prefs_unparsed",
            message: `无法从回复中解析门禁选择，沿用当前配置：${String(gateAssistantResult.reply || "").slice(0, 80)}`
          }
        })
      } else {
        await saveGatePreferences(gatePrefs)
        for (const [gate, enabled] of Object.entries(gatePrefs)) {
          if (configState.config.agent.longagent.usability_gates[gate]) {
            configState.config.agent.longagent.usability_gates[gate].enabled = enabled
          }
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
  let usabilityGatesPassed = false
  let lastGateResult = null   // 交给目标核验复用，同一轮里不重复跑 build/test

  while (gateAttempt < maxGateAttempts) {
    gateAttempt++
    if (stopFlag || signal?.aborted) break

    const gateResult = await io.runUsabilityGates({
      sessionId,
      config: configState.config,
      cwd,
      iteration
    })
    lastGateResult = gateResult

    if (gateResult.allPass) {
      usabilityGatesPassed = true
      lastGateFailures = []
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

    // 给模型的是**完整详情**（含末 12 行输出），不是状态栏那句一行摘要 ——
    // 下面的 Fix Protocol 第一条就是「读错误输出」，得先真的有错误输出。
    const gateFailureDetail = formatGateFailureDetail(lastGateFailures)
    const fixPrompt = [
      `## Quality Gate Failures — Attempt ${gateAttempt}/${maxGateAttempts}`,
      "",
      `${strategy.prefix || "Fix the following quality gate failures:"}`,
      "",
      gateFailureDetail,
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

  if (!usabilityGatesPassed) {
    gateStatus.usabilityGates = { status: "fail", attempt: gateAttempt, failures: summarizeGateFailures(lastGateFailures) }
  }

  // ========== 目标核验 ==========
  // 0.5.0 阶段 2：先只记录，不改变控制流 —— 让真实模型验收先观察判据质量，
  // 阶段 4 的轮次循环才开始消费这个结果。gateResult 复用 H6 的最后一次，
  // 避免同一轮里重复跑 build/test。
  if (goal) {
    try {
      goalVerification = await verifyGoal({
        goal,
        cwd,
        config: configState.config,
        gateResult: lastGateResult,
        deps: io.stat ? { stat: io.stat } : {}
      })
      gateStatus.goalVerification = {
        status: goalVerification.status,
        passed: goalVerification.passed,
        failed: goalVerification.failed,
        unknown: goalVerification.unknown,
        manual: goalVerification.manual
      }
      await syncState({
        lastMessage: `goal: ${goalVerification.status} (${goalVerification.passed} pass / ${goalVerification.failed} fail / ${goalVerification.manual} manual)`
      })
    } catch (verifyErr) {
      gateStatus.goalVerification = { status: "error", reason: String(verifyErr?.message || verifyErr).slice(0, 200) }
    }
  }

  // ========== H7: GIT MERGE (原子性保护) ==========
  if (usabilityGatesPassed && gitActive && gitBaseBranch && gitBranch) {
    await setPhase("H7", "git_merge")
    try {
      if (gitConfig.auto_merge !== false) {
        await LongAgentManager.withLock(async () => {
          const doneState = await LongAgentManager.get(sessionId)
          if (doneState?.status === "failed") return

          // Step 1: 提交 feature branch 上的最终变更（锁内执行，防止并发）
          const finalCommit = await git.commitAll(`[kkcode-hybrid] session ${sessionId} completed`, cwd)
          if (!finalCommit.ok && !finalCommit.empty) {
            gateStatus.gitMerge = { status: "warn", reason: `final commit failed: ${finalCommit.message}` }
            return
          }

          // Step 2: 保存 savepoint — 记录 feature branch HEAD 用于回滚
          const featureHead = await git.getHeadHash(cwd)

          // Step 3: checkout base branch
          const checkoutResult = await git.checkoutBranch(gitBaseBranch, cwd)
          if (!checkoutResult.ok) {
            await git.checkoutBranch(gitBranch, cwd).catch(() => {})
            gateStatus.gitMerge = { status: "warn", reason: `checkout base failed: ${checkoutResult.message}` }
            return
          }

          // Step 4: 保存 base branch HEAD（merge 失败时回滚到此）
          const baseHead = await git.getHeadHash(cwd)

          // Step 5: 执行 merge
          const mergeResult = await git.mergeBranch(gitBranch, cwd)
          if (mergeResult.ok) {
            // Step 6: post-merge 验证 — 确认 HEAD 包含 feature 分支的变更
            const mergedHead = await git.getHeadHash(cwd)
            if (!mergedHead || mergedHead === baseHead) {
              // merge 声称成功但 HEAD 未变化，回滚
              if (baseHead) await git.resetTo(baseHead, cwd).catch(() => {})
              await git.checkoutBranch(gitBranch, cwd).catch(() => {})
              gateStatus.gitMerge = { status: "warn", reason: "merge reported success but HEAD unchanged" }
              return
            }
            await git.deleteBranch(gitBranch, cwd)
            gateStatus.gitMerge = { status: "pass", branch: gitBranch, baseBranch: gitBaseBranch }
            await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_MERGED, sessionId, payload: { branch: gitBranch, baseBranch: gitBaseBranch } })
            return
          }

          // Step 7: merge 失败 — 检查是否为冲突
          const conflictFiles = await git.getConflictFiles(cwd)
          if (conflictFiles.length === 0) {
            // 非冲突类 merge 失败 — 回滚到 base HEAD，回到 feature branch
            if (baseHead) await git.resetTo(baseHead, cwd).catch(() => {})
            await git.checkoutBranch(gitBranch, cwd).catch(() => {})
            gateStatus.gitMerge = { status: "warn", reason: `merge failed: ${mergeResult.message}` }
            return
          }

          // Step 8: 冲突自愈 — 原子化处理
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_CONFLICT_RESOLUTION, sessionId, payload: { files: conflictFiles } })
          try {
            const conflictPrompt = buildConflictResolutionPrompt(conflictFiles)
            const conflictOut = await processTurnLoop({
              prompt: conflictPrompt, mode: "agent", agent: getAgent("coding-agent"),
              model, providerType, sessionId, configState,
              baseUrl, apiKeyEnv, signal, output, allowQuestion: false, toolContext
            })
            accumulateUsage(conflictOut)

            // Step 9: 验证冲突标记已全部清除
            const markersRemain = await git.hasConflictMarkers(cwd)
            if (markersRemain) {
              throw new Error("conflict markers still present after resolution")
            }

            const commitResult = await git.commitAll(`[kkcode-hybrid] resolved merge conflicts`, cwd)
            if (commitResult.ok) {
              await git.deleteBranch(gitBranch, cwd)
              gateStatus.gitMerge = { status: "pass", branch: gitBranch, baseBranch: gitBaseBranch, conflictsResolved: true }
              await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_MERGED, sessionId, payload: { branch: gitBranch, baseBranch: gitBaseBranch } })
              return
            }
            throw new Error(`commit after conflict resolution failed: ${commitResult.message}`)
          } catch (resolveErr) {
            // Step 10: 冲突解决失败 — 精确回滚
            await git.mergeAbort(cwd).catch(() => {})
            if (baseHead) await git.resetTo(baseHead, cwd).catch(() => {})
            await git.checkoutBranch(gitBranch, cwd).catch(() => {})
            if (featureHead) await git.resetTo(featureHead, cwd).catch(() => {})
            gateStatus.gitMerge = { status: "warn", reason: `conflict resolution failed: ${resolveErr.message}` }
          }
        }, cwd)
      }
    } catch (h7Err) {
      // 记录错误而非静默吞掉
      gateStatus.gitMerge = gateStatus.gitMerge || { status: "warn", reason: `H7 error: ${h7Err.message}` }
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
  const finalStatus = resolveHybridCompletionStatus({ completionMarkerSeen, usabilityGatesPassed })
  const finalMessage = finalStatus === "failed"
    ? "hybrid longagent failed usability gates"
    : "hybrid longagent complete"
  await LongAgentManager.update(sessionId, { status: finalStatus, lastMessage: finalMessage, elapsed })
  await markSessionStatus(
    sessionId,
    finalStatus === "completed" ? "completed" : finalStatus === "failed" ? "failed" : "active"
  )

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
    reply: finalStatus === "failed"
      ? [finalReply, finalMessage].filter(Boolean).join("\n\n")
      : finalReply || finalMessage,
    usage: aggregateUsage, toolEvents, iterations: iteration,
    status: finalStatus, phase: currentPhase,
    gateStatus, currentGate, lastGateFailures, recoveryCount,
    progress: lastProgress, elapsed,
    stageIndex, stageCount: stagePlan?.stages?.length || 0,
    // status-bar.mjs 与 repl.mjs 一直在读 currentStageId，而这里从来没返回过它，
    // 于是状态栏永远退化成 "i/n" 而不是阶段名。
    currentStageId,
    goal, goalVerification,
    planFrozen, taskProgress, fileChanges,
    stageProgress: { done: stats.done, total: stats.total },
    remainingFilesCount: stats.remainingFilesCount,
    gitBranch, gitBaseBranch,
    recoverySuggestions
  }
}
