import { newId } from "../core/types.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { requestProviderStream, countTokensProvider } from "../provider/router.mjs"
import { ToolRegistry } from "../tool/registry.mjs"
import { executeTool } from "../tool/executor.mjs"
import { isToolSuccess } from "../core/types.mjs"
import { PermissionEngine } from "../permission/engine.mjs"
import { normalizePermissionLevel, toolCapability } from "../permission/rules.mjs"
import { loadPricing, calculateCost } from "../usage/pricing.mjs"
import { APPROVAL_LEVELS, approvalFromAgentPermission } from "../core/modes.mjs"
import { createTaskDelegate } from "../orchestration/task-scheduler.mjs"
import { loadInstructions } from "./instruction-loader.mjs"
import { buildSystemPromptBlocks } from "./system-prompt.mjs"
import { detectProjectContext } from "./project-context.mjs"
import { renderRulesPrompt } from "../rules/load-rules.mjs"
import { loadProfile } from "../onboarding.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import {
  touchSession,
  appendMessage,
  appendPart,
  getConversationHistory,
  markSessionStatus,
  updateSession
} from "./store.mjs"
import { pendingRejections, markRejectionsConsumed } from "../review/rejection-queue.mjs"
import { isRecoveryEnabled, markTurnFinished, markTurnInProgress } from "./recovery.mjs"
import { HookBus, initHookBus } from "../plugin/hook-bus.mjs"
import { shouldCompact, compactSession, estimateTokenCount, modelContextLimit, contextUtilization, supportsNativeCompaction } from "./compaction.mjs"
import { createStreamRenderer } from "../theme/markdown.mjs"
import { paint } from "../theme/color.mjs"
import { sanitizeTerminalText } from "../theme/terminal-sanitize.mjs"
import { saveCheckpoint } from "./checkpoint.mjs"
import { askPlanApproval } from "../tool/question-prompt.mjs"
import { createValidator } from "./task-validator.mjs"
import { runSpecRole } from "../orchestration/run-spec.mjs"
import { createRequestContext } from "../http/identity.mjs"
import { resolveExtensionPolicy } from "../context.mjs"
import { toolOutputBudget, truncationNotice } from "../tool/output-budget.mjs"

// 每条 tool_result 进入活动上下文的字符上限。0.6.3 之前是硬编码 3000 ——
// 一个 268 行的普通源文件有 12494 字符，模型只能看到四分之一，而且不知道
// 自己没读全。同行量级：opencode 50KB、Codex 1MiB、Claude Code 约 100KB。
// 现在按当前模型的上下文动态推算，见 tool/output-budget.mjs。
// 保留常量名作为兜底（拿不到模型信息时用）。
const TOOL_RESULT_FALLBACK_LIMIT = 16000

/**
 * plan 档下允许执行的工具。
 *
 * 从 toolCapability 推导而非手写名单：手写的那份漏了 sysinfo、question、
 * task_list/get/output、git_status/info/list_snapshots —— 全都是纯读，却在
 * 制定计划时被拦，而制定计划恰恰最需要看仓库现状。漏登记的代价由用户承担，
 * 而这份名单和 TOOL_CAPABILITIES 表达的是同一件事，没有理由维护两份。
 */
const PLAN_ALLOWED_CAPABILITIES = new Set(["read", "search", "network", "safe-shell"])

export function planModeAllows(toolName, args = {}) {
  if (toolName === "enter_plan" || toolName === "exit_plan") return true
  const cap = toolCapability(toolName, String(args?.command || ""))
  return PLAN_ALLOWED_CAPABILITIES.has(cap)
}

/**
 * 只读委派（write_scope: read-only）下确定不会改动工作区的工具。
 *
 * 采取**默认拒绝**姿态：不在这张表里的工具一律视为可能改动。新增工具时
 * 忘了登记，后果是「只读子智能体多被拦一次」——比反过来安全得多。
 * bash 不在表里，它单独按命令判定（见 canMutateWorkspace）。
 */
const NON_MUTATING_TOOLS = new Set([
  "read", "glob", "grep", "list", "webfetch", "websearch", "codesearch",
  "background_output", "todowrite", "enter_plan", "exit_plan",
  "sysinfo", "question", "task_list", "task_get", "task_output", "task_parallel",
  "git_status", "git_info", "git_list_snapshots"
])

/**
 * 可并行执行的工具（无副作用，顺序无关）。
 *
 * 与 NON_MUTATING_TOOLS 的差别是有意的：`todowrite` 与 `enter_plan` 会改会话
 * 状态，不改工作区，所以进得了只读委派但不该并行 —— 并行会让写入次序不确定。
 */
const PARALLELIZABLE_TOOLS = new Set([
  "read", "glob", "grep", "list", "webfetch", "websearch", "codesearch",
  "background_output", "sysinfo", "task_list", "task_get", "task_output",
  "git_status", "git_info", "git_list_snapshots"
])

/**
 * 这次调用是否可能改动工作区。
 *
 * bash 单独处理：只读档下一律视为可改动，除非命令命中已有的可信只读白名单
 * （`git status`、`ls`、`cat` 之类）。这正是 0.6.2 那版漏掉的口子 ——
 * 按能力名判定时 bash 的能力是 risky-shell，两个字符串都对不上。
 */
function canMutateWorkspace(toolName, args = {}) {
  const name = String(toolName || "")
  if (name === "bash") {
    return toolCapability("bash", String(args?.command || "")) !== "safe-shell"
  }
  return !NON_MUTATING_TOOLS.has(name)
}

const PERMISSION_RANK = new Map(APPROVAL_LEVELS.map((level, index) => [level, index]))

/**
 * 子智能体只能收紧、不能放宽全局审批档。
 *
 * agent 定义使用第四套权限词汇（readonly|full|default|none）。0.3.x 的
 * normalizePermissionLevel 不认识 full / none，会把它们静默降级成同一档；
 * 0.4.0 起经 approvalFromAgentPermission 正确映射，min() 收紧语义不变。
 */
