import { LongAgentManager } from "../orchestration/longagent-manager.mjs"
import { processTurnLoop } from "./loop.mjs"
import { markSessionStatus } from "./store.mjs"
import { EventBus } from "../core/events.mjs"
import {
  EVENT_TYPES,
  LONGAGENT_4STAGE_STAGES
} from "../core/constants.mjs"
import { saveCheckpoint } from "./checkpoint.mjs"
import { getAgent } from "../agent/agent.mjs"
import { createStuckTracker, isReadOnlyTool } from "./longagent-utils.mjs"
import * as git from "../util/git.mjs"

export function detectStageComplete(text, stage) {
  const str = String(text || "")
  const markers = {
    [LONGAGENT_4STAGE_STAGES.PREVIEW]: /\[STAGE 1\/4: PREVIEW(?:ING AGENT)? - COMPLETE\]/,
    [LONGAGENT_4STAGE_STAGES.BLUEPRINT]: /\[STAGE 2\/4: BLUEPRINT(?:\s+AGENT)? - COMPLETE\]/,
    [LONGAGENT_4STAGE_STAGES.CODING]: /\[STAGE 3\/4: CODING(?:\s+AGENT)? - COMPLETE\]/,
    [LONGAGENT_4STAGE_STAGES.DEBUGGING]: /\[STAGE 4\/4: DEBUGGING(?:\s+AGENT)? - COMPLETE\]/
  }
  return markers[stage] ? markers[stage].test(str) : false
}

