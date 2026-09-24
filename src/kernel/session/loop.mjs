import { currentRuntime, runWithRuntime, runtimeCwd } from "../core/runtime-context.mjs"
import { createHash } from 'node:crypto'
import { reviewSensitiveAction } from '../permission/auto-review.mjs'
import { newId } from "../core/types.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { requestProviderStream, countTokensProvider } from "../provider/router.mjs"
import { attachResponsesState } from '../provider/responses-state.mjs'
import { attachAnthropicState } from '../provider/anthropic-state.mjs'
import { ToolRegistry } from "../tool/registry.mjs"
import { executeTool } from "../tool/executor.mjs"
import { markToolProgramCall } from '../tool/program.mjs'
import { currentDurableRun } from '../orchestration/run-runtime.mjs'
import { archiveToolText, artifactArchiveAttempted, createConversationArtifactAccess, trustedArtifactRef, trustedArtifactRefs } from '../tool/artifacts.mjs'
import { markBrowserRecipeCall } from '../tool/browser-recipe.mjs'
import { effectiveDataPolicy, intersectDataPolicies } from '../permission/data-policy.mjs'
import { isToolSuccess } from "../core/types.mjs"
import { PermissionEngine } from "../permission/engine.mjs"
import { normalizePermissionLevel, toolCapability } from "../permission/rules.mjs"
import { addModelUsage, priceModelUsage } from '../../usage/model-ledger.mjs'
import { APPROVAL_LEVELS, approvalFromAgentPermission } from "../core/modes.mjs"
import { createTaskDelegate } from "../orchestration/task-scheduler.mjs"
import { loadInstructions } from "./instruction-loader.mjs"
import { buildSystemPromptBlocks } from "./system-prompt.mjs"
import { detectProjectContext } from "./project-context.mjs"
import { renderRulesPrompt } from "../../rules/load-rules.mjs"
import { loadProfile } from "../../onboarding.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import { createSkillToolPolicy } from '../skill/tool-policy.mjs'
import {
  touchSession,
  appendMessage,
  appendPart,
  getConversationHistory,
  markSessionStatus,
  updateSession
} from "./store.mjs"
import { pendingRejections, markRejectionsConsumed } from "../../review/rejection-queue.mjs"
import { isRecoveryEnabled, markTurnFinished, markTurnInProgress } from "./recovery.mjs"
import { HookBus, initHookBus } from "../plugin/hook-bus.mjs"
import { shouldCompact, compactSession, estimateTokenCount, modelContextLimit, supportsNativeCompaction } from "./compaction.mjs"
import { saveCheckpoint } from "./checkpoint.mjs"
import { createRenderStream } from "./render-stream.mjs"
import { askPlanApproval } from "../tool/question-prompt.mjs"
import { createValidator } from "./task-validator.mjs"
import { runSpecRole } from "../orchestration/run-spec.mjs"
import { createRequestContext } from "../../http/identity.mjs"
import { resolveExtensionPolicy } from "../../context.mjs"
import { toolOutputBudget, truncationNotice } from "../tool/output-budget.mjs"
import { requestContextBudget } from './context-budget.mjs'
import { promptReport } from './prompt-report.mjs'
import { createProgressGuard } from './progress-guard.mjs'
import { resolveModelCapabilities } from '../provider/model-catalog.mjs'

// 每条 tool_result 进入活动上下文的字符上限。0.6.3 之前是硬编码 3000 ——
// 一个 268 行的普通源文件有 12494 字符，模型只能看到四分之一，而且不知道
// 自己没读全。同行量级：opencode 50KB、Codex 1MiB、Claude Code 约 100KB。
// 现在按当前模型的上下文动态推算，见 tool/output-budget.mjs。
// 保留常量名作为兜底（拿不到模型信息时用）。
const TOOL_RESULT_FALLBACK_LIMIT = 16000
const attachProviderState = (content, state) => state?.protocol === 'anthropic'
  ? attachAnthropicState(content, state) : attachResponsesState(content, state)

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
  if (toolName === 'browser') return ['status', 'snapshot', 'screenshot', 'diagnostics', 'close', 'tabs', 'frames', 'dialogs'].includes(args.action)
  if (toolName === 'browser_bridge') return ['status', 'snapshot', 'screenshot', 'disconnect', 'tabs'].includes(args.action)
  if (toolName === 'browser_recipe') return args.action === 'list'
  if (['office_capabilities', 'office_inspect'].includes(toolName)) return true
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
  "read", "glob", "grep", "list", "webfetch", "websearch", "codesearch", "tool_search", "tool_batch", "tool_program",
  "background_output", "todowrite", "enter_plan", "exit_plan",
  "sysinfo", "question", "task_list", "task_get", "task_output", "task_parallel",
  "git_status", "git_info", "git_list_snapshots", "artifact_read", "artifact_search", "lsp", "mcp_resource", "mcp_prompt", "office_capabilities", "office_inspect"
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
  "git_status", "git_info", "git_list_snapshots", "artifact_read", "artifact_search"
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
  if (name === 'browser') return !['status', 'snapshot', 'screenshot', 'diagnostics', 'close', 'tabs', 'frames', 'dialogs'].includes(args.action)
  if (name === 'browser_bridge') return !['status', 'snapshot', 'screenshot', 'disconnect', 'tabs'].includes(args.action)
  if (name === 'browser_recipe') return args.action !== 'list'
  if (name === "bash") {
    return toolCapability("bash", String(args?.command || "")) !== "safe-shell"
  }
  return !NON_MUTATING_TOOLS.has(name)
}

