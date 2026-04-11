import { detectAgentContinuationInput, extractPromptPathHints } from "./agent-transaction.mjs"

/**
 * LongAgent 共享工具函数
 * 被 longagent.mjs、longagent-hybrid.mjs 共同使用
 */

export const LONGAGENT_FILE_CHANGES_LIMIT = 400

// ========== 共享 JSON 解析工具 ==========

export function stripFence(text = "") {
  const raw = String(text || "").trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced ? fenced[1].trim() : raw
}

export function parseJsonLoose(text = "") {
  const raw = stripFence(text)
  // 1. 直接解析
  try { return JSON.parse(raw) } catch { /* ignore */ }
  // 2. 修复 trailing comma（LLM 常产出 {…, } 或 […, ]）
  const repaired = raw.replace(/,\s*([}\]])/g, "$1")
  if (repaired !== raw) {
    try { return JSON.parse(repaired) } catch { /* ignore */ }
  }
  // 3. 提取最外层 {} 块
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1)
    try { return JSON.parse(slice) } catch { /* ignore */ }
    // 3b. 对提取的块也尝试 trailing comma 修复
    const sliceRepaired = slice.replace(/,\s*([}\]])/g, "$1")
    if (sliceRepaired !== slice) {
      try { return JSON.parse(sliceRepaired) } catch { /* ignore */ }
    }
  }
  return null
}

// ========== Phase 1: 错误分类 ==========

export const ERROR_CATEGORIES = {
  TRANSIENT: "transient",
  LOGIC: "logic",
  PERMANENT: "permanent",
  UNKNOWN: "unknown"
}

export function classifyError(errorText, bgStatus) {
  const text = String(errorText || "").toLowerCase()

  // transient: 网络/超时/限流/worker 消失
  if (
    text.includes("timeout") || text.includes("timed out") ||
    text.includes("econnreset") || text.includes("econnrefused") ||
    text.includes("enotfound") || text.includes("socket hang up") ||
    text.includes("rate limit") || text.includes("429") ||
    text.includes("503") || text.includes("502") ||
    text.includes("worker disappeared") || text.includes("background worker disappeared") ||
    bgStatus === "interrupted"
  ) {
    return ERROR_CATEGORIES.TRANSIENT
  }

  // permanent: 文件不存在/权限不足/配置缺失
  if (
    text.includes("enoent") || text.includes("no such file") ||
    text.includes("eacces") || text.includes("eperm") || text.includes("permission denied") ||
    text.includes("config missing") || text.includes("configuration not found") ||
    text.includes("module not found") || text.includes("cannot find module") ||
    bgStatus === "cancelled"
  ) {
    return ERROR_CATEGORIES.PERMANENT
  }

  // logic: 代码 bug/类型错误/语法错误
  if (
    text.includes("syntaxerror") || text.includes("syntax error") ||
    text.includes("typeerror") || text.includes("type error") ||
    text.includes("referenceerror") || text.includes("reference error") ||
    text.includes("rangeerror") || text.includes("assertionerror") ||
    text.includes("unexpected token") || text.includes("is not a function") ||
    text.includes("is not defined") || text.includes("cannot read propert")
  ) {
    return ERROR_CATEGORIES.LOGIC
  }

  // 默认: 未知类别，不自动重试（避免在不可恢复错误上浪费资源）
  return ERROR_CATEGORIES.UNKNOWN
}

export function isComplete(text) {
  const lower = String(text || "").toLowerCase()
  if (lower.includes("[task_complete]")) return true
  // Only match "task complete" as a standalone phrase, not substring of other text
  if (/\btask[\s_-]?complete\b/.test(lower)) return true
  return false
}