export function detectReturnToCoding(text) {
  return /\[RETURN TO STAGE 3/.test(String(text || ""))
}

export function buildStageWrapper(stage, context, userPrompt, warningMsg = null) {
  const stageInfo = {
    [LONGAGENT_4STAGE_STAGES.PREVIEW]: { num: "1/4", name: "PREVIEW", focus: "Explore project, understand requirements, extract key information", readonly: true },
    [LONGAGENT_4STAGE_STAGES.BLUEPRINT]: { num: "2/4", name: "BLUEPRINT", focus: "Detailed planning, architecture design, function definitions", readonly: true },
    [LONGAGENT_4STAGE_STAGES.CODING]: { num: "3/4", name: "CODING", focus: "Implement code strictly according to blueprint", readonly: false },
    [LONGAGENT_4STAGE_STAGES.DEBUGGING]: { num: "4/4", name: "DEBUGGING", focus: "Verify implementation, test, debug, validate completion", readonly: false }
  }
  const info = stageInfo[stage]
  const parts = [
    `=== LONGAGENT STAGE ${info.num}: ${info.name} ===`,
    "",
    `# STAGE OBJECTIVE: ${info.focus}`,
    "",
    `IMPORTANT: You are in STAGE ${info.num} of the four-stage LongAgent workflow.`,
    ""
  ]

  if (info.readonly) {
    parts.push(
      "## PERMISSION CONSTRAINTS",
      "YOU ARE IN READ-ONLY MODE FOR THIS STAGE.",
      "- You MAY use: read, glob, grep, list, bash, question, todowrite",
      "- You MUST NOT use: write, edit, patch, or any file modification tools",
      ""
    )
  }

  parts.push("## YOUR TASKS FOR THIS STAGE:")
  if (stage === LONGAGENT_4STAGE_STAGES.PREVIEW) {
    parts.push(
      "1. Explore the entire project structure using glob/list",
      "2. Understand the current codebase and technology stack",
      "3. Extract key requirements from the user's request",
      "4. Identify existing patterns and utilities that can be reused",
      "5. Document your findings clearly"
    )
  } else if (stage === LONGAGENT_4STAGE_STAGES.BLUEPRINT) {
    parts.push(
      "1. Create a detailed implementation plan",
      "2. Design the architecture and component structure",
      "3. Define functions, APIs, and data structures",
      "4. Specify which files to create/modify",
      "5. Provide a step-by-step execution roadmap"
    )
  } else if (stage === LONGAGENT_4STAGE_STAGES.CODING) {
    parts.push(
      "1. Follow the blueprint from Stage 2 EXACTLY",
      "2. Implement the code with proper error handling",
      "3. Respect project conventions and existing patterns",
      "4. Keep changes focused and minimal",
      "5. Document what you've implemented"
    )
  } else if (stage === LONGAGENT_4STAGE_STAGES.DEBUGGING) {
    parts.push(
      "1. Verify that ALL blueprint requirements are met",
      "2. Run tests and check for errors",
      "3. Debug and fix any issues found",
      "4. Validate the implementation end-to-end",
      "5. If major issues found, output [RETURN TO STAGE 3: CODING]",
      "",
      "## IMPORTANT: AFTER VERIFICATION IS COMPLETE:",
      "- Provide a clear summary of what was implemented",
      "- Explain how to use the code/tool/project",
      "- Give usage examples and commands",
      "- Mention any key files or configuration needed"
    )
  }

  parts.push("", "## STAGE COMPLETION", `When you have completed this stage, end your response with:`, "```", `[STAGE ${info.num}: ${info.name} - COMPLETE]`, "```")

  if (context.preview && stage !== LONGAGENT_4STAGE_STAGES.PREVIEW) {
    parts.push("", "=== PREVIEW STAGE CONTEXT ===", context.preview)
  }
  if (context.blueprint && (stage === LONGAGENT_4STAGE_STAGES.CODING || stage === LONGAGENT_4STAGE_STAGES.DEBUGGING)) {
    parts.push("", "=== BLUEPRINT STAGE CONTEXT ===", context.blueprint)
  }
  if (context.coding && stage === LONGAGENT_4STAGE_STAGES.DEBUGGING) {
    parts.push("", "=== CODING STAGE OUTPUT ===", context.coding)
  }

  if (warningMsg) {
    parts.push("", "=== WARNING ===", warningMsg, "")
  }

  parts.push("", "=== USER OBJECTIVE ===", userPrompt)
  return parts.join("\n")
}

export async function run4StageLongAgent({
  prompt, model, providerType, sessionId, configState,
  baseUrl = null, apiKeyEnv = null, agent = null, signal = null,
  output = null, allowQuestion = true, toolContext = {}
}) {
  const longagentConfig = configState.config.agent.longagent || {}
  const fourStageConfig = longagentConfig.four_stage || {}
  const gitConfig = longagentConfig.git || {}
  const gitEnabled = gitConfig.enabled === true || gitConfig.enabled === "ask"
  const gitAsk = gitConfig.enabled === "ask"

  let iteration = 0
  let currentStage = LONGAGENT_4STAGE_STAGES.PREVIEW
  let currentStageIteration = 0
  const stageContext = { preview: null, blueprint: null, coding: null }
  let finalReply = ""
  const aggregateUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const toolEvents = []
  const startTime = Date.now()
  let completionMarkerSeen = false
  let gitBranch = null, gitBaseBranch = null, gitActive = false
  let stuckWarningMsg = null
  const stuckTracker = createStuckTracker()

  const stageMaxIterations = {
    [LONGAGENT_4STAGE_STAGES.PREVIEW]: Number(fourStageConfig.preview_max_iterations || 10),
    [LONGAGENT_4STAGE_STAGES.BLUEPRINT]: Number(fourStageConfig.blueprint_max_iterations || 10),
    [LONGAGENT_4STAGE_STAGES.CODING]: Number(fourStageConfig.coding_max_iterations || 50),
    [LONGAGENT_4STAGE_STAGES.DEBUGGING]: Number(fourStageConfig.debugging_max_iterations || 20)
  }

  const separateModels = fourStageConfig.separate_models || {}
  const useSeparateModels = separateModels.enabled === true

  function getModelForStage(stage) {
    if (!useSeparateModels) return { model, providerType }
    const map = {
      [LONGAGENT_4STAGE_STAGES.PREVIEW]: separateModels.preview_model,
      [LONGAGENT_4STAGE_STAGES.BLUEPRINT]: separateModels.blueprint_model,
      [LONGAGENT_4STAGE_STAGES.CODING]: separateModels.coding_model,
      [LONGAGENT_4STAGE_STAGES.DEBUGGING]: separateModels.debugging_model
    }
    return map[stage] ? { model: map[stage], providerType } : { model, providerType }
  }

  async function setStage(nextStage) {
    if (currentStage === nextStage) return
    currentStage = nextStage
    currentStageIteration = 0
    const eventMap = {
      [LONGAGENT_4STAGE_STAGES.PREVIEW]: EVENT_TYPES.LONGAGENT_4STAGE_PREVIEW_START,
      [LONGAGENT_4STAGE_STAGES.BLUEPRINT]: EVENT_TYPES.LONGAGENT_4STAGE_BLUEPRINT_START,
      [LONGAGENT_4STAGE_STAGES.CODING]: EVENT_TYPES.LONGAGENT_4STAGE_CODING_START,
      [LONGAGENT_4STAGE_STAGES.DEBUGGING]: EVENT_TYPES.LONGAGENT_4STAGE_DEBUGGING_START
    }
    if (eventMap[nextStage]) {
      await EventBus.emit({ type: eventMap[nextStage], sessionId, payload: { stage: nextStage, iteration } })
    }
    await syncState({ lastMessage: `entering stage: ${nextStage}` })
  }

  async function emitStageComplete(stage) {
    const eventMap = {
      [LONGAGENT_4STAGE_STAGES.PREVIEW]: EVENT_TYPES.LONGAGENT_4STAGE_PREVIEW_COMPLETE,
      [LONGAGENT_4STAGE_STAGES.BLUEPRINT]: EVENT_TYPES.LONGAGENT_4STAGE_BLUEPRINT_COMPLETE,
      [LONGAGENT_4STAGE_STAGES.CODING]: EVENT_TYPES.LONGAGENT_4STAGE_CODING_COMPLETE,
      [LONGAGENT_4STAGE_STAGES.DEBUGGING]: EVENT_TYPES.LONGAGENT_4STAGE_DEBUGGING_COMPLETE
    }
    if (eventMap[stage]) {
      await EventBus.emit({ type: eventMap[stage], sessionId, payload: { stage, iteration } })
    }
  }

  async function syncState(patch = {}) {
    await LongAgentManager.update(sessionId, {
      status: patch.status || "running",
      fourStage: { currentStage, stageContext },
      iterations: iteration,
      heartbeatAt: Date.now(),
      ...patch
    })
  }

  await markSessionStatus(sessionId, "running-longagent")
  await syncState({ status: "running", lastMessage: "4-stage longagent started" })

  // Git branch setup
  const cwd = process.cwd()
  const inGitRepo = gitEnabled && await git.isGitRepo(cwd)
  if (inGitRepo) {
    let userWantsGit = !gitAsk
    if (gitAsk && allowQuestion) {
      const askResult = await processTurnLoop({
        prompt: "[SYSTEM] Git 分支管理已就绪。是否为本次 LongAgent 会话创建独立分支？\n回复 yes/是 启用，no/否 跳过。\n启用后：自动创建特性分支 → 每阶段自动提交 → 完成后合并回主分支。",
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
        if (created.ok) { gitBranch = branchName; gitActive = true }
      } finally {
        if (stashed) await git.stashPop(cwd).catch(() => {})
      }
    }
  }

  // Main stage loop
  const stageOrder = [
    LONGAGENT_4STAGE_STAGES.PREVIEW,
    LONGAGENT_4STAGE_STAGES.BLUEPRINT,
    LONGAGENT_4STAGE_STAGES.CODING,
    LONGAGENT_4STAGE_STAGES.DEBUGGING
  ]
  let stageIndex = 0
  let codingRollbackCount = 0
  const maxCodingRollbacks = Number(fourStageConfig.max_coding_rollbacks || 3)

  while (stageIndex < stageOrder.length) {
    const stage = stageOrder[stageIndex]
    await setStage(stage)
    const { model: stageModel, providerType: stageProvider } = getModelForStage(stage)
    const maxIter = stageMaxIterations[stage]
    let stageComplete = false

    while (!stageComplete && currentStageIteration < maxIter) {
      iteration += 1
      currentStageIteration += 1

      const state = await LongAgentManager.get(sessionId)
      if (state?.stopRequested || signal?.aborted) {
        await LongAgentManager.update(sessionId, { status: "stopped", lastMessage: "stop requested" })
        await markSessionStatus(sessionId, "stopped")
        return { sessionId, reply: "longagent stopped", usage: aggregateUsage, toolEvents, iterations: iteration, status: "stopped" }
      }

      const fullPrompt = buildStageWrapper(stage, stageContext, prompt, stuckWarningMsg)
      if (stuckWarningMsg) stuckWarningMsg = null
      const readonly = stage === LONGAGENT_4STAGE_STAGES.PREVIEW || stage === LONGAGENT_4STAGE_STAGES.BLUEPRINT
      const stageAgentName = readonly
        ? (stage === LONGAGENT_4STAGE_STAGES.PREVIEW ? "preview-agent" : "blueprint-agent")
        : (stage === LONGAGENT_4STAGE_STAGES.CODING ? "coding-agent" : "debugging-agent")

      const out = await processTurnLoop({
        prompt: fullPrompt, mode: "agent", agent: getAgent(stageAgentName),
        model: stageModel, providerType: stageProvider, sessionId, configState,
        baseUrl, apiKeyEnv, signal, output, allowQuestion, toolContext
      })

      aggregateUsage.input += out.usage.input || 0
      aggregateUsage.output += out.usage.output || 0
      if (out.toolEvents?.length) toolEvents.push(...out.toolEvents)
      finalReply = out.reply

      // 防卡死检测
      if (out.toolEvents?.length) {
        const stuckResult = stuckTracker.track(out.toolEvents)
        if (stuckResult.isStuck) {
          const readonly = stage === LONGAGENT_4STAGE_STAGES.PREVIEW || stage === LONGAGENT_4STAGE_STAGES.BLUEPRINT
          stuckWarningMsg = readonly
            ? `[STUCK DETECTION] You have been exploring files for too many rounds without progress. STOP reading more files. Synthesize what you've learned and COMPLETE this stage now.`
            : `[STUCK DETECTION] You appear stuck in an exploration loop. STOP reading files and START implementing. Make concrete changes to files.`
          stuckTracker.resetReadOnlyCount()
          await EventBus.emit({
            type: EVENT_TYPES.LONGAGENT_ALERT, sessionId,
            payload: { kind: "stuck_warning", stage, reason: stuckResult.reason, iteration: currentStageIteration }
          })
          await syncState({ lastMessage: `stuck detected at ${stage}, iter ${currentStageIteration}` })
        }
      }

      if (detectStageComplete(out.reply, stage)) {
        stageComplete = true
        stageContext[stage] = out.reply
        await emitStageComplete(stage)
        if (gitActive && gitConfig.auto_commit_stages !== false) {
          await git.commitAll(`[kkcode] 4-stage: ${stage} completed`, cwd).catch(() => {})
        }
      }

      // Debugging → Coding回退（带次数限制）
      if (stage === LONGAGENT_4STAGE_STAGES.DEBUGGING && detectReturnToCoding(out.reply)) {
        codingRollbackCount++
        if (codingRollbackCount > maxCodingRollbacks) {
          await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_ALERT, sessionId, payload: { kind: "rollback_limit", message: `coding rollback limit (${maxCodingRollbacks}) reached, forcing completion` } })
          stageComplete = true
          continue
        }
        await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_4STAGE_RETURN_TO_CODING, sessionId, payload: { rollbackCount: codingRollbackCount } })
        stageIndex = stageOrder.indexOf(LONGAGENT_4STAGE_STAGES.CODING)
        stageComplete = true
        continue
      }

      if (/\[TASK_COMPLETE\]/i.test(out.reply)) completionMarkerSeen = true
      await syncState({ lastMessage: `stage ${stage}, iteration ${currentStageIteration}/${maxIter}` })
    }

    if (!stageComplete) {
      await LongAgentManager.update(sessionId, { status: "failed", lastMessage: `stage ${stage} timed out after ${maxIter} iterations` })
      return { sessionId, reply: `stage ${stage} timed out`, usage: aggregateUsage, toolEvents, iterations: iteration, status: "failed" }
    }

    stageIndex += 1
    await saveCheckpoint(sessionId, { name: `4stage_${stage}`, iteration, currentStage, stageContext })
  }

  // Git merge (only if not failed)
  if (gitActive && gitBaseBranch && gitBranch) {
    try {
      await git.commitAll(`[kkcode] 4-stage session ${sessionId} completed`, cwd)
      if (gitConfig.auto_merge !== false) {
        const doneState = await LongAgentManager.get(sessionId)
        if (doneState?.status !== "failed") {
          await git.checkoutBranch(gitBaseBranch, cwd)
          await git.mergeBranch(gitBranch, cwd)
          await git.deleteBranch(gitBranch, cwd)
        }
      }
    } catch { /* git merge best-effort */ }
  }

  await LongAgentManager.update(sessionId, { status: completionMarkerSeen ? "completed" : "done", lastMessage: "4-stage longagent complete" })
  await markSessionStatus(sessionId, completionMarkerSeen ? "completed" : "active")

  return {
    sessionId,
    turnId: `turn_long_${Date.now()}`,
    reply: finalReply || "4-stage longagent complete",
    usage: aggregateUsage,
    toolEvents,
    iterations: iteration,
    status: completionMarkerSeen ? "completed" : "done",
    elapsed: Math.round((Date.now() - startTime) / 1000),
    fourStage: { completed: true, stageContext }
  }
}
