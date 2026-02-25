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
import { createStuckTracker, isReadOnlyTool, accumulateUsage, buildLongAgentResult } from "./longagent-utils.mjs"
import * as git from "../util/git.mjs"
import { setupGitBranch } from "./longagent-git-lifecycle.mjs"

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
      "### 1. Project Structure Discovery",
      "- Use glob to map the FULL directory tree (src/, test/, config/, scripts/, etc.)",
      "- Identify the build system (package.json scripts, Makefile, Cargo.toml, etc.)",
      "- Identify the test framework and test file naming convention",
      "- Read the entry point(s) and trace the module dependency graph",
      "",
      "### 2. Technology Stack Audit",
      "- Read package.json / requirements.txt / go.mod to catalog ALL dependencies",
      "- Identify the runtime version constraints (engines, python_requires, etc.)",
      "- Note the code style: ESM vs CJS, TypeScript vs JS, async patterns, error handling conventions",
      "- Check for existing linter/formatter config (.eslintrc, .prettierrc, pyproject.toml)",
      "",
      "### 3. Requirement Decomposition",
      "- Break the user objective into discrete, testable sub-requirements",
      "- For each sub-requirement, identify which existing modules are affected",
      "- Flag any ambiguities or missing information that could cause parallel agents to conflict",
      "- Identify external API contracts, data schemas, or protocols involved",
      "",
      "### 4. Reuse & Risk Assessment",
      "- List existing utilities, helpers, and abstractions that MUST be reused (do NOT reinvent)",
      "- Identify files that are heavily imported — changes to these have high blast radius",
      "- Note any existing tests that cover the affected modules (these must not regress)",
      "- Flag potential conflicts: concurrent file access, circular dependencies, breaking API changes",
      "",
      "### 5. Output Format",
      "Produce a structured findings report with these sections:",
      "- **Tech Stack**: runtime, framework, key dependencies, build tool",
      "- **Affected Modules**: list of files/directories that will be touched",
      "- **Reusable Assets**: existing code to leverage",
      "- **Risks**: potential issues, breaking changes, high-blast-radius files",
      "- **Sub-requirements**: numbered list of discrete tasks derived from the objective"
    )
  } else if (stage === LONGAGENT_4STAGE_STAGES.BLUEPRINT) {
    parts.push(
      "### 1. Architecture Design",
      "- Define the module boundaries: which new files to create, which existing files to modify",
      "- For each new module: purpose, public API (exported functions/classes with signatures), internal structure",
      "- For each modified module: what changes, what stays, backward compatibility impact",
      "- Draw the dependency graph: A imports B, B imports C — ensure no circular dependencies",
      "",
      "### 2. Interface Contracts",
      "- Define ALL function signatures with parameter types and return types",
      "- Define data structures / schemas (object shapes, DB schemas, API request/response formats)",
      "- Specify error types: what errors can each function throw, how callers should handle them",
      "- Define event contracts if using pub/sub or EventEmitter patterns",
      "",
      "### 3. File Ownership & Parallelization Plan",
      "- Assign every file to exactly ONE task (no file may appear in multiple tasks)",
      "- Files that import each other MUST be in the same task",
      "- A module and its test file MUST be in the same task",
      "- Each task should own 2-8 files. Split or merge if outside this range",
      "- Order tasks into stages: infrastructure → core logic → integration → validation",
      "",
      "### 4. Acceptance Criteria",
      "- Every task MUST have machine-verifiable acceptance criteria",
      "- Valid: 'node --check src/foo.mjs passes', 'npm test -- --grep auth passes', 'function X is exported from Y'",
      "- Invalid: 'code is clean', 'implementation is correct', 'works as expected'",
      "- The FINAL task must include: 'all modified files parse without errors AND project builds AND tests pass'",
      "",
      "### 5. Edge Cases & Error Handling Strategy",
      "- List edge cases for each major function (null input, empty arrays, concurrent access, network failure)",
      "- Define the error propagation strategy: throw vs return error vs log-and-continue",
      "- Specify retry/fallback behavior for external dependencies",
      "- Define resource cleanup requirements (file handles, timers, connections)"
    )
  } else if (stage === LONGAGENT_4STAGE_STAGES.CODING) {
    parts.push(
      "### 1. Implementation Discipline",
      "- Follow the blueprint from Stage 2 EXACTLY — do not deviate from the agreed architecture",
      "- Read existing files BEFORE modifying them — never edit blind",
      "- When modifying a function, grep for all callers to ensure you update call sites",
      "- When adding imports, verify the target module exists and exports the symbol",
      "",
      "### 2. Code Quality Standards",
      "- Match the project's existing code style (indentation, naming, async patterns, error handling)",
      "- Add error handling at system boundaries (user input, external APIs, file I/O, network calls)",
      "- Do NOT add unnecessary abstractions, wrappers, or 'just in case' code",
      "- Do NOT add comments that restate the code — only comment non-obvious logic",
      "- Ensure all resources are properly cleaned up (timers cleared, listeners removed, handles closed)",
      "",
      "### 3. Testing Requirements",
      "- If the blueprint includes test files, implement them with concrete assertions (not placeholder TODOs)",
      "- Tests must cover: happy path, error cases, edge cases, boundary conditions",
      "- Run `node --check` (or equivalent) on every file you create or modify",
      "- If a test framework exists, run the relevant test suite to verify no regressions",
      "",
      "### 4. Integration Verification",
      "- After implementing, verify imports resolve correctly across all modified files",
      "- Check that exported APIs match the signatures defined in the blueprint",
      "- If modifying shared modules, verify all downstream consumers still work",
      "",
      "### 5. Progress Reporting",
      "- After completing each logical unit, briefly state what was done and what remains",
      "- If you encounter a blocker not covered by the blueprint, document it clearly",
      "- If you discover the blueprint has an error, fix it and note the deviation"
    )
  } else if (stage === LONGAGENT_4STAGE_STAGES.DEBUGGING) {
    parts.push(
      "### 1. Systematic Verification Protocol",
      "- Run syntax checks on ALL modified/created files (node --check, python -m py_compile, etc.)",
      "- Run the full test suite — not just new tests, ALL tests to catch regressions",
      "- If build system exists (npm run build, make, cargo build), run it and verify success",
      "- Check for TypeScript type errors if tsconfig.json exists (npx tsc --noEmit)",
      "",
      "### 2. Functional Validation",
      "- Trace through each sub-requirement from the blueprint and verify it is implemented",
      "- For each public API: verify the function exists, has correct signature, handles edge cases",
      "- Test error paths: pass invalid input, simulate failures, verify error messages are helpful",
      "- Verify resource cleanup: no timer leaks, no unclosed handles, no dangling event listeners",
      "",
      "### 3. Integration Testing",
      "- Verify cross-module imports resolve correctly",
      "- If the implementation involves multiple stages, verify the data flow end-to-end",
      "- Check for race conditions in async code (concurrent access, Promise.all error handling)",
      "- Verify backward compatibility: existing callers of modified APIs still work",
      "",
      "### 4. Issue Resolution",
      "- For each failing test: read the error, identify root cause, fix it, re-run to confirm",
      "- Do NOT suppress errors or skip tests — fix the underlying issue",
      "- If a fix requires architectural changes, output [RETURN TO STAGE 3: CODING] with details",
      "- Track all issues found and their resolutions",
      "",
      "### 5. Completion Report",
      "When ALL checks pass, provide:",
      "- **Summary**: what was implemented (1-3 sentences)",
      "- **Files changed**: list of created/modified files",
      "- **How to verify**: exact commands to run (build, test, lint)",
      "- **Usage**: how to use the new feature (API examples, CLI commands, config)",
      "- **Known limitations**: anything not covered or deferred"
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

  // C1: Git branch setup — 使用共享模块
  const cwd = process.cwd()
  const inGitRepo = gitEnabled && await git.isGitRepo(cwd)
  if (inGitRepo) {
    let userWantsGit = !gitAsk
    if (gitAsk && allowQuestion) {
      const askResult = await processTurnLoop({
        prompt: "[SYSTEM] Git 分支管理已就绪。是否为本次 LongAgent 会话创建独立分支？\n回复 yes/是 启用，no/否 跳过。",
        mode: "ask", model, providerType, sessionId, configState,
        baseUrl, apiKeyEnv, agent, signal, allowQuestion: true, toolContext
      })
      const answer = String(askResult.reply || "").toLowerCase().trim()
      userWantsGit = ["yes", "是", "y", "ok", "好", "确认", "开启", "启用"].some(k => answer.includes(k))
      accumulateUsage(aggregateUsage, askResult)
    }
    if (userWantsGit) {
      const gitSetup = await setupGitBranch({ sessionId, prompt, cwd })
      gitBranch = gitSetup.gitBranch; gitBaseBranch = gitSetup.gitBaseBranch; gitActive = gitSetup.gitActive
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
        return buildLongAgentResult({ sessionId, reply: "longagent stopped", usage: aggregateUsage, toolEvents, iterations: iteration, status: "stopped" })
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

      accumulateUsage(aggregateUsage, out)
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
      return buildLongAgentResult({ sessionId, reply: `stage ${stage} timed out`, usage: aggregateUsage, toolEvents, iterations: iteration, status: "failed" })
    }

    stageIndex += 1
    await saveCheckpoint(sessionId, { name: `4stage_${stage}`, iteration, currentStage, stageContext })
  }

  // D3: Git merge — 添加合并失败处理和回滚逻辑
  if (gitActive && gitBaseBranch && gitBranch) {
    try {
      await git.commitAll(`[kkcode] 4-stage session ${sessionId} completed`, cwd)
      if (gitConfig.auto_merge !== false) {
        const doneState = await LongAgentManager.get(sessionId)
        if (doneState?.status !== "failed") {
          await git.checkoutBranch(gitBaseBranch, cwd)
          const mergeResult = await git.mergeBranch(gitBranch, cwd)
          if (mergeResult.ok) {
            await git.deleteBranch(gitBranch, cwd)
          } else {
            await EventBus.emit({
              type: EVENT_TYPES.LONGAGENT_ALERT,
              sessionId,
              payload: {
                kind: "git_merge_failed",
                message: `Git merge failed: ${mergeResult.message}. Staying on branch "${gitBranch}".`
              }
            })
            await git.checkoutBranch(gitBranch, cwd).catch(() => {})
          }
        }
      }
    } catch (err) {
      await EventBus.emit({
        type: EVENT_TYPES.LONGAGENT_ALERT,
        sessionId,
        payload: { kind: "git_error", message: err.message }
      }).catch(() => {})
      try { await git.checkoutBranch(gitBranch, cwd) } catch { /* unrecoverable */ }
    }
  }

  await LongAgentManager.update(sessionId, { status: completionMarkerSeen ? "completed" : "done", lastMessage: "4-stage longagent complete" })
  await markSessionStatus(sessionId, completionMarkerSeen ? "completed" : "active")

  return buildLongAgentResult({
    sessionId,
    reply: finalReply || "4-stage longagent complete",
    usage: aggregateUsage,
    toolEvents,
    iterations: iteration,
    status: completionMarkerSeen ? "completed" : "done",
    elapsed: Math.round((Date.now() - startTime) / 1000),
    fourStage: { completed: true, stageContext }
  })
}