export function isLikelyActionableObjective(prompt) {
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

export function summarizeGateFailures(failures = []) {
  if (!failures.length) return ""
  return failures
    .slice(0, 5)
    .map((item) => `${item.gate}:${item.reason}`)
    .join("; ")
}

export function stageProgressStats(taskProgress = {}) {
  if (!taskProgress || typeof taskProgress !== "object") {
    return { done: 0, total: 0, remainingFiles: [], remainingFilesCount: 0 }
  }
  const items = Object.values(taskProgress)
  const done = items.filter((item) => item.status === "completed").length
  const total = items.length
  const remainingFiles = [...new Set(items.flatMap((item) => Array.isArray(item.remainingFiles) ? item.remainingFiles : []))]
  return { done, total, remainingFiles, remainingFilesCount: remainingFiles.length }
}

export function normalizeFileChange(item = {}) {
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

// ========== 防卡死机制 (ported from Mark's anti-stuck work) ==========

export const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "list", "webfetch", "websearch", "codesearch"])

export function isReadOnlyTool(name) {
  return READ_ONLY_TOOLS.has(name)
}

/**
 * 检测配置文件搜索循环（Qwen 等模型容易反复 glob 配置文件）
 */
export function detectExplorationLoop(recentToolCalls) {
  const recentGlobs = recentToolCalls.slice(-10).filter(sig => sig.startsWith("glob:"))
  if (recentGlobs.length >= 6) {
    const patterns = recentGlobs.map(sig => {
      try { return JSON.parse(sig.slice(5)).pattern } catch { return null }
    }).filter(Boolean)
    const configPatterns = [/pyproject\.toml/, /setup\.py/, /Pipfile/, /Dockerfile/, /\.env/, /main\.py/, /package\.json/, /tsconfig\.json/]
    const matched = patterns.filter(p => configPatterns.some(cp => cp.test(p)))
    if (matched.length >= 4) return { isLoop: true, reason: "repeated_config_file_glob" }
  }
  return { isLoop: false }
}

/**
 * 检测工具调用循环（同类工具重复 / 前后半段完全相同）
 */
export function detectToolCycle(recentToolCalls) {
  if (recentToolCalls.length < 6) return false
  // 同类工具连续 6 次
  const recentTypes = recentToolCalls.slice(-6).map(sig => sig.split(":")[0])
  if (recentTypes.every(t => t === recentTypes[0]) && isReadOnlyTool(recentTypes[0])) return true
  // 前后半段按序列比较（保留顺序信息，避免排序后误报）
  const allReadOnly = recentToolCalls.every(sig => isReadOnlyTool(sig.split(":")[0]))
  if (allReadOnly) {
    const half = Math.floor(recentToolCalls.length / 2)
    if (half >= 3) {
      const first = recentToolCalls.slice(0, half).join(",")
      const second = recentToolCalls.slice(half, half * 2).join(",")
      if (first === second) return true
    }
  }
  return false
}

/**
 * 创建一个有状态的卡死追踪器，供各模式的主循环使用
 */
// ========== Phase 4: 写操作循环检测 ==========

const WRITE_TOOLS = new Set(["write", "edit", "notebookedit"])

function isWriteTool(name) {
  return WRITE_TOOLS.has(name)
}

function detectWriteLoop(recentWriteOps) {
  if (recentWriteOps.length < 3) return { isLoop: false, reason: null }

  // 检测同一文件被连续 edit 3+ 次
  const last3 = recentWriteOps.slice(-3)
  if (last3.every(op => op.path === last3[0].path && op.tool === "edit")) {
    return { isLoop: true, reason: "write_loop_detected" }
  }

  // 检测 write→error→edit→error 循环（同一文件交替出现）
  if (recentWriteOps.length >= 4) {
    const last4 = recentWriteOps.slice(-4)
    const samePath = last4.every(op => op.path === last4[0].path)
    if (samePath) {
      const tools = last4.map(op => op.tool)
      const hasAlternation = (tools[0] === "write" && tools[2] === "edit") ||
                             (tools[0] === "edit" && tools[2] === "write")
      if (hasAlternation) return { isLoop: true, reason: "edit_cycle_detected" }
    }
  }

  return { isLoop: false, reason: null }
}