export function tightenPermissionConfig(config, rolePermission = null) {
  if (!rolePermission) return config
  const globalLevel = normalizePermissionLevel(config.permission || {})
  const requested = typeof rolePermission === "string"
    ? approvalFromAgentPermission(rolePermission)
    : normalizePermissionLevel(rolePermission)
  // `full` / 未声明 → 不额外收紧，沿用全局档
  if (!requested) return config
  const effective = (PERMISSION_RANK.get(requested) ?? 0) <= (PERMISSION_RANK.get(globalLevel) ?? 0)
    ? requested
    : globalLevel
  return {
    ...config,
    permission: {
      ...(config.permission || {}),
      level: effective
    }
  }
}

function addUsage(target, delta) {
  target.input += delta.input || 0
  target.output += delta.output || 0
  target.cacheRead += delta.cacheRead || 0
  target.cacheWrite += delta.cacheWrite || 0
}


async function buildSystemPrompt({ mode, model, cwd, agent = null, tools = [], skills = [], language = "en" }) {
  // Assemble user instructions + rules (Layer 6)
  const instructions = await loadInstructions(cwd)
  const rules = await renderRulesPrompt(cwd)

  // Inject user profile as a context block
  const profile = await loadProfile()
  let profileBlock = ""
  if (profile && !profile.beginner) {
    const lines = ["# User Profile", "", "Apply these preferences consistently in all code you write and suggestions you make:"]
    if (profile.languages?.length) {
      lines.push(`- Languages: ${profile.languages.join(", ")} — prefer these when suggesting solutions or writing code`)
    }
    if (profile.tech_stack?.length) {
      lines.push(`- Tech stack: ${profile.tech_stack.join(", ")} — use these frameworks/tools when relevant`)
    }
    if (profile.design_style) {
      lines.push(`- Code style: ${profile.design_style}`)
      const s = profile.design_style.toLowerCase()
      if (s.includes("minimal") || s.startsWith("clean")) {
        lines.push("  → Write minimal code. Avoid over-engineering, unnecessary abstractions, and verbose implementations. Prefer simple, direct solutions.")
      } else if (s.startsWith("functional") || s.includes("pure function")) {
        lines.push("  → Prefer pure functions and immutability. Use map/filter/reduce over loops. Avoid side effects and mutable state where possible.")
      } else if (s.startsWith("object-oriented") || s.includes("class")) {
        lines.push("  → Use OOP patterns — encapsulation, design patterns, well-defined classes. Organize code around objects and their behaviors.")
      } else if (s.startsWith("performance") || s.includes("optimize")) {
        lines.push("  → Optimize for performance. Consider time/space complexity. Avoid unnecessary allocations and redundant operations.")
      }
    }
    if (profile.extra_notes) {
      lines.push(`- User requirements: ${profile.extra_notes} — treat these as hard requirements`)
    }
    profileBlock = lines.join("\n")
  }

  const userInstructions = [...instructions, rules, profileBlock].filter(Boolean).join("\n\n")

  // Detect project context (framework, language, build tool, etc.)
  const projectContext = await detectProjectContext(cwd)

  // Build structured blocks for provider-level cache optimization
  const result = await buildSystemPromptBlocks({ mode, model, cwd, agent, tools, skills, userInstructions, projectContext, language })
  return result
}

function toolPatternFromArgs(args) {
  if (!args || typeof args !== "object") return "*"
  if (Array.isArray(args.changes) && args.changes.length > 0) {
    return args.changes
      .map((change) => change?.path)
      .filter(Boolean)
      .join(",")
  }
  return String(args.path || args.command || args.pattern || args.task_id || "*")
}

function normalizeMessageForCache(msg) {
  const content = msg?.content
  // For array content (image blocks, tool_use, tool_result), serialize to a stable string
  if (Array.isArray(content)) {
    const textParts = content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
    const imageParts = content
      .filter((b) => b.type === "image")
      .map((b) => `[image:${b.path || "inline"}]`)
      .join(" ")
    const toolUseParts = content
      .filter((b) => b.type === "tool_use")
      .map((b) => `[tool_use:${b.name}:${b.id}]`)
      .join(" ")
    const toolResultParts = content
      .filter((b) => b.type === "tool_result")
      .map((b) => `[tool_result:${b.tool_use_id}:${String(b.content || "").slice(0, 100)}]`)
      .join(" ")
    const extras = [imageParts, toolUseParts, toolResultParts].filter(Boolean).join("\n")
    return {
      role: String(msg?.role || ""),
      content: `${textParts}${extras ? "\n" + extras : ""}`
    }
  }
  return {
    role: String(msg?.role || ""),
    content: String(content || "")
  }
}

function isPrefixMessages(prefix, full) {
  if (!Array.isArray(prefix) || !Array.isArray(full)) return false
  if (prefix.length > full.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i].role !== full[i].role || prefix[i].content !== full[i].content) return false
  }
  return true
}