/**
 * 计划审批的选择 → 执行这份计划时切到的模式 id。
 *
 * 走模式 id（而不是各自设一个标志位）是刻意的：REPL 拿到 planHandoff 后调的是
 * `switchModeInPlace`，和 `/yolo`、`/ultra` 完全同一条路 —— 航道、审批档、
 * 状态栏三处一起改。少走这条路就会出现「显示是 YOLO、判定链还按 manual 拦」
 * 这类只改一半的状态。
 */
const PLAN_BUILD_MODE = Object.freeze({
  assistant: "agent",
  compact_assistant: "agent",
  longagent: "ultra",
  compact_longagent: "ultra",
  yolo: "yolo"
})

/**
 * 计划审批的选择 → 执行模式 id。不认识的选择返回 null，**不**默默回落到 agent：
 * 回落写在这里的话，「新加了一个选项但忘了登记」会得到一个合法的模式 id，
 * 于是任何「每个选项都映射得出模式」的断言都会对着回落值成立、永远不红。
 * 回落留在调用点。
 */
export function planBuildModeId(action) {
  return PLAN_BUILD_MODE[action] || null
}

/**
 * 计划审批的选择 → 回给模型的指令。
 *
 * 与 planBuildModeId 分工：那个决定切到哪个模式，这个告诉模型接下来做什么。
 * 同样按选项枚举，缺一项就会静默退化成一句泛化的「按所选路径继续」。
 */