export function createStuckTracker(maxRecent = 10) {
  const recentToolCalls = []
  const recentWriteOps = []
  let consecutiveReadOnlyCount = 0

  return {
    /** 记录本轮 tool events，返回 { isStuck, reason } */
    track(toolEvents = []) {
      const sigs = toolEvents.map(e => `${e.name}:${JSON.stringify(e.args || {})}`)
      recentToolCalls.push(...sigs)
      while (recentToolCalls.length > maxRecent) recentToolCalls.shift()

      // Phase 4: 追踪写操作
      for (const e of toolEvents) {
        if (isWriteTool(e.name)) {
          recentWriteOps.push({
            tool: e.name,
            path: String(e.args?.path || e.args?.file_path || "").trim(),
            lineRange: e.args?.old_string ? e.args.old_string.slice(0, 50) : ""
          })
          while (recentWriteOps.length > maxRecent) recentWriteOps.shift()
        }
      }

      const allReadOnly = toolEvents.length > 0 && toolEvents.every(e => isReadOnlyTool(e.name))
      if (allReadOnly) consecutiveReadOnlyCount++
      else consecutiveReadOnlyCount = 0

      const loop = detectExplorationLoop(recentToolCalls)
      if (loop.isLoop) return { isStuck: true, reason: loop.reason }
      if (detectToolCycle(recentToolCalls)) return { isStuck: true, reason: "tool_cycle_detected" }
      if (consecutiveReadOnlyCount >= 4) return { isStuck: true, reason: "excessive_read_only_exploration" }

      // Phase 4: 写循环检测
      const writeLoop = detectWriteLoop(recentWriteOps)
      if (writeLoop.isLoop) return { isStuck: true, reason: writeLoop.reason }

      return { isStuck: false, reason: null }
    },
    /** 重置连续只读计数（警告注入后调用） */
    resetReadOnlyCount() { consecutiveReadOnlyCount = 0 },
    get consecutiveReadOnly() { return consecutiveReadOnlyCount },
    get writeOps() { return recentWriteOps }
  }
}

export function mergeCappedFileChanges(current = [], incoming = [], limit = LONGAGENT_FILE_CHANGES_LIMIT) {
  const maxEntries = Math.max(1, Number(limit || LONGAGENT_FILE_CHANGES_LIMIT))
  const map = new Map()

  const append = (entry) => {
    const normalized = normalizeFileChange(entry)
    if (!normalized) return
    const key = `${normalized.path}::${normalized.stageId}::${normalized.taskId}`
    const prev = map.get(key) || { ...normalized, addedLines: 0, removedLines: 0 }
    prev.addedLines += normalized.addedLines
    prev.removedLines += normalized.removedLines
    map.delete(key)
    map.set(key, prev)
  }

  for (const item of current) append(item)
  for (const item of incoming) append(item)

  const merged = [...map.values()]
  if (merged.length > maxEntries) {
    const truncated = merged.slice(merged.length - maxEntries)
    truncated._truncatedFrom = merged.length
    return truncated
  }
  return merged
}

// ========== Phase 5: 语义级错误检测 ==========