export async function processTurnLoop({
  prompt,
  contentBlocks = null,
  mode,
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  depth = 0,
  signal = null,
  output = null,
  subagent = null,
  agent = null,
  allowQuestion = true,
  toolContext = {},
  runSpec = null
}) {
  const cwd = process.cwd()
  const extensionPolicy = resolveExtensionPolicy(configState)
  await initHookBus(cwd, extensionPolicy.config, {
    allowProjectSources: extensionPolicy.allowProjectSources
  })

  if (depth > 8) {
    return {
      sessionId,
      turnId: newId("turn"),
      reply: "task delegation depth exceeded",
      emittedText: false,
      context: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolEvents: []
    }
  }

  const turnId = newId("turn")
  // 工具输出预算按当前模型的上下文算一次，本轮复用
  const toolResultLimit = toolOutputBudget({ model, providerType, config: configState.config }).chars
    || TOOL_RESULT_FALLBACK_LIMIT

  // plan 档的执行层闸门。此前 _planMode 只有模型自愿调 enter_plan 才会被设，
  // 而 CLI 的 `/plan` 只注入了一段「请勿修改源文件」的提示词 —— 也就是说
  // plan 模式的全部约束力来自模型听不听话，一个不听话的模型照样能写文件。
  // mode 是调用方明确声明的意图，闸门该认它。
  if (mode === "plan" && toolContext._planMode === undefined) {
    toolContext._planMode = true
  }
  const turnTraceContext = createRequestContext()
  const configMaxSteps = Math.max(1, Number(configState.config.agent.max_steps || 128))
  const maxSteps = (subagent?.maxTurns > 0) ? Math.min(configMaxSteps, subagent.maxTurns) : configMaxSteps
  const verifyCompletion = configState.config.agent?.verify_completion !== false
  const recoveryEnabled = isRecoveryEnabled(configState.config)
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const toolEvents = []
  const doomTracker = [] // recent tool call signatures for doom loop detection
  let emittedAnyText = false
  let lastContextMeter = null
  // Plan 审批后的执行航道交接，由调用方（REPL）真正切换模式并续跑
  let planHandoff = null
  let contextCachePoint = null
  const thresholdRatio = Number(configState.config.session?.compaction_threshold_ratio ?? 0.85)
  const thresholdMessages = Number(configState.config.session?.compaction_threshold_messages ?? 200)
  const cachePointsEnabled = configState.config.session?.context_cache_points !== false
  const useNativeCompaction = supportsNativeCompaction(providerType, model)
  const nativeCompactionTrigger = useNativeCompaction ? Math.floor(modelContextLimit(model, configState, providerType) * thresholdRatio) : 0
  const effectiveAgent = runSpecRole(runSpec) || subagent || agent
  const permissionConfig = tightenPermissionConfig(configState.config, effectiveAgent?.permission)

  await touchSession({
    sessionId,
    mode,
    model,
    providerType,
    cwd,
    status: "active",
    title: subagent ? `${subagent.name}: ${prompt.slice(0, 60)}` : null
  })

  await EventBus.emit({
    type: EVENT_TYPES.TURN_START,
    sessionId,
    turnId,
    payload: { mode, model, providerType, prompt }
  })

  const queue = await pendingRejections(cwd)
  const rejectionText = queue.length
    ? [
        "<review-rejections>",
        ...queue.map((entry, index) => `${index + 1}. file=${entry.file} reason=${entry.reason} risk=${entry.riskScore ?? "unknown"}`),
        "</review-rejections>",
        "Address these rejected changes before introducing new risky edits."
      ].join("\n")
    : ""
  const effectivePrompt = rejectionText ? `${prompt}\n\n${rejectionText}` : prompt

  // If contentBlocks provided (e.g. images), build array content for the message.
  // Prepend rejection text as a text block if needed.
  let messageContent
  if (contentBlocks && Array.isArray(contentBlocks)) {
    const blocks = [...contentBlocks]
    if (rejectionText) {
      // Find the first text block and prepend rejection text
      const textIdx = blocks.findIndex((b) => b.type === "text")
      if (textIdx >= 0) {
        blocks[textIdx] = { type: "text", text: `${blocks[textIdx].text}\n\n${rejectionText}` }
      } else {
        blocks.unshift({ type: "text", text: rejectionText })
      }
    }
    messageContent = blocks
  } else {
    messageContent = effectivePrompt
  }

  const userMessage = await appendMessage(sessionId, "user", messageContent, {
    mode,
    model,
    providerType,
    turnId
  })

  await appendPart(sessionId, {
    type: "turn-start",
    messageId: userMessage.id,
    turnId,
    mode,
    model,
    providerType
  })

  let systemTools = await ToolRegistry.list({ mode, config: configState.config, cwd })
  if (effectiveAgent?.tools) {
    systemTools = systemTools.filter((t) => effectiveAgent.tools.includes(t.name))
  }
  const skills = SkillRegistry.isReady() ? SkillRegistry.listForSystemPrompt() : []
  const language = configState.config.language || "en"
  const systemPrompt = await buildSystemPrompt({ mode, model, cwd, agent: effectiveAgent, tools: systemTools, skills, language })
  // systemPrompt = { text, blocks } — providers use blocks for cache optimization
  const delegateTask = createTaskDelegate({
    config: configState.config,
    parentSessionId: sessionId,
    model,
    providerType,
    runSubtask: async ({
      prompt: subPrompt,
      sessionId: subSessionId,
      model: subModel,
      providerType: subProvider,
        subagent: resolvedSubagent,
        runSpec: subRunSpec,
        allowQuestion: subAllowQuestion = false
    }) => {
      return processTurnLoop({
        prompt: subPrompt,
        mode: "agent",
        model: subModel,
        providerType: subProvider,
        sessionId: subSessionId,
        configState,
        baseUrl,
        apiKeyEnv,
        depth: depth + 1,
        signal,
        subagent: resolvedSubagent,
        runSpec: subRunSpec,
        allowQuestion: subAllowQuestion,
        toolContext
      })
    }
  })

  const MAX_CONTINUES = 8
  const MAX_TOTAL_CONTINUES = 24 // hard cap on total auto-continues per turn
  let continueCount = 0
  let totalContinueCount = 0
  let nudgeCount = 0
  let finalReply = ""
  const sinkWrite = typeof output?.write === "function"
    ? output.write
    : () => {}
  try {
    for (let step = 1; step <= maxSteps; step++) {
      await markTurnInProgress(sessionId, turnId, step, recoveryEnabled)
      await EventBus.emit({
        type: EVENT_TYPES.TURN_STEP_START,
        sessionId,
        turnId,
        payload: { step }
      })

      let tools = await ToolRegistry.list({ mode, config: configState.config, cwd })
      if (effectiveAgent?.tools) {
        tools = tools.filter((t) => effectiveAgent.tools.includes(t.name))
      }
      // Compaction decisions must see the complete active history. Applying
      // max_history before this point silently drops context and can prevent the
      // message threshold from ever being reached.
      let history = await getConversationHistory(sessionId, 9999)

      const normalizedHistory = history.map(normalizeMessageForCache)
      let contextTokens = estimateTokenCount(normalizedHistory)
      let contextFromCache = false

      // Use real token counting API when available (includes system + tools + messages)
      const realCount = await countTokensProvider({
        configState, providerType, model,
        system: systemPrompt, messages: history, tools,
        baseUrl, apiKeyEnv,
        traceId: turnTraceContext.traceId,
        sessionId,
        turnId,
        signal
      })
      if (realCount != null) {
        contextTokens = realCount
      } else if (contextCachePoint && isPrefixMessages(contextCachePoint.messages, normalizedHistory)) {
        const delta = normalizedHistory.slice(contextCachePoint.messages.length)
        contextTokens = contextCachePoint.tokens + estimateTokenCount(delta)
        contextFromCache = true
      } else if (contextCachePoint) {
        contextCachePoint = null
      }
      const contextLimit = modelContextLimit(model, configState, providerType)
      const contextRatio = contextLimit > 0 ? Math.min(1, contextTokens / contextLimit) : 0
      lastContextMeter = {
        tokens: contextTokens,
        limit: contextLimit,
        ratio: contextRatio,
        percent: Math.round(contextRatio * 100),
        fromCache: contextFromCache
      }

      if (cachePointsEnabled && (step === 1 || contextRatio >= thresholdRatio)) {
        contextCachePoint = {
          messages: normalizedHistory,
          tokens: contextTokens
        }
        await appendPart(sessionId, {
          type: "context-cache-point",
          turnId,
          step,
          tokenEstimate: contextTokens,
          contextLimit,
          contextRatio
        })
        await saveCheckpoint(sessionId, {
          kind: "context-cache-point",
          iteration: step,
          turnId,
          step,
          tokenEstimate: contextTokens,
          contextLimit,
          contextRatio,
          messageCount: normalizedHistory.length,
          fromCache: contextFromCache
        })
      }

      if (!useNativeCompaction && shouldCompact({
        messages: normalizedHistory,
        model,
        thresholdMessages,
        thresholdRatio,
        configState,
        providerType,
        realTokenCount: realCount != null ? contextTokens : null
      })) {
          const compactResult = await compactSession({
            sessionId, model, providerType, configState, baseUrl, apiKeyEnv,
            traceId: turnTraceContext.traceId,
            turnId
          })
          if (compactResult.compacted) {
            const beforeTokens = Number(lastContextMeter?.tokens) || 0
            history = await getConversationHistory(sessionId, 9999)
            const compactedMeter = contextUtilization(history.map(normalizeMessageForCache), model, configState, providerType)
            // 事件带上前后 token 数 —— UI 层的「已压缩，193.4K → 42.1K」提示全靠它
            await EventBus.emit({
              type: EVENT_TYPES.SESSION_COMPACTED, sessionId, turnId,
              payload: { ...compactResult, beforeTokens, afterTokens: compactedMeter.tokens, limit: compactedMeter.limit }
            })
            lastContextMeter = { ...compactedMeter, fromCache: false }
            contextCachePoint = {
              messages: history.map(normalizeMessageForCache),
              tokens: compactedMeter.tokens
            }
          }
        }

      // runSpec.limits 是委派方给子智能体立的硬约束。0.6.0 之前两个字段
      // 写进 runSpec 后全仓无读取点 —— 立了规矩没人执行。
      const limits = runSpec?.limits || null
      if (limits?.deadlineAt && Date.now() > Number(limits.deadlineAt)) {
        finalReply = `${finalReply}\n[deadline exceeded — stopping]`.trim()
        break
      }
      if (limits?.budgetUsd > 0 && usage.input + usage.output > 0) {
        try {
          const { pricing } = await loadPricing(configState)
          const { amount } = calculateCost(pricing, model, usage)
          if (amount >= limits.budgetUsd) {
            finalReply = `${finalReply}\n[budget ${limits.budgetUsd} USD exhausted — stopping]`.trim()
            break
          }
        } catch { /* 计价表缺失时预算检查静默跳过 */ }
      }

      const messages = await HookBus.messagesTransform([...history])
      const stepRequestContext = createRequestContext({ traceId: turnTraceContext.traceId })

      let response
      try {
        const chunks = requestProviderStream({
          configState,
          providerType,
          model,
          // 子智能体定义里的 temperature 此前全仓零消费者
          ...(Number.isFinite(effectiveAgent?.temperature) ? { temperature: effectiveAgent.temperature } : {}),
          system: systemPrompt,
          messages,
          tools,
          baseUrl,
          apiKeyEnv,
          traceId: stepRequestContext.traceId,
          requestId: stepRequestContext.requestId,
          sessionId,
          turnId,
          signal,
          compaction: useNativeCompaction ? { trigger: nativeCompactionTrigger } : null
        })
        const textParts = []
        const thinkingParts = []
        const streamToolCalls = []
        let streamUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        let streamStopReason = "end_turn"
        const mdEnabled = configState.config.ui?.markdown_render !== false && output?.renderMarkdown !== false
        const streamRenderer = mdEnabled ? createStreamRenderer() : null
        let inThinking = false
        let streamPhase = null
        let thinkingLineStart = true

        for await (const chunk of chunks) {
          if (signal?.aborted) {
            const error = new Error("provider stream cancelled")
            error.code = "ABORT_ERR"
            error.errorClass = "aborted"
            throw error
          }
          if (chunk.type === "thinking") {
            const text = chunk.content || ""
            thinkingParts.push(text)
            if (streamPhase !== "thinking") {
              streamPhase = "thinking"
              inThinking = true
              thinkingLineStart = true
              await EventBus.emit({ type: EVENT_TYPES.STREAM_THINKING_START, sessionId, turnId, payload: { step } })
              sinkWrite(paint("●", "#666666") + " " + paint("Thinking", null, { dim: true }) + " " + paint("∨", null, { dim: true }) + "\n")
            }
            await EventBus.emit({
              type: EVENT_TYPES.STREAM_THINKING_DELTA,
              sessionId,
              turnId,
              payload: { step, text }
            })
            // 只在行首加缩进，避免 chunk 中间出现多余空格
            const indented = sanitizeTerminalText(text).replace(/^|\n/g, (m) => {
              if (m === "\n") { thinkingLineStart = true; return "\n" }
              if (thinkingLineStart) { thinkingLineStart = false; return "  " }
              return ""
            })
            // 如果 chunk 末尾是换行，标记下一个 chunk 需要缩进
            if (text.endsWith("\n")) thinkingLineStart = true
            sinkWrite(paint(indented, null, { dim: true }))
          } else if (chunk.type === "text") {
            if (inThinking) {
              sinkWrite("\n")
              inThinking = false
            }
            if (streamPhase !== "text") {
              streamPhase = "text"
              await EventBus.emit({ type: EVENT_TYPES.STREAM_TEXT_START, sessionId, turnId, payload: { step } })
            }
            await EventBus.emit({
              type: EVENT_TYPES.STREAM_TEXT_DELTA,
              sessionId,
              turnId,
              payload: { step, text: chunk.content || "" }
            })
            if (streamRenderer) {
              const rendered = streamRenderer.push(chunk.content)
              if (rendered) sinkWrite(rendered)
            } else {
              sinkWrite(sanitizeTerminalText(chunk.content))
            }
            textParts.push(chunk.content)
          } else if (chunk.type === "tool_call") {
            if (inThinking) {
              sinkWrite("\n")
              inThinking = false
            }
            streamPhase = "tool_call"
            streamToolCalls.push(chunk.call)
          } else if (chunk.type === "usage") {
            streamUsage = chunk.usage
          } else if (chunk.type === "compaction") {
            sinkWrite(paint("\n  ↻ context compacted by provider\n", "cyan", { dim: true }))
          } else if (chunk.type === "stop") {
            streamStopReason = chunk.reason || "end_turn"
          }
        }
        if (signal?.aborted) {
          const error = new Error("provider stream cancelled")
          error.code = "ABORT_ERR"
          error.errorClass = "aborted"
          throw error
        }
        if (inThinking) {
          sinkWrite("\n")
        }
        if (streamRenderer) {
          const tail = streamRenderer.flush()
          if (tail) sinkWrite(tail)
        }
        if (textParts.length) {
          sinkWrite("\n")
          emittedAnyText = true
        }

        response = {
          text: textParts.join(""),
          reasoning: thinkingParts.join(""),
          toolCalls: streamToolCalls,
          usage: streamUsage,
          stopReason: streamStopReason
        }
      } catch (error) {
        if (error.needsCompaction) {
          const compactResult = await compactSession({
            sessionId, model, providerType, configState, baseUrl, apiKeyEnv,
            traceId: turnTraceContext.traceId,
            turnId
          })
          if (compactResult.compacted) {
            await EventBus.emit({ type: EVENT_TYPES.SESSION_COMPACTED, sessionId, turnId, payload: compactResult })
            continue
          }
        }
        await appendPart(sessionId, {
          type: "provider-error",
          messageId: userMessage.id,
          step,
          turnId,
          error: error.message,
          errorClass: error.errorClass || "unknown",
          needsCompaction: Boolean(error.needsCompaction)
        })
        throw error
      }

      addUsage(usage, response.usage || {})

      // Update context meter with real API total input tokens
      // Anthropic: input_tokens is only non-cached portion; total = input + cacheRead + cacheWrite
      // OpenAI: prompt_tokens is already the total
      const u = response.usage || {}
      const totalInput = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)
      if (totalInput > 0) {
        const contextLimit = modelContextLimit(model, configState, providerType)
        const contextRatio = contextLimit > 0 ? Math.min(1, totalInput / contextLimit) : 0
        lastContextMeter = {
          tokens: totalInput,
          limit: contextLimit,
          ratio: contextRatio,
          percent: Math.round(contextRatio * 100),
          fromCache: false,
          cacheRead: u.cacheRead || 0,
          cacheWrite: u.cacheWrite || 0,
          inputUncached: u.input || 0
        }
      }

      // Emit cumulative usage so status bar can update in real-time
      await EventBus.emit({
        type: EVENT_TYPES.TURN_USAGE_UPDATE,
        sessionId,
        turnId,
        payload: { usage: { ...usage }, step, model, context: lastContextMeter }
      })

      // --- Auto-continue on output truncation (max_tokens) ---
      if (response.stopReason === "max_tokens" && continueCount < MAX_CONTINUES && totalContinueCount < MAX_TOTAL_CONTINUES) {
        continueCount++
        totalContinueCount++
        sinkWrite(paint(`\n  ↳ output truncated, auto-continuing (${continueCount}/${MAX_CONTINUES})...\n`, "yellow", { dim: true }))

        // Drop any tool calls with parse errors (truncated JSON from cutoff)
        const validToolCalls = (response.toolCalls || []).filter(tc => !tc.args?.__parse_error)

        // Save partial output as assistant message
        const partialContent = []
        if (response.text) {
          partialContent.push({ type: "text", text: response.text })
        }
        for (const call of validToolCalls) {
          partialContent.push({ type: "tool_use", id: call.id, name: call.name, input: call.args || {} })
        }
        if (partialContent.length) {
          await appendMessage(sessionId, "assistant", partialContent.length === 1 && partialContent[0].type === "text"
            ? partialContent[0].text
            : partialContent, {
            mode, model, providerType, step, turnId, truncated: true
          })
        }

        // If there were valid tool calls, execute them and add results before continuing
        if (validToolCalls.length) {
          const resultContent = []
          for (const call of validToolCalls) {
            resultContent.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: "[truncated response — tool call acknowledged but output was cut off]",
              is_error: true
            })
          }
          await appendMessage(sessionId, "user", resultContent, {
            mode, model, providerType, step, turnId, synthetic: true
          })
        }

        // Inject continue prompt (localized) — include info about what was truncated
        const hadTruncatedToolCalls = (response.toolCalls || []).some(tc => tc.args?.__parse_error)
        const truncatedToolNames = (response.toolCalls || []).filter(tc => tc.args?.__parse_error).map(tc => tc.name).join(", ")
        const toolHint = hadTruncatedToolCalls
          ? (language === "zh"
            ? `\n被截断的工具调用: ${truncatedToolNames}。请完整重新发起这些工具调用。如果是创建大文件，使用 write(mode="append") 分段追加；如果是修改已有文件的局部内容，使用 patch 按行号范围替换。`
            : `\nTruncated tool calls: ${truncatedToolNames}. Re-issue these tool calls completely. For large file creation, use write(mode="append") to append in chunks. For modifying sections of existing files, use patch to replace by line range.`)
          : ""
        // Anchor: last 200 chars of truncated text so model knows exactly where to resume
        const textTail = response.text ? response.text.slice(-200) : ""
        const anchorHint = textTail
          ? (language === "zh"
            ? `\n[锚点] 上次输出末尾：...${textTail}`
            : `\n[Anchor] Last output ended with: ...${textTail}`)
          : ""
        const continuePrompt = language === "zh"
          ? `[输出被截断 ${continueCount}/${MAX_CONTINUES}] 你的上一条回复在输出 token 上限处被截断。请从你停止的地方精确继续，不要重复已经写过的内容。如果你正在执行工具调用，请完整重新发起。${toolHint}${anchorHint}`
          : `[OUTPUT TRUNCATED ${continueCount}/${MAX_CONTINUES}] Your previous response was cut off at the output token limit. Continue EXACTLY from where you stopped. Do not repeat any content you already wrote. If you were in the middle of a tool call, re-issue it completely.${toolHint}${anchorHint}`
        await appendMessage(sessionId, "user", continuePrompt,
          { mode, model, providerType, step, turnId, synthetic: true }
        )

        // Don't consume a step for auto-continue
        step--
        continue
      }
      // Reset continue count on successful non-truncated response
      continueCount = 0

      if (!response.toolCalls?.length) {
        // Enhanced task completion verification
        if (verifyCompletion && nudgeCount < 2) {
          try {
            const validator = await createValidator({ cwd, configState })
            const validationResult = await validator.validate({
              todoState: toolContext._todoState
            })
            
            if (!validationResult.passed) {
              nudgeCount++
              const validationPrompt = language === "zh"
                ? `[任务验证失败] 您报告任务已完成，但以下验证失败：\n\n${validationResult.message}\n\n请修复问题后再报告完成。`
                : `[TASK VERIFICATION FAILED] You indicated completion, but verification failed:\n\n${validationResult.message}\n\nPlease fix the issues before declaring completion.`
              
              await appendMessage(sessionId, "user", validationPrompt,
                { mode, model, providerType, step, turnId, synthetic: true }
              )
              continue
            }
          } catch (validationError) {
            sinkWrite(paint(`\n  ⚠ Task validation skipped: ${validationError.message}\n`, "yellow", { dim: true }))
          }
        }
        
        finalReply = (response.text || "").trim() || "No content returned from provider."
        const finalContent = response.reasoning
          ? [
              { type: "reasoning", text: response.reasoning },
              { type: "text", text: finalReply }
            ]
          : finalReply
        const assistant = await appendMessage(sessionId, "assistant", finalContent, {
          mode,
          model,
          providerType,
          step,
          turnId
        })
        await appendPart(sessionId, {
          type: "assistant-response",
          messageId: assistant.id,
          step,
          turnId,
          hasText: Boolean(finalReply)
        })
        await markSessionStatus(sessionId, "active")
        if (queue.length) {
          await markRejectionsConsumed(
            queue.map((entry) => entry.id),
            sessionId,
            cwd
          )
        }
        await markTurnFinished(sessionId, recoveryEnabled)
        await EventBus.emit({
          type: EVENT_TYPES.TURN_FINISH,
          sessionId,
          turnId,
          payload: { step, reply: finalReply }
        })
        return {
          sessionId,
          turnId,
          reply: finalReply,
          emittedText: emittedAnyText,
          context: lastContextMeter,
          usage,
          toolEvents,
          planHandoff
        }
      }

      // --- Execute tool calls (read-only in parallel, write tools serially) ---
      async function executeOneCall(call) {
        const runningPart = await appendPart(sessionId, {
          type: "tool-call",
          messageId: userMessage.id,
          step,
          turnId,
          tool: call.name,
          args: call.args,
          status: "running",
          output: ""
        })

        const pattern = toolPatternFromArgs(call.args)
        const command = call.name === "bash" ? String(call.args?.command || "") : ""
        const risk = ["bash", "write", "edit", "task"].includes(call.name) ? 9 : 1
        let result
        try {
          const hookTransformed = await HookBus.toolBefore({
            tool: call.name,
            toolName: call.name,
            args: call.args,
            sessionId,
            step,
            cwd,
            mode
          })
          if (hookTransformed?.args) call.args = hookTransformed.args

          if (call.name === "question" && !allowQuestion) {
            call.args = {
              ...(call.args || {}),
              _allowQuestion: false
            }
          }

          // Plan mode enforcement: block write tools when _planMode is active
          if (toolContext._planMode && !planModeAllows(call.name, call.arguments || call.args || {})) {
            result = {
              name: call.name,
              status: "error",
              output: `[PLAN MODE] Cannot execute '${call.name}' in plan mode. Finish your plan outline and call exit_plan to present it for user approval.`
            }
          } else {
            await PermissionEngine.check({
              config: permissionConfig,
              sessionId,
              turnId,
              traceId: stepRequestContext.traceId,
              requestId: stepRequestContext.requestId,
              tool: call.name,
              mode,
              pattern,
              command,
              args: call.args,
              risk,
              workspace: cwd,
              reason: `tool call from model at step ${step}`
            })

            const tool = await ToolRegistry.get(call.name)
            // 白名单在执行期强制。0.6.0 之前它只过滤「广告给模型的清单」
            // （上面 systemTools.filter），执行走 ToolRegistry.get 不做校验 ——
            // 模型报出一个没被广告的工具名（幻觉、或 fork_context 继承的历史
            // 里出现过）就能执行，对只读子智能体是实打实的越权口子。
            const deniedByAllowlist = Boolean(
              effectiveAgent?.tools && !effectiveAgent.tools.includes(call.name)
            )
            // write_scope 此前只被拼进委派 prompt 文本，没有运行时拦截。
            //
            // 0.6.2 加的第一版判的是 `["write","edit"].includes(capability)`，
            // 而 toolCapability 的返回值域里根本没有 "write" —— 那半个条件是
            // 死值，且真正的漏洞是它拦不住 bash（能力是 risky-shell）：
            // 只读子智能体照样能用 shell 改工作区。改为按「这个工具是否可能
            // 改动工作区」判定，而不是猜能力名。
            const scope = String(runSpec?.workspace?.writeScope || "").trim().toLowerCase()
            const readOnlyScope = /^(read[-_ ]?only|none|no[-_ ]?mutations?)$/.test(scope)
            const deniedByWriteScope = readOnlyScope && canMutateWorkspace(call.name, call.args)
            result = !tool
              ? {
                  name: call.name,
                  status: "error",
                  output: `unknown tool: ${call.name}`,
                  error: `unknown tool: ${call.name}`
                }
              : deniedByAllowlist
              ? {
                  name: call.name,
                  status: "error",
                  output: `tool "${call.name}" is not in this agent's allowlist (${(effectiveAgent.tools || []).join(", ")})`,
                  error: "tool not allowed for this agent"
                }
              : deniedByWriteScope
              ? {
                  name: call.name,
                  status: "error",
                  output: `this delegation is ${scope}; "${call.name}" mutates the workspace and is blocked`,
                  error: "write blocked by write_scope"
                }
              : await executeTool({
                  tool,
                  args: call.args,
                  sessionId,
                  turnId,
                  invocationId: call.id,
                  context: {
                    cwd,
                    mode,
                    traceId: stepRequestContext.traceId,
                    requestId: stepRequestContext.requestId,
                    delegateTask,
                    signal,
                    sessionId,
                    turnId,
                    config: configState.config,
                    // 工具需要知道当前模型与渠道才能算输出预算（动态上限）。
                    // 0.6.3 之前 ctx 只有 config，于是任何按模型能力调整的
                    // 工具行为都无从下手。
                    model,
                    providerType,
                    // 单次工具输出的字符预算。工具内部若有自己的硬编码上限
                    // （bash 曾是 30000），应改读这个值，否则「动态预算」只
                    // 管到 loop 这一层，工具那一层照旧按固定数字砍。
                    toolResultLimit,
                    ...toolContext
                  },
                  signal
                })
          }
        } catch (error) {
          result = {
            name: call.name,
            status: "error",
            output: error.message,
            error: error.message
          }
        }

        // Sync _planMode back to toolContext after enter_plan / exit_plan
        if (call.name === "enter_plan" && isToolSuccess(result)) {
          toolContext._planMode = true
        } else if (call.name === "exit_plan" && isToolSuccess(result)) {
          toolContext._planMode = false
        }

        const hookAfterResult = await HookBus.toolAfter({
          tool: call.name,
          toolName: call.name,
          args: call.args,
          result,
          sessionId,
          step,
          cwd,
          mode
        })
        if (hookAfterResult?.result) result = hookAfterResult.result

        // Plan approval interception: if the tool returned planApproval metadata,
        // pause and ask the user to approve/reject the plan
        if (result.metadata?.planApproval) {
          const approval = await askPlanApproval({
            plan: result.metadata.plan || "",
            files: result.metadata.files || [],
            planPath: result.metadata.planPath || ""
          })
          const planPath = approval.planPath || result.metadata.planPath || ""
          const actionText = {
            plan_saved: `The plan is saved${planPath ? ` at ${planPath}` : ""}. This is a non-interactive run, so no build follows: report the plan location and stop. Do NOT call exit_plan again.`,
            assistant: `User selected Build. Implement the saved plan${planPath ? ` at ${planPath}` : ""} in the unified assistant lane using the current permission level.`,
            longagent: `User selected Ultra Build. The session is switching to Ultra; implement the saved plan${planPath ? ` at ${planPath}` : ""} as a staged delivery.`,
            compact_assistant: `User selected Compact + Build. Compact the relevant context first, then implement the saved plan${planPath ? ` at ${planPath}` : ""} in the unified assistant lane.`,
            compact_longagent: `User selected Compact + Ultra Build. Compact the relevant context first; the session is switching to Ultra to deliver the saved plan${planPath ? ` at ${planPath}` : ""} in stages.`
          }[approval.action]

          // 0.3.x 只把这段文字塞回模型，从不真的切换执行航道。0.4.0 把选择
          // 结果作为 planHandoff 冒泡到 turn 结果，由 REPL 真正切模式并续跑。
          // plan_saved 是非交互收口，没有人选过执行航道，因此不产生交接
          if (approval.approved && approval.action !== "plan_saved") {
            const wantsUltra = approval.action === "longagent" || approval.action === "compact_longagent"
            planHandoff = {
              modeId: wantsUltra ? "ultra" : "agent",
              compactFirst: approval.action.startsWith("compact_"),
              planPath
            }
          }

          result = {
            ...result,
            output: approval.approved
              ? actionText || "User selected a plan execution path. Proceed according to the selected path."
              : approval.requestChanges
                ? `User requested changes to the plan. Feedback: ${approval.feedback || "no specific feedback"}. Revise your plan and call exit_plan again with the updated plan.`
                : `User REJECTED the plan. Feedback: ${approval.feedback || "no feedback provided"}. Do not proceed — the plan has been cancelled.`,
            metadata: { ...result.metadata, planApprovalResult: approval }
          }
        }

        await appendPart(sessionId, {
          type: "tool-call",
          messageId: userMessage.id,
          step,
          turnId,
          runPartId: runningPart.id,
          tool: call.name,
          args: call.args,
          status: result.status,
          output: result.output
        })

        return { call, result }
      }

      // Split into read-only (parallelizable) and write (serial) groups
      const readOnlyCalls = []
      const writeCalls = []
      for (const call of response.toolCalls) {
        if (PARALLELIZABLE_TOOLS.has(call.name)) {
          readOnlyCalls.push(call)
        } else {
          writeCalls.push(call)
        }
      }

      // Execute read-only tools in parallel
      const callResults = new Map() // call.id → { call, result }
      if (readOnlyCalls.length > 0) {
        const settled = await Promise.allSettled(readOnlyCalls.map(executeOneCall))
        for (let si = 0; si < settled.length; si++) {
          const outcome = settled[si]
          if (outcome.status === "fulfilled") {
            callResults.set(outcome.value.call.id, outcome.value)
          } else {
            const failedCall = readOnlyCalls[si]
            callResults.set(failedCall.id, {
              call: failedCall,
              result: {
                name: failedCall.name,
                status: "error",
                output: `Tool execution failed: ${outcome.reason?.message || "unknown error"}`,
                error: outcome.reason?.message || "unknown error"
              }
            })
          }
        }
      }

      // Execute write tools serially
      for (const call of writeCalls) {
        const outcome = await executeOneCall(call)
        callResults.set(outcome.call.id, outcome)
      }

      // Collect results in original order
      for (const call of response.toolCalls) {
        const entry = callResults.get(call.id)
        if (entry) {
          toolEvents.push({
            step,
            name: entry.call.name,
            args: entry.call.args,
            ...entry.result
          })
        }
      }

      // --- Build native tool_use / tool_result messages ---
      // Assistant message: text + tool_use blocks
      const assistantContent = []
      if (response.reasoning) {
        assistantContent.push({ type: "reasoning", text: response.reasoning })
      }
      if (response.text) {
        assistantContent.push({ type: "text", text: response.text })
      }
      for (const call of response.toolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.args || {}
        })
      }
      await appendMessage(sessionId, "assistant", assistantContent, {
        mode,
        model,
        providerType,
        step,
        turnId,
        toolCallPhase: true
      })

      // User message: tool_result blocks (one per tool call, in order)
      // 超出本轮输出预算的部分会被截断，并附上「还剩多少、怎么取」的提示
      const resultContent = []
      for (const call of response.toolCalls) {
        const entry = callResults.get(call.id)
        const rawOutput = entry?.result?.output || ""
        const isError = !isToolSuccess(entry?.result)
        const content = rawOutput.length > toolResultLimit
          ? `${rawOutput.slice(0, toolResultLimit)}\n${truncationNotice({
              shown: toolResultLimit,
              total: rawOutput.length,
              unit: "chars",
              hint: "Narrow the request (grep instead of read, or read with offset/limit) rather than repeating it."
            })}`
          : rawOutput
        resultContent.push({
          type: "tool_result",
          tool_use_id: call.id,
          content,
          is_error: isError
        })

        // 图片紧跟在它的 tool_result 之后。Anthropic 与 OpenAI 都不接受
        // tool_result 内部嵌图，所以只能作为同一条 user 消息里的后续块 ——
        // 这也是 read 的「可视觉分析」承诺唯一能落地的方式。
        const image = entry?.result?.image
        if (image?.data) {
          resultContent.push({ type: "image", data: image.data, mediaType: image.mediaType })
        }
      }
      await appendMessage(sessionId, "user", resultContent, {
        mode,
        model,
        providerType,
        step,
        turnId,
        synthetic: true
      })

      // --- Doom loop detection: 3x identical tool call → inject warning ---
      for (const call of response.toolCalls) {
        doomTracker.push(`${call.name}::${JSON.stringify(call.args || {})}`)
      }
      if (doomTracker.length > 6) doomTracker.splice(0, doomTracker.length - 6)
      if (doomTracker.length >= 3) {
        const last3 = doomTracker.slice(-3)
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          await appendMessage(sessionId, "user", "[DOOM LOOP DETECTED] You called the same tool with identical arguments 3 times consecutively. STOP repeating this approach — it will not work. Try a completely different strategy, re-read the relevant files, or ask the user for guidance.", {
            mode, model, providerType, step, turnId, synthetic: true
          })
          doomTracker.length = 0
        }
      }

      // --- Soft step warning: alert model when nearing the limit ---
      if (step === maxSteps - 2) {
        await appendMessage(sessionId, "user", `[STEP LIMIT WARNING] You have used ${step} of ${maxSteps} steps. You are running low — wrap up your current work, summarize progress, and list any remaining tasks.`, {
          mode, model, providerType, step, turnId, synthetic: true
        })
      }

      await EventBus.emit({
        type: EVENT_TYPES.TURN_STEP_FINISH,
        sessionId,
        turnId,
        payload: { step, toolCalls: response.toolCalls.length }
      })
    }

    finalReply = "Reached max steps. Review tool outputs and continue in a new turn."
    await appendMessage(sessionId, "assistant", finalReply, {
      mode,
      model,
      providerType,
      turnId,
      maxSteps: true
    })
    await markTurnFinished(sessionId, recoveryEnabled)
    await EventBus.emit({
      type: EVENT_TYPES.TURN_FINISH,
      sessionId,
      turnId,
      payload: { maxSteps: true, reply: finalReply }
    })
    return {
      sessionId,
      turnId,
      reply: finalReply,
      emittedText: emittedAnyText,
      context: lastContextMeter,
      usage,
      toolEvents,
      planHandoff
    }
  } catch (error) {
    await markSessionStatus(sessionId, "error")
    await markTurnFinished(sessionId, recoveryEnabled)
    if (recoveryEnabled) {
      await updateSession(sessionId, {
        retryMeta: {
          inProgress: false,
          turnId,
          failedAt: Date.now(),
          error: error.message
        }
      })
    }
    await EventBus.emit({
      type: EVENT_TYPES.TURN_ERROR,
      sessionId,
      turnId,
      payload: { error: error.message }
    })
    return {
      sessionId,
      turnId,
      reply: `provider error: ${error.message}`,
      emittedText: emittedAnyText,
      context: lastContextMeter,
      usage,
      toolEvents
    }
  }
}