export function planApprovalInstruction(action, planPath = "") {
  const at = planPath ? ` at ${planPath}` : ""
  return {
    plan_saved: `The plan is saved${at}. This is a non-interactive run, so no build follows: report the plan location and stop. Do NOT call exit_plan again.`,
    assistant: `User selected Build. Implement the saved plan${at} in the unified assistant lane using the current permission level.`,
    longagent: `User selected Ultra Build. The session is switching to Ultra; implement the saved plan${at} as a staged delivery.`,
    compact_assistant: `User selected Compact + Build. Compact the relevant context first, then implement the saved plan${at} in the unified assistant lane.`,
    compact_longagent: `User selected Compact + Ultra Build. Compact the relevant context first; the session is switching to Ultra to deliver the saved plan${at} in stages.`,
    yolo: `User selected Yolo Build. The session is switching to YOLO: approvals are OFF, so tool calls no longer stop for confirmation. Implement the saved plan${at} end to end and report what you changed.`
  }[action] || null
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


export async function buildSystemPrompt({ mode, model, cwd, agent = null, tools = [], skills = [], language = "en", permission = 'manual' }) {
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
  const result = await buildSystemPromptBlocks({ mode, model, cwd, agent, tools, skills, userInstructions, projectContext, language, permission })
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
  // args.skill：不提取的话技能调用的 pattern 恒为 "*"，规则没法针对某个技能，
  // 审批弹窗也说不出用户正在批准哪一个。
  return String(args.path || args.command || args.pattern || args.task_id || args.skill || "*")
}

function normalizeMessageForCache(msg) {
  // Cache identity only. Budgeting must use actual content, not a clipped
  // preview or this digest (large tool results and images were undercounted).
  return {
    role: String(msg?.role || ""),
    content: createHash('sha256').update(JSON.stringify(msg?.content ?? '')).digest('hex')
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

export function processTurnLoop(options) {
  // Recursive delegation must inherit dependencies, not the parent's prompt
  // identity. In particular question tools have no explicit session argument.
  return runWithRuntime({ ...currentRuntime(), sessionId: options.sessionId,
    signal: options.signal || null,
    parentSessionId: options.runSpec?.parentSessionId || null,
    subagent: options.subagent?.name || null }, () => processTurnLoopInRuntime(options))
}

async function processTurnLoopInRuntime({
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
  toolContext = /** @type {Record<string, any>} */ ({}),
  runSpec = null,
  /**
   * 插话来源：() => string[]。每个 step 边界取一次，取到的文本作为 user 消息
   * 写进会话，本 step 的模型请求立刻能看到 —— 这就是 TUI 里「排队后再按一次
   * Enter」的送达端。null 表示宿主不支持插话（行模式、子代理、后台任务）。
   */
  steerSource = null
}) {
  const cwd = runtimeCwd()
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
  const artifactAccess = currentDurableRun()?.artifactAccess || createConversationArtifactAccess({ sessionId, cwd, turnId })
  const skillToolPolicy = createSkillToolPolicy(toolContext.skillAllowedTools, toolContext.skillToolGroups)
  const activatedTools = new Set()
  const toolCallingAvailable = (await resolveModelCapabilities(configState, providerType, model)).capabilities.tools !== false
  const activateTools = names => {
    for (const name of names) { activatedTools.delete(name); activatedTools.add(name) }
    while (activatedTools.size > 64) activatedTools.delete(activatedTools.values().next().value)
  }
  const listModelTools = async options => !toolCallingAvailable ? [] : (typeof ToolRegistry.listForModel === 'function'
    ? ToolRegistry.listForModel({ ...options, activated: activatedTools, allowedTools: effectiveAgent?.tools || null })
    : ToolRegistry.list(options)).then(tools => tools.filter(tool => skillToolPolicy.allows(tool.name, {}, true)))
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
  const modelUsage = new Map()
  const toolEvents = []
  const progressGuard = createProgressGuard()
  let emittedAnyText = false
  let lastContextMeter = null
  // Plan 审批后的执行航道交接，由调用方（REPL）真正切换模式并续跑
  let planHandoff = null
  let contextCachePoint = null
  const thresholdRatio = Number(configState.config.session?.compaction_threshold_ratio ?? 0.85)
  const thresholdMessages = Number(configState.config.session?.compaction_threshold_messages ?? 200)
  const cachePointsEnabled = configState.config.session?.context_cache_points !== false
  const useNativeCompaction = supportsNativeCompaction(providerType, model, configState)
  const nativeCompactionTrigger = useNativeCompaction ? Number(configState.config.provider?.[providerType]?.compaction_trigger
    ?? Math.max(50000, Math.floor(modelContextLimit(model, configState, providerType) * Math.min(thresholdRatio, 0.75)))) : 0
  const effectiveAgent = runSpecRole(runSpec) || subagent || agent
  const permissionConfig = tightenPermissionConfig(configState.config, effectiveAgent?.permission)
  const selection = currentRuntime()?.sessionSelection?.sessionId === sessionId ? currentRuntime().sessionSelection : null

  await touchSession({
    sessionId,
    mode: selection?.mode || mode,
    model: selection?.model || model,
    providerType: selection?.providerType || providerType,
    cwd,
    parentSessionId: runSpec?.parentSessionId || null,
    status: "active",
    title: subagent ? `${subagent.name}: ${prompt.slice(0, 60)}` : prompt.trim().replace(/\s+/g, ' ').slice(0, 60)
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

  let systemTools = await listModelTools({ mode, config: configState.config, cwd })
  if (effectiveAgent?.tools) {
    systemTools = systemTools.filter((t) => effectiveAgent.tools.includes(t.name))
  }
  const skills = SkillRegistry.isReady() ? SkillRegistry.listForSystemPrompt() : []
  const language = configState.config.language || "en"
  const systemPrompt = await buildSystemPrompt({ mode, model, cwd, agent: effectiveAgent, tools: systemTools, skills, language, permission: normalizePermissionLevel(permissionConfig.permission || {}) })
  // systemPrompt = { text, blocks } — providers use blocks for cache optimization
  const delegateTask = createTaskDelegate({
    getSkillToolGroups: () => skillToolPolicy.snapshot(),
    config: { ...configState.config, data_policy: effectiveDataPolicy(configState) },
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
        toolContext: { ...toolContext, skillAllowedTools: null, skillToolGroups: skillToolPolicy.snapshot() }
      })
    }
  })

  const MAX_CONTINUES = 8
  const MAX_TOTAL_CONTINUES = 24 // hard cap on total auto-continues per turn
  let continueCount = 0
  let totalContinueCount = 0
  let nudgeCount = 0
  let finalReply = ""
  // 渲染流（阶段 3a）：用户可见输出纯化为数据事件；旧 output 字节轨经
  // 前端登记的渲染器驱动（双轨期，见 session/render-stream.mjs 头注释）。
  const render = createRenderStream({
    output,
    renderMarkdown: configState.config.ui?.markdown_render !== false && output?.renderMarkdown !== false,
    eventBus: EventBus,
    sessionId,
    turnId
  })
  try {
    for (let step = 1; step <= maxSteps; step++) {
      await markTurnInProgress(sessionId, turnId, step, recoveryEnabled)
      // 插话在 step 边界送达：写进会话后，下面 getConversationHistory 自然带上，
      // 本 step 的模型请求就能看到。放在这里而不是工具执行中间，是因为消息序
      // 必须落在两次 assistant 响应之间 —— 夹进 tool_result 的中间会打乱
      // 「assistant → tool → assistant」的配对，部分 provider 会直接拒收。
      if (steerSource) {
        for (const steered of steerSource()) {
          await appendMessage(sessionId, "user", steered)
          await EventBus.emit({
            type: EVENT_TYPES.TURN_STEER_INJECTED,
            sessionId,
            turnId,
            payload: { text: steered, step }
          })
        }
      }
      await EventBus.emit({
        type: EVENT_TYPES.TURN_STEP_START,
        sessionId,
        turnId,
        payload: { step }
      })

      let tools = await listModelTools({ mode, config: configState.config, cwd })
      if (effectiveAgent?.tools) {
        tools = tools.filter((t) => effectiveAgent.tools.includes(t.name))
      }
      // Compaction decisions must see the complete active history. Applying
      // max_history before this point silently drops context and can prevent the
      // message threshold from ever being reached.
      let history = await getConversationHistory(sessionId, 9999)
      // Count exactly the hook-transformed request that will be sent. Plugins
      // can add context; counting the canonical history alone underestimates it.
      let messages = await HookBus.messagesTransform([...history])
      const normalizedHistory = messages.map(normalizeMessageForCache)
      let contextTokens = requestContextBudget({ system: systemPrompt, messages, tools, model, configState, providerType }).tokens
      let contextFromCache = false

      // Use real token counting API when available (includes system + tools + messages)
      const realCount = await countTokensProvider({
        configState, providerType, model,
        system: systemPrompt, messages, tools,
        baseUrl, apiKeyEnv,
        traceId: turnTraceContext.traceId,
        sessionId,
        turnId,
        signal
      })
      if (realCount != null) {
        contextTokens = realCount
      } else if (contextCachePoint && contextCachePoint.toolSignature === JSON.stringify(tools.map(tool => [tool.name, tool.description, tool.inputSchema])) && isPrefixMessages(contextCachePoint.messages, normalizedHistory)) {
        const delta = messages.slice(contextCachePoint.messages.length)
        contextTokens = contextCachePoint.tokens + estimateTokenCount(delta)
        contextFromCache = true
      } else if (contextCachePoint) {
        contextCachePoint = null
      }
      const contextLimit = modelContextLimit(model, configState, providerType)
      const contextRatio = contextLimit > 0 ? Math.min(1, contextTokens / contextLimit) : 0
      lastContextMeter = { ...requestContextBudget({ system: systemPrompt, messages, tools, model, configState, providerType, measuredTokens: realCount ?? (contextFromCache ? contextTokens : null), source: realCount != null ? 'count-api' : 'estimated' }), fromCache: contextFromCache }

      if (cachePointsEnabled && (step === 1 || contextRatio >= thresholdRatio)) {
        contextCachePoint = {
          messages: normalizedHistory,
          tokens: contextTokens,
          toolSignature: JSON.stringify(tools.map(tool => [tool.name, tool.description, tool.inputSchema]))
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

      if ((!useNativeCompaction || lastContextMeter.requiredTokens > lastContextMeter.limit) && shouldCompact({
        messages: normalizedHistory,
        model,
        thresholdMessages,
        thresholdRatio,
        configState,
        providerType,
        realTokenCount: lastContextMeter.requiredTokens
      })) {
          await EventBus.emit({ type: EVENT_TYPES.SESSION_COMPACTING, sessionId, turnId, payload: {} })
          const compactResult = await compactSession({
            sessionId, model, providerType, configState, baseUrl, apiKeyEnv,
            traceId: turnTraceContext.traceId,
            turnId,
            onUsage: entry => addModelUsage(modelUsage, entry.provider, entry.model, entry.usage)
          })
          if (compactResult.reasonCode === 'history_changed') {
            contextCachePoint = null
            throw new Error('压缩期间对话或模型已被修改；旧摘要未保存，当前回合已停止。请在最新会话状态下重试。')
          }
          if (compactResult.compacted) {
            const beforeTokens = Number(lastContextMeter?.tokens) || 0
            history = await getConversationHistory(sessionId, 9999)
            messages = await HookBus.messagesTransform([...history])
            const compactedMeter = requestContextBudget({ system: systemPrompt, messages, tools, model, configState, providerType })
            // 事件带上前后 token 数 —— UI 层的「已压缩，193.4K → 42.1K」提示全靠它
            await EventBus.emit({
              type: EVENT_TYPES.SESSION_COMPACTED, sessionId, turnId,
              payload: { ...compactResult, beforeTokens, afterTokens: compactedMeter.tokens, limit: compactedMeter.limit }
            })
            lastContextMeter = { ...compactedMeter, fromCache: false }
            contextCachePoint = {
              messages: messages.map(normalizeMessageForCache),
              tokens: compactedMeter.tokens,
              toolSignature: JSON.stringify(tools.map(tool => [tool.name, tool.description, tool.inputSchema]))
            }
          }
        }

      // runSpec.limits 是委派方给子智能体立的硬约束。0.6.0 之前两个字段
      // 写进 runSpec 后全仓无读取点 —— 立了规矩没人执行。
      await updateSession(sessionId, { context: lastContextMeter, promptReport: promptReport(systemPrompt, tools, lastContextMeter, { turnId, step }) })
      await EventBus.emit({ type: 'session.context.updated', sessionId, turnId, payload: { context: lastContextMeter } })
      if (lastContextMeter.requiredTokens > lastContextMeter.limit) {
        throw new Error(`Context budget exceeded after compaction: ${lastContextMeter.tokens} input + ${lastContextMeter.outputReserved} reserved output > ${lastContextMeter.limit}. Reduce injected instructions/tools, lower max_tokens, or choose a larger-context model.`)
      }
      const limits = runSpec?.limits || null
      if (limits?.deadlineAt && Date.now() > Number(limits.deadlineAt)) {
        finalReply = `${finalReply}\n[deadline exceeded — stopping]`.trim()
        break
      }
      if (limits?.budgetUsd > 0 && usage.input + usage.output > 0) {
        try {
          const { amount } = await priceModelUsage(configState, [...modelUsage.values()])
          if (amount >= limits.budgetUsd) {
            finalReply = `${finalReply}\n[budget ${limits.budgetUsd} USD exhausted — stopping]`.trim()
            break
          }
        } catch { /* 计价表缺失时预算检查静默跳过 */ }
      }

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
          maxTokens: lastContextMeter.outputReserved,
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
        let streamProviderState = null
        let streamUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        let streamContextUsage = null
        let streamStopReason = "end_turn"
        ;(/** @type {(step: number) => void} */ (render.beginStep))(step)

        for await (const chunk of chunks) {
          if (signal?.aborted) {
            const error = /** @type {Error & { code: string, errorClass: string }} */ (new Error("provider stream cancelled"))
            error.code = "ABORT_ERR"
            error.errorClass = "aborted"
            throw error
          }
          if (chunk.type === "thinking") {
            const text = chunk.content || ""
            thinkingParts.push(text)
            await render.thinkingDelta(step, text)
          } else if (chunk.type === "text") {
            const text = chunk.content || ""
            await render.textDelta(step, text)
            textParts.push(text)
          } else if (chunk.type === "tool_call") {
            await render.toolCallChunk(step, chunk.call)
            streamToolCalls.push(chunk.call)
          } else if (chunk.type === "usage") {
            streamUsage = chunk.usage
            streamContextUsage = chunk.contextUsage || null
          } else if (chunk.type === "compaction") {
            await render.providerCompaction(step)
          } else if (chunk.type === "stop") {
            streamStopReason = chunk.reason || "end_turn"
          } else if (chunk.type === 'provider_state') {
            streamProviderState = chunk.state
          }
        }
        if (signal?.aborted) {
          const error = /** @type {Error & { code: string, errorClass: string }} */ (new Error("provider stream cancelled"))
          error.code = "ABORT_ERR"
          error.errorClass = "aborted"
          throw error
        }
        await render.streamEnd(step)
        if (textParts.length) {
          emittedAnyText = true
        }

        response = {
          text: textParts.join(""),
          reasoning: thinkingParts.join(""),
          toolCalls: streamToolCalls,
          usage: streamUsage,
          contextUsage: streamContextUsage,
          stopReason: streamStopReason,
          providerState: streamProviderState
        }
      } catch (error) {
        if (error.needsCompaction) {
          await EventBus.emit({ type: EVENT_TYPES.SESSION_COMPACTING, sessionId, turnId, payload: {} })
          const compactResult = await compactSession({
            sessionId, model, providerType, configState, baseUrl, apiKeyEnv,
            traceId: turnTraceContext.traceId,
            turnId,
            onUsage: entry => addModelUsage(modelUsage, entry.provider, entry.model, entry.usage)
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
      addModelUsage(modelUsage, providerType, model, response.usage || {})

      // Update context meter with real API total input tokens
      // Anthropic: input_tokens is only non-cached portion; total = input + cacheRead + cacheWrite
      // OpenAI: prompt_tokens is already the total
      const u = response.contextUsage || response.usage || {}
      const totalInput = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)
      if (totalInput > 0) {
        lastContextMeter = {
          ...requestContextBudget({ system: systemPrompt, messages, tools, model, configState, providerType, measuredTokens: totalInput + (u.output || 0), source: 'provider-usage' }),
          fromCache: false,
          cacheRead: u.cacheRead || 0,
          cacheWrite: u.cacheWrite || 0,
          inputUncached: u.input || 0
        }
      }

      await updateSession(sessionId, { context: lastContextMeter })
      // Emit cumulative usage so status bar can update in real-time
      await EventBus.emit({
        type: EVENT_TYPES.TURN_USAGE_UPDATE,
        sessionId,
        turnId,
        payload: { usage: { ...usage }, step, model, context: lastContextMeter ? {
          tokens: totalInput > 0 ? totalInput : lastContextMeter.tokens,
          limit: lastContextMeter.limit,
          ratio: Math.min(1, (totalInput > 0 ? totalInput : lastContextMeter.tokens) / lastContextMeter.limit),
          percent: Math.round(Math.min(1, (totalInput > 0 ? totalInput : lastContextMeter.tokens) / lastContextMeter.limit) * 100),
          fromCache: lastContextMeter.fromCache,
          ...(totalInput > 0 ? { cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, inputUncached: u.input || 0 } : {})
        } : null }
      })
      await EventBus.emit({ type: 'session.context.updated', sessionId, turnId, payload: { context: lastContextMeter } })

      // --- Auto-continue on output truncation (max_tokens) ---
      // 续写的前提是「真的撞上了输出预算」。有些兼容网关在答案完整结束后仍报
      // finish_reason=length —— 不拦的话，已经结束的一轮会再发起一次请求，
      // 用户看到的就是「回合结束后突然又开始思考」。两道证据闸门：
      //   1. 这一轮确实有半成品内容（文本/有效工具调用/思考至少其一）——
      //      空响应没有可锚定的断点，「被截断」无从谈起；
      //   2. 已知模型真实输出上限（provider.max_output_tokens，配置或目录
      //      发现）时，usage.output 必须接近有效预算（请求预算与实际上限取
      //      小）。上限未知的 provider 维持旧行为 —— 那里续写仍是唯一能把
      //      长输出拼完整的手段。
      const validToolCalls = (response.toolCalls || []).filter(tc => !tc.args?.__parse_error)
      const hasPartialContent = Boolean(response.text) || validToolCalls.length > 0 || Boolean(response.reasoning)
      const requestedOutputBudget = lastContextMeter.outputReserved
      const knownOutputCap = Number(configState.config.provider?.[providerType]?.max_output_tokens) || 0
      const effectiveOutputBudget = knownOutputCap > 0 ? Math.min(requestedOutputBudget, knownOutputCap) : 0
      const reportedOutput = Number((response.contextUsage || response.usage)?.output) || 0
      const truncationCredible = hasPartialContent && (
        effectiveOutputBudget > 0 && reportedOutput > 0
          ? reportedOutput >= effectiveOutputBudget * 0.9
          : true
      )
      if (response.stopReason === "max_tokens" && !truncationCredible) {
        console.error(`[kkcode] provider reported max_tokens for model "${model}" without truncation evidence (output=${reportedOutput}, budget=${effectiveOutputBudget || "unknown"}); treating the response as complete`)
      }
      if (response.stopReason === "max_tokens" && truncationCredible && continueCount < MAX_CONTINUES && totalContinueCount < MAX_TOTAL_CONTINUES) {
        continueCount++
        totalContinueCount++
        await render.autoContinue(step, { continueCount, maxContinues: MAX_CONTINUES })

        // Save partial output as assistant message
        const partialContent = []
        if (response.reasoning) partialContent.push({ type: 'reasoning', text: response.reasoning })
        if (response.text) {
          partialContent.push({ type: "text", text: response.text })
        }
        for (const call of validToolCalls) {
          partialContent.push({ type: "tool_use", id: call.id, name: call.name, input: call.args || {} })
        }
        if (partialContent.length || response.providerState?.items?.length) {
          await appendMessage(sessionId, "assistant", attachProviderState(partialContent.length === 1 && partialContent[0].type === "text"
            ? partialContent[0].text
            : partialContent, response.providerState), {
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
              todoState: toolContext._todoState,
              // Never launch project scripts/npx behind the tool permission
              // boundary (or on a simple question). The agent must request
              // verification commands through normal approved tools.
              level: 'evidence'
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
            await render.validationSkipped(step, validationError.message)
          }
        }
        
        finalReply = (response.text || "").trim() || "No content returned from provider."
        const finalContent = attachProviderState(response.reasoning
          ? [
              { type: "reasoning", text: response.reasoning },
              { type: "text", text: finalReply }
            ]
          : finalReply, response.providerState)
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
        // 终态闸：TURN_FINISH 之后这个回合不再产出任何流式/thinking 事件
        render.close()
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
      async function executeOneCall(call, childSignal = null, browserRecipeGuard = null) {
        const callSignal = childSignal instanceof AbortSignal ? (signal ? AbortSignal.any([signal, childSignal]) : childSignal) : signal
        let programSequence = 0
        let recipeSequence = 0
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

        const risk = ["bash", "write", "edit", "task"].includes(call.name) ? 9 : 1
        let result
        try {
          if (!toolCallingAvailable) throw new Error('The selected model is configured without tool calling. No tool action was executed; select a tool-capable model or correct its capability configuration.')
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
          if (call.args?.__parse_error === true) throw new Error(`Invalid JSON arguments for ${call.name}; resend one complete JSON object matching the tool schema. No tool action was executed.`)
          if (!skillToolPolicy.allows(call.name, call.args)) throw new Error(`tool "${call.name}" is blocked by the active skill allowed-tools policy`)

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
            // 先取工具：有些工具的能力取决于参数（技能是模板展开还是执行代码），
            // 由工具自己回答比在权限层里堆特例更准。
            const pendingTool = await ToolRegistry.get(call.name)
            const permission = await PermissionEngine.check({
              config: permissionConfig,
              capability: pendingTool?.capabilityFor?.(call.args) || null,
              sessionId,
              turnId,
              traceId: stepRequestContext.traceId,
              requestId: stepRequestContext.requestId,
              reviewId: `auto-${runningPart.id}`,
              tool: call.name,
              mode,
              pattern: toolPatternFromArgs(call.args),
              command: call.name === "bash" ? String(call.args?.command || "") : "",
              args: call.args,
              risk,
              workspace: cwd,
              reason: `tool call from model at step ${step}`,
              signal: callSignal,
              reviewSensitive: async action => {
                const verdict = await reviewSensitiveAction({ configState, providerType, model, baseUrl, apiKeyEnv, sessionId, turnId, prompt: effectivePrompt, action, signal: callSignal })
                addUsage(usage, verdict.usage || {})
                addModelUsage(modelUsage, verdict.provider || providerType, verdict.model || model, verdict.usage || {})
                await appendPart(sessionId, { id: `auto-${runningPart.id}`, type: 'permission-review', messageId: userMessage.id, step, turnId, tool: call.name, decision: verdict.decision, reason: verdict.reason, model: verdict.model || model, provider: verdict.provider || providerType, usage: verdict.usage || {} })
                return verdict
              }
            })

            const tool = pendingTool
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
            // A strict task's filesystem scope is not its network authority.
            // These finite managed adapters still pass the durable coordinator's
            // exact external-action grants and the strict backend's site policy.
            const strictManagedNetwork = Boolean(currentDurableRun()) && runSpec?.workspace?.isolation === 'strict' && ['browser', 'http_request'].includes(call.name)
            const deniedByWriteScope = readOnlyScope && !strictManagedNetwork && canMutateWorkspace(call.name, call.args)
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
                    sessionId,
                    turnId,
                    // 工具需要知道当前模型与渠道才能算输出预算（动态上限）。
                    // 0.6.3 之前 ctx 只有 config，于是任何按模型能力调整的
                    // 工具行为都无从下手。
                    model,
                    providerType,
                    // 单次工具输出的字符预算。工具内部若有自己的硬编码上限
                    // （bash 曾是 30000），应改读这个值，否则「动态预算」只
                    // 管到 loop 这一层，工具那一层照旧按固定数字砍。
                    toolResultLimit,
                    ...toolContext,
                    // Preserve trusted config provenance; model/per-turn JSON
                    // cannot grant a project permission to choose a binary.
                    configState,
                    // Never accept service capabilities from per-turn JSON.
                    lspService: currentRuntime()?.services?.lsp,
                    officeService: currentRuntime()?.services?.office,
                    recipeGuard: browserRecipeGuard,
                    signal: callSignal,
                    config: { ...configState.config, ...(toolContext.config || {}),
                      data_policy: intersectDataPolicies(effectiveDataPolicy(configState), toolContext.config?.data_policy) },
                    artifactAccess,
                    toolCallId: call.id,
                    runToolBatch: call.name === 'tool_batch' ? async calls => {
                      const results = [], content = []
                      for (let index = 0; index < calls.length; index++) {
                        signal?.throwIfAborted()
                        const child = calls[index]
                        const outcome = await executeOneCall({ id: `${String(call.id).slice(0, 96)}-batch-${index}`, name: child.name, args: child.args })
                        results.push({ name: child.name, status: outcome.result.status, output: String(outcome.result.output || '').slice(0, Math.floor(toolResultLimit / calls.length)) })
                        if (outcome.result.contentBlocks?.length) content.push(...outcome.result.contentBlocks)
                        if (!isToolSuccess(outcome.result)) break
                      }
                      return { output: JSON.stringify({ completed: results.length, requested: calls.length, results, atomic: false }), content, status: results.every(item => item.status === 'completed') ? 'completed' : 'error' }
                    } : null,
                    runToolProgramCall: call.name === 'tool_program' ? markToolProgramCall(async child => {
                      if (!Number.isSafeInteger(child.index) || child.index !== programSequence || programSequence >= 16) throw new Error('Invalid governed program call sequence')
                      programSequence++
                      callSignal?.throwIfAborted()
                      child.signal?.throwIfAborted()
                      const prefix = createHash('sha256').update(String(call.id)).digest('hex').slice(0, 32)
                      const outcome = await executeOneCall({ id: `${prefix}-program-${child.index}`, name: child.name, args: child.args }, child.signal)
                      const unknown = outcome.result.metadata?.outcomeUnknown === true || outcome.result.code === 'tool_outcome_unknown'
                      const output = typeof outcome.result.output === 'string' ? outcome.result.output : ''
                      if (Buffer.byteLength(output) > 512 * 1024) return { status: 'error', output: 'Leaf output exceeds program byte budget; inspect its archived artifact separately.', outcomeUnknown: unknown }
                      return { status: unknown ? 'unknown' : outcome.result.status, output, outcomeUnknown: unknown }
                    }) : null,
                    runBrowserRecipeCall: call.name === 'browser_recipe' ? markBrowserRecipeCall(async child => {
                      if (!Number.isSafeInteger(child.index) || child.index !== recipeSequence || recipeSequence >= 64 || !['open', 'snapshot', 'click', 'fill', 'press'].includes(child.args?.action) || typeof child.guard?.authorize !== 'function') throw new Error('Invalid governed Browser recipe call')
                      recipeSequence++
                      callSignal?.throwIfAborted(); child.signal?.throwIfAborted()
                      if (await child.guard.authorize() !== true) throw new Error('Browser recipe authorization is no longer active')
                      const prefix = createHash('sha256').update(String(call.id)).digest('hex').slice(0, 32)
                      const outcome = await executeOneCall({ id: `${prefix}-recipe-${child.index}`, name: 'browser', args: child.args }, child.signal, child.guard)
                      return { status: outcome.result.status, output: String(outcome.result.output || ''),
                        outcomeUnknown: outcome.result.metadata?.outcomeUnknown === true || outcome.result.code === 'tool_outcome_unknown',
                        operationNotStarted: ['denied', 'permission_denied', 'tool_not_allowed', 'tool_not_found'].includes(outcome.result.status) || ['permission_denied', 'tool_not_allowed', 'tool_not_found'].includes(outcome.result.code) }
                    }) : null,
                    autoReviewed: permission.autoReviewed === true,
                    activateTools,
                    allowedToolNames: skillToolPolicy.names(await ToolRegistry.list({ mode, config: configState.config, cwd })).filter(name => !effectiveAgent?.tools || effectiveAgent.tools.includes(name)),
                    restrictSkillTools: rules => skillToolPolicy.add(rules)
                  },
                  signal: callSignal
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
          const actionText = planApprovalInstruction(approval.action, planPath)

          // 0.3.x 只把这段文字塞回模型，从不真的切换执行航道。0.4.0 把选择
          // 结果作为 planHandoff 冒泡到 turn 结果，由 REPL 真正切模式并续跑。
          // plan_saved 是非交互收口，没有人选过执行航道，因此不产生交接
          if (approval.approved && approval.action !== "plan_saved") {
            planHandoff = {
              modeId: planBuildModeId(approval.action) || "agent",
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

        // Only host-produced references survive as trusted receipt metadata.
        // A plugin or a model cannot turn arbitrary text into proof of archival.
        let archivedRef = trustedArtifactRef(result)
        if (!archivedRef && !artifactArchiveAttempted(result) && String(result.output || '').length > toolResultLimit) {
          const archived = await archiveToolText({ output: result.output, access: artifactAccess,
            callId: call.id, limit: toolResultLimit, signal })
          result = { ...result, output: archived.output, metadata: { ...result.metadata, ...archived.metadata } }
          archivedRef = trustedArtifactRef(result)
        }
        if (result.metadata?.artifactRef && !archivedRef) {
          const { artifactRef: _untrusted, ...metadata } = result.metadata
          result = { ...result, metadata }
        }
        const archivedRefs = trustedArtifactRefs(result)
        if (result.metadata?.artifactRefs) {
          const { artifactRefs: _untrustedRefs, ...metadata } = result.metadata
          result = { ...result, metadata: { ...metadata, ...(archivedRefs.length ? { artifactRefs: archivedRefs } : {}) } }
        }
        if (archivedRefs.length) activateTools(['artifact_read', 'artifact_search'])

        await appendPart(sessionId, {
          type: "tool-call",
          messageId: userMessage.id,
          step,
          turnId,
          runPartId: runningPart.id,
          tool: call.name,
          args: call.args,
          status: result.status,
          output: result.output,
          metadata: result.metadata,
          durationMs: result.durationMs
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
      await appendMessage(sessionId, "assistant", attachProviderState(assistantContent, response.providerState), {
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

        // Canonical multimodal content is shared by builtin/plugin/MCP tools;
        // provider adapters choose the protocol's concrete tool-result shape.
        const media = entry?.result?.contentBlocks
        if (media?.length) resultContent.push(...media)
        else if (entry?.result?.image?.data) resultContent.push({ type: 'image', ...entry.result.image })
      }
      await appendMessage(sessionId, "user", resultContent, {
        mode,
        model,
        providerType,
        step,
        turnId,
        synthetic: true,
        artifactRefs: [...callResults.values()].flatMap(entry => trustedArtifactRefs(entry.result))
      })

      const progress = progressGuard.observe(response.toolCalls.map(call => callResults.get(call.id)).filter(Boolean).map(entry => {
        const refs = trustedArtifactRefs(entry.result)
        if (!refs.length) return entry
        // Archive IDs are fresh receipts, not evidence of new work. Compare
        // verified captured bytes so repeated large output keeps the same
        // warn/stop behavior as small output. Never trust model-supplied hashes.
        return { ...entry, result: { ...entry.result, output: JSON.stringify({ artifacts: refs.map(ref => ({ sha256: ref.sha256, size: ref.size })).sort((a, b) => a.sha256.localeCompare(b.sha256) || a.size - b.size),
          complete: entry.result.metadata.artifactComplete !== false, exitCode: entry.result.metadata.exitCode ?? null,
          outcomeUnknown: entry.result.metadata.outcomeUnknown === true }) } }
      }))
      if (progress.state === 'warn') {
        await appendMessage(sessionId, 'user', '[NO PROGRESS] The same tool sequence produced identical results three times. Inspect the evidence and change strategy. Do not repeat side effects or claim completion; ask for missing information if needed.', { mode, model, providerType, step, turnId, synthetic: true })
      } else if (progress.state === 'stop') {
        finalReply = language === 'zh' ? '已暂停：相同工具序列连续 6 次没有产生新结果。已有文件和操作结果保留，请检查阻塞原因后继续；这不代表任务已完成。' : 'Paused: the same tool sequence produced no new evidence six times. Existing files and results are preserved. Inspect the blocker before continuing; the task is not claimed complete.'
        await appendMessage(sessionId, 'assistant', finalReply, { mode, model, providerType, step, turnId })
        await markSessionStatus(sessionId, 'no-progress'); await markTurnFinished(sessionId, recoveryEnabled)
        await render.textDelta(step, `\n${finalReply}`); await render.streamEnd(step)
        await EventBus.emit({ type: EVENT_TYPES.TURN_FINISH, sessionId, turnId, payload: { step, reply: finalReply, stopReason: 'no-progress' } })
        render.close()
        return { sessionId, turnId, reply: finalReply, emittedText: true, context: lastContextMeter, usage, toolEvents, planHandoff, stopReason: 'no-progress' }
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
    render.close()
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
    // 与 TURN_FINISH 同一条终态闸：失败路径之后同样不得再有流式事件
    render.close()
    return {
      sessionId,
      turnId,
      // reply 的 "provider error: " 前缀不能动：background-worker 等文本消费方
      // 在匹配它（background-worker.mjs 的 silent provider error 探测）。
      // 结构化失败走 error 字段 —— turn.result 据此给 status: "failed"。
      reply: `provider error: ${error.message}`,
      error: error.message,
      emittedText: emittedAnyText,
      context: lastContextMeter,
      usage,
      toolEvents
    }
  }
}