export function createSemanticErrorTracker(threshold = 3) {
  const errorHistory = []

  function extractErrorPattern(text) {
    const str = String(text || "")
    const patterns = []
    const errorRegex = /(?:TypeError|ReferenceError|SyntaxError|RangeError|Error|AssertionError):\s*(.+?)(?:\n|$)/gi
    let m
    while ((m = errorRegex.exec(str)) !== null) {
      patterns.push(m[0].trim().slice(0, 120))
    }
    return patterns
  }

  function isSimilar(a, b) {
    if (a === b) return true
    if (a.length < 10 || b.length < 10) return a === b
    // Token-level Jaccard similarity — more robust than substring matching
    const tokenize = (s) => new Set(s.toLowerCase().split(/[\s:.'"`()\[\]{}]+/).filter(t => t.length > 2))
    const setA = tokenize(a)
    const setB = tokenize(b)
    if (!setA.size || !setB.size) return false
    let intersection = 0
    for (const t of setA) { if (setB.has(t)) intersection++ }
    const union = setA.size + setB.size - intersection
    return union > 0 && (intersection / union) >= 0.6
  }

  return {
    track(replyText) {
      const patterns = extractErrorPattern(replyText)
      if (!patterns.length) {
        errorHistory.push(null)
        return { isRepeated: false, error: null, count: 0 }
      }
      const primary = patterns[0]
      errorHistory.push(primary)

      // 检查最近 threshold 次是否出现相同错误
      if (errorHistory.length >= threshold) {
        const recent = errorHistory.slice(-threshold).filter(Boolean)
        if (recent.length === threshold && recent.every(e => isSimilar(e, primary))) {
          return { isRepeated: true, error: primary, count: threshold }
        }
      }
      return { isRepeated: false, error: primary, count: 1 }
    },
    reset() { errorHistory.length = 0 },
    get history() { return errorHistory }
  }
}

// ========== Phase 6: 渐进式降级策略 ==========

export function createDegradationChain(config = {}) {
  const strategies = [
    {
      name: "switch_model",
      apply(ctx) {
        const fallback = config.fallback_model
        if (!fallback || ctx.model === fallback) return false
        ctx.previousModel = ctx.model
        ctx.model = fallback
        return true
      }
    },
    {
      name: "reduce_scope",
      apply(ctx) {
        if (!config.skip_non_critical || !ctx.taskProgress) return false
        let skipped = 0
        for (const [taskId, tp] of Object.entries(ctx.taskProgress)) {
          if (tp.status === "error" || tp.status === "retrying") {
            ctx.taskProgress[taskId] = { ...tp, status: "skipped", skipReason: "degradation_reduce_scope" }
            skipped++
          }
        }
        return skipped > 0
      }
    },
    {
      name: "serial_mode",
      apply(ctx) {
        if (!ctx.configState?.config?.agent?.longagent?.parallel) return false
        ctx.configState.config.agent.longagent.parallel.max_concurrency = 1
        return true
      }
    },
    {
      name: "graceful_stop",
      apply(ctx) {
        ctx.shouldStop = true
        return true
      }
    }
  ]

  let currentLevel = 0

  return {
    canDegrade() { return currentLevel < strategies.length },
    currentStrategy() { return strategies[currentLevel] || null },
    nextStrategy() { return strategies[currentLevel] || null },
    apply(ctx) {
      if (currentLevel >= strategies.length) return { applied: false, strategy: null }
      const strategy = strategies[currentLevel]
      const applied = strategy.apply(ctx)
      if (applied) currentLevel++
      return { applied, strategy: strategy.name }
    },
    get level() { return currentLevel }
  }
}

// ========== Task 1: 智能任务模式分类 ==========

const MODE_REASON_EXPLANATIONS = {
  empty_input: "空输入，按问答处理",
  question_with_explain_intent: "检测到问答 / 解释意图",
  short_question: "检测到简短问答",
  planning_or_design_intent: "检测到规划 / 设计意图",
  long_complex_prompt: "检测到长而复杂的任务描述，可能需要 longagent",
  short_local_task_protected: "检测到短小本地事务，避免升级到 longagent",
  local_transaction_task: "检测到本地事务型任务，适合保持在轻量 agent 路径",
  local_lookup_task: "检测到本地读取 / 总结类任务",
  single_path_or_command_task: "检测到单路径或单命令任务，适合保持在轻量路径",
  multi_file_or_system_task: "检测到跨文件 / 系统级任务",
  broad_scope_multi_step: "检测到宽范围多步骤任务",
  simple_action_task: "检测到单轮执行任务",
  default_agent: "信号偏执行型，保持 agent",
  default_ask: "信号不足，按 ask 处理",
  low_confidence: "信号不足，保持当前模式",
  plan_mode_exempt: "plan 模式不参与自动路由"
}

export function explainTaskModeReason(reason) {
  return MODE_REASON_EXPLANATIONS[reason] || String(reason || "unknown")
}

function countPromptMatches(patterns, input) {
  return patterns.reduce((count, pattern) => count + (pattern.test(input) ? 1 : 0), 0)
}

/**
 * 分析 prompt，判断最适合的执行模式
 * @returns {{ mode: 'ask'|'plan'|'agent'|'longagent', confidence: 'high'|'medium'|'low', reason: string }}
 */
export function classifyTaskMode(prompt, options = {}) {
  const text = String(prompt || "").trim()
  if (!text) return { mode: "ask", confidence: "high", reason: "empty_input" }

  const continuation = options?.continuation || null
  const lower = text.toLowerCase()
  const len = text.length
  const pathHints = extractPromptPathHints(text)
  const hasPathHint = pathHints.length > 0

  const questionPatterns = [
    /^(what|how|why|when|where|who|which|explain|tell me|describe|show me)\b/i,
    /^(什么|为什么|怎么|如何|哪里|哪个|谁|能否|请解释|告诉我|描述|是什么|有什么|怎样)/,
    /[？?]\s*$/
  ]
  const pureAskKeywords = [
    "explain", "what is", "what are", "how does", "why does", "describe", "tell me about",
    "解释", "是什么", "为什么", "怎么理解", "什么意思", "有什么区别", "如何理解"
  ]
  const planPatterns = [
    /\b(plan|design|architect|outline|blueprint|draft|propose|sketch)\b/i,
    /\b(规划|设计|架构|方案|蓝图|草案|提案|计划一下|帮我想想)\b/i
  ]
  const explicitHeavyScopePatterns = [
    /\b(multiple files?|across files?|entire (codebase|project|repo)|all files?|cross[- ]repo|跨文件|多个文件|整个项目|全量)\b/i,
    /\b(refactor|rewrite|overhaul|redesign|migrate).{0,30}(system|service|architecture|repo|project|module|pipeline|codebase)\b/i
  ]
  const heavyDeliveryPatterns = [
    /\b(implement|build|create|develop|add).{0,40}(system|subsystem|service|feature|component|framework|pipeline|architecture|架构|系统|模块|服务|功能|组件|框架|流水线)\b/i,
    /\b(full|complete|comprehensive|end.to.end|完整实现|完全|端到端)\b/i,
    /\b(multi.?stage|multi.?step|phases?|多阶段|多步骤|分阶段)\b/i
  ]
  const inspectPatterns = [
    /\b(run|execute|check|inspect|look at|read|open|summari[sz]e|scan|search|find|list|grep|tail|cat|count|compare|verify|show)\b/i,
    /\b(日志|目录|文件|配置|仓库|看一下|检查|查看|读取|总结|搜一下|列出|执行|运行|验证)\b/i
  ]
  const patchPatterns = [
    /\b(fix|debug|patch|update|change|modify|rename|delete|remove|add|insert|append)\b/i,
    /\b(修复|调试|修改|更新|删除|添加|插入|改一下|帮我改|帮我加)\b/i
  ]
  const singleCommandPatterns = [
    /`[^`]+`/,
    /\b(npm|pnpm|yarn|node|git|ls|cat|grep|rg|find|sed|awk|tail|head)\b/i
  ]
  const verifyPatterns = [
    /\b(test|verify|validate|confirm|make sure|ensure|smoke)\b/i,
    /\b(验证|确认|测试|确保|冒烟)\b/i
  ]

  const isQuestion = questionPatterns.some((re) => re.test(text))
  const isPureAsk = pureAskKeywords.some((kw) => lower.includes(kw))
  const isPlan = planPatterns.some((re) => re.test(lower))
  const explicitHeavyScope = explicitHeavyScopePatterns.some((re) => re.test(lower))
  const heavyDelivery = heavyDeliveryPatterns.some((re) => re.test(lower))
  const hasAcrossScope = /\bacross\b|跨/.test(lower)
  const isLocalTask = inspectPatterns.some((re) => re.test(lower))
  const isPatchTask = patchPatterns.some((re) => re.test(lower))
  const isVerifyTask = verifyPatterns.some((re) => re.test(lower))
  const isAgentAction = isPatchTask || isVerifyTask
  const isSingleCommandTask = singleCommandPatterns.some((re) => re.test(text))
  const isVerificationTask = isVerifyTask
  const hasContinuationSignal = Boolean(options?.continued || continuation?.objective || detectAgentContinuationInput(text, continuation))
  const isLongAgent = explicitHeavyScope || heavyDelivery
  const localSignalCount = [isLocalTask, isPatchTask, isVerifyTask, hasPathHint, isSingleCommandTask, hasContinuationSignal].filter(Boolean).length
  const heavySignalCount = [explicitHeavyScope, heavyDelivery, hasAcrossScope].filter(Boolean).length
  const smallBoundedPathSet = hasPathHint && pathHints.length <= 3
  const isBoundedLocalTask = !isLongAgent && (isLocalTask || isAgentAction) && (hasPathHint || isSingleCommandTask || len < 320)
  const isInspectPatchVerifyLoop = isLocalTask && isAgentAction && isVerificationTask
  const evidence = []
  if (hasPathHint) evidence.push(hasPathHint && pathHints.length === 1 ? "single_path" : "bounded_file_set")
  if (isSingleCommandTask) evidence.push("single_command")
  if (isLocalTask) evidence.push("inspect")
  if (isPatchTask) evidence.push("patch")
  if (isVerifyTask) evidence.push("verify")
  if (isInspectPatchVerifyLoop) evidence.push("inspect_patch_verify")
  if (isPlan && localSignalCount >= 2 && !explicitHeavyScope) evidence.push("embedded_planning_language")
  if (hasContinuationSignal) evidence.push("continuation_context")
  if (explicitHeavyScope || hasAcrossScope) evidence.push("cross_file_scope")
  if (heavyDelivery) evidence.push("heavy_delivery")

  let topology = "open_ended"
  if (explicitHeavyScope || (heavyDelivery && heavySignalCount >= 2 && localSignalCount <= 2)) {
    topology = "heavy_multi_file_delivery"
  } else if (isInspectPatchVerifyLoop || (localSignalCount >= 3 && smallBoundedPathSet)) {
    topology = "bounded_local_transaction"
  } else if (hasContinuationSignal) {
    topology = "continued_local_transaction"
  } else if (isLocalTask || hasPathHint || isSingleCommandTask) {
    topology = "bounded_lookup"
  }

  const scores = { ask: 0, plan: 0, agent: 0, longagent: 0 }
  const reasons = {
    ask: "default_ask",
    plan: "planning_or_design_intent",
    agent: "default_agent",
    longagent: "default_longagent"
  }

  if (isQuestion) {
    evidence.push("question_intent")
    scores.ask += len < 120 ? 4 : 3
    reasons.ask = len < 80 ? "short_question" : "question_with_explain_intent"
  }
  if (isPureAsk) {
    evidence.push("pure_explanation_request")
    scores.ask += 3
    reasons.ask = "question_with_explain_intent"
  }

  if (isPlan) {
    evidence.push("planning_language")
    scores.plan += 4
  }

  if (isLongAgent) {
    evidence.push("heavy_scope_signal")
    scores.longagent += 6
    reasons.longagent = "multi_file_or_system_task"
  }
  if (heavyDelivery) {
    scores.longagent += explicitHeavyScope ? 2 : 3
    if (reasons.longagent === "default_longagent") reasons.longagent = "multi_file_or_system_task"
  }
  if (hasAcrossScope && heavyDelivery) {
    scores.longagent += 3
    reasons.longagent = "multi_file_or_system_task"
  }

  if (isLocalTask) {
    evidence.push("local_task_signal")
    scores.agent += 4
    reasons.agent = "local_transaction_task"
  }
  if (isAgentAction) {
    evidence.push("mutation_signal")
    scores.agent += 3
    if (reasons.agent === "default_agent") reasons.agent = "simple_action_task"
  }
  if (isVerifyTask) {
    scores.agent += 2
    if (reasons.agent === "default_agent") reasons.agent = "simple_action_task"
  }
  if (isInspectPatchVerifyLoop) {
    scores.agent += 2
    reasons.agent = "local_transaction_task"
  }
  if (hasContinuationSignal) {
    scores.agent += 3
    reasons.agent = "local_transaction_task"
  }
  if (isAgentAction && localSignalCount >= 2 && !explicitHeavyScope) {
    scores.agent += 3
    reasons.agent = "local_transaction_task"
  }
  if (hasPathHint || isSingleCommandTask) {
    evidence.push(hasPathHint ? "path_hint" : "single_command")
    scores.agent += 2
    if (reasons.agent === "default_agent") reasons.agent = "single_path_or_command_task"
  }
  if (isVerificationTask) {
    evidence.push("verification_signal")
  }
  if (isBoundedLocalTask) {
    evidence.push("bounded_local_scope")
    scores.agent += 2
  }
  if (isInspectPatchVerifyLoop) {
    evidence.push("inspect_patch_verify_loop")
    scores.agent += 2
    scores.longagent = Math.max(0, scores.longagent - 4)
    reasons.agent = "short_local_task_protected"
  }

  if (len > 500 && !isQuestion && !isLocalTask && !isAgentAction && !hasPathHint && !isSingleCommandTask) {
    evidence.push("long_prompt")
    scores.longagent += 2
    if (reasons.longagent === "default_longagent") reasons.longagent = "long_complex_prompt"
  }

  if ((len < 240 || isBoundedLocalTask) && (isLocalTask || isAgentAction || hasPathHint || isSingleCommandTask) && !isLongAgent) {
    scores.longagent = Math.max(0, scores.longagent - 3)
    if (reasons.agent === "local_transaction_task" || reasons.agent === "single_path_or_command_task") {
      reasons.agent = "short_local_task_protected"
    }
  }

  if (!isQuestion && len > 50) {
    scores.agent += 1
  }

  if (scores.plan >= 4 && scores.plan >= scores.longagent + 2 && scores.plan >= scores.agent + 1 && len < 240) {
    return {
      mode: "plan",
      confidence: scores.plan >= 5 ? "high" : "medium",
      reason: reasons.plan,
      evidence,
      topology,
      pathHints,
      continuity: hasContinuationSignal ? "continue_current_transaction" : "new_transaction"
    }
  }

  if (scores.longagent >= Math.max(scores.ask, scores.agent) + 2 && scores.longagent > 0) {
    return {
      mode: "longagent",
      confidence: scores.longagent >= 6 ? "high" : "medium",
      reason: reasons.longagent === "default_longagent" ? "long_complex_prompt" : reasons.longagent,
      evidence,
      topology,
      pathHints,
      continuity: hasContinuationSignal ? "continue_current_transaction" : "new_transaction"
    }
  }

  if (scores.agent >= scores.ask && scores.agent > 0) {
    return {
      mode: "agent",
      confidence: scores.agent >= 6 ? "high" : scores.agent >= 3 ? "medium" : "low",
      reason: reasons.agent,
      evidence,
      topology,
      pathHints,
      continuity: hasContinuationSignal ? "continue_current_transaction" : "new_transaction"
    }
  }

  return {
    mode: "ask",
    confidence: scores.ask >= 6 ? "high" : scores.ask >= 3 ? "medium" : "low",
    reason: reasons.ask,
    evidence,
    topology,
    pathHints,
    continuity: hasContinuationSignal ? "continue_current_transaction" : "new_transaction"
  }
}

// ========== Task 4: 前端任务检测与设计风格提示词 ==========

/**
 * 检测 prompt 是否涉及前端/UI 任务
 */
export function detectFrontendTask(prompt) {
  const lower = String(prompt || "").toLowerCase()
  const frontendPatterns = [
    /\b(react|vue|angular|svelte|next\.?js|nuxt|remix|astro|solid)\b/i,
    /\b(html|css|scss|sass|less|tailwind|bootstrap|styled.components|emotion|chakra)\b/i,
    /\b(ui|ux|frontend|front.end|web app|webpage|landing page|dashboard|component|widget)\b/i,
    /\b(button|form|modal|navbar|sidebar|layout|grid|flex|animation|transition|responsive)\b/i,
    /\b(前端|界面|页面|组件|样式|布局|动画|交互|响应式|移动端)\b/i
  ]
  return frontendPatterns.some(re => re.test(lower))
}

/**
 * 生成前端设计风格提示词块
 * @param {string} designStyle - 用户 profile 中的 design_style
 */
export function buildFrontendDesignPrompt(designStyle = "") {
  const lines = [
    "## Frontend Design Guidelines",
    "",
    "Apply these principles to all UI/frontend code:",
    "- Use semantic HTML5 elements (header, nav, main, section, article, footer)",
    "- Responsive design with mobile-first approach (breakpoints: 640/768/1024/1280px)",
    "- Accessibility: aria labels, keyboard navigation, color contrast ≥ 4.5:1",
    "- CSS custom properties for theming; prefer CSS Grid/Flexbox for layouts",
    "- Smooth transitions (150-300ms ease) for interactive elements",
    "- Consistent spacing scale (4px base unit: 4/8/12/16/24/32/48/64px)",
    "- Cross-browser compatibility (Chrome, Firefox, Safari, Edge)"
  ]

  if (designStyle) {
    const s = designStyle.toLowerCase()
    if (s.includes("minimal") || s.includes("clean")) {
      lines.push("- Style: Minimal/Clean — generous whitespace, 2-3 color palette, flat design, no decorative elements")
    } else if (s.includes("material")) {
      lines.push("- Style: Material Design — elevation shadows, ripple effects, Material color system, 8dp grid")
    } else if (s.includes("dark")) {
      lines.push("- Style: Dark theme — backgrounds #121212/#1e1e1e, surface #2d2d2d, ensure contrast ≥ 4.5:1")
    } else if (s.includes("glass") || s.includes("glassmorphism")) {
      lines.push("- Style: Glassmorphism — backdrop-filter blur(10-20px), semi-transparent bg (rgba white/black 0.1-0.2), subtle 1px border")
    } else if (s.includes("neumorphism") || s.includes("soft")) {
      lines.push("- Style: Neumorphism — soft inset/outset shadows, monochromatic palette, subtle depth without harsh borders")
    } else {
      lines.push(`- Style: ${designStyle} — apply consistently across all components`)
    }
  }

  return lines.join("\n")
}

// ========== Phase 11: 恢复建议生成 ==========

export function generateRecoverySuggestions({ status, taskProgress, gateStatus, phase, recoveryCount, fileChanges }) {
  const suggestions = []

  // 分析已完成和失败的 task
  const completedTasks = []
  const failedTasks = []
  if (taskProgress && typeof taskProgress === "object") {
    for (const [taskId, tp] of Object.entries(taskProgress)) {
      if (tp.status === "completed") {
        completedTasks.push(taskId)
      } else if (tp.status === "error" || tp.status === "cancelled") {
        const category = classifyError(tp.lastError)
        failedTasks.push({
          taskId,
          error: (tp.lastError || "").slice(0, 200),
          category,
          suggestion: category === "permanent"
            ? "此错误不可自动恢复，需要手动检查配置或文件路径"
            : category === "logic"
              ? "代码逻辑错误，建议检查相关文件的实现"
              : "临时性错误，可尝试重新运行"
        })
      }
    }
  }

  // 分析 gate 失败
  const manualSteps = []
  if (gateStatus) {
    for (const [gate, info] of Object.entries(gateStatus)) {
      if (info?.status === "fail" || info?.status === "fixing") {
        manualSteps.push(`检查 ${gate} gate 的失败原因: ${info.failures || info.reason || "unknown"}`)
      }
    }
  }

  // 根据 phase 判断失败阶段
  if (phase) {
    if (phase.startsWith("H4")) suggestions.push("编码阶段未完成，可尝试缩小任务范围后重试")
    if (phase.startsWith("H5")) suggestions.push("调试阶段未通过，建议手动检查测试输出")
    if (phase.startsWith("H6")) suggestions.push("门控检查未通过，建议手动运行 build/test/lint 命令")
    if (phase.startsWith("H7")) suggestions.push("Git 合并阶段出现问题，建议手动解决冲突")
  }

  const resumeHint = completedTasks.length > 0
    ? `已完成 ${completedTasks.length} 个 task，可从 checkpoint 恢复继续`
    : "无已完成的 task，建议重新开始"

  const summary = [
    `状态: ${status}`,
    `阶段: ${phase || "unknown"}`,
    `恢复次数: ${recoveryCount || 0}`,
    `已完成: ${completedTasks.length} task(s)`,
    `失败: ${failedTasks.length} task(s)`,
    `文件变更: ${fileChanges?.length || 0}`
  ].join(", ")

  return {
    suggestions,
    completedTasks,
    failedTasks,
    manualSteps,
    resumeHint,
    summary
  }
}
