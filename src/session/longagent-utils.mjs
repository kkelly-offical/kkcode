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
  try { return JSON.parse(raw) } catch { /* ignore */ }
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch { /* ignore */ }
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
  // 前后半段完全相同
  const allReadOnly = recentToolCalls.every(sig => isReadOnlyTool(sig.split(":")[0]))
  if (allReadOnly) {
    const half = Math.floor(recentToolCalls.length / 2)
    if (half >= 3) {
      const first = recentToolCalls.slice(0, half).sort().join(",")
      const second = recentToolCalls.slice(half).sort().join(",")
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

/**
 * 分析 prompt，判断最适合的执行模式
 * @returns {{ mode: 'ask'|'agent'|'longagent', confidence: 'high'|'medium'|'low', reason: string }}
 */
export function classifyTaskMode(prompt) {
  const text = String(prompt || "").trim()
  if (!text) return { mode: "ask", confidence: "high", reason: "empty_input" }
  const lower = text.toLowerCase()
  const len = text.length

  // --- 问答类信号 → ask ---
  const questionPatterns = [
    /^(what|how|why|when|where|who|which|explain|tell me|describe|show me)\b/i,
    /^(什么|为什么|怎么|如何|哪里|哪个|谁|能否|请解释|告诉我|描述|是什么|有什么|怎样)/,
    /[？?]\s*$/
  ]
  const pureAskKeywords = [
    "explain", "what is", "what are", "how does", "why does", "describe", "tell me about",
    "解释", "是什么", "为什么", "怎么理解", "什么意思", "有什么区别", "如何理解"
  ]
  const isQuestion = questionPatterns.some(re => re.test(text))
  const isPureAsk = pureAskKeywords.some(kw => lower.includes(kw))

  if (isQuestion && isPureAsk) {
    return { mode: "ask", confidence: "high", reason: "question_with_explain_intent" }
  }
  if (isQuestion && len < 80) {
    return { mode: "ask", confidence: "medium", reason: "short_question" }
  }

  // --- 规划类信号 → plan ---
  const planPatterns = [
    /\b(plan|design|architect|outline|blueprint|draft|propose|sketch)\b/i,
    /\b(规划|设计|架构|方案|蓝图|草案|提案|计划一下|帮我想想)\b/i
  ]
  const isPlan = planPatterns.some(re => re.test(lower))
  if (isPlan && !isLongAgent && len < 200) {
    return { mode: "plan", confidence: "medium", reason: "planning_or_design_intent" }
  }

  // --- 大型/多文件任务信号 → longagent ---
  const longagentPatterns = [
    /\b(multiple files?|across files?|entire (codebase|project|repo)|all files?|跨文件|多个文件|整个项目|全量)\b/i,
    /\b(refactor|migrate|rewrite|overhaul|redesign|重构|迁移|重写|改造|全面重)\b/i,
    /\b(implement|build|create|develop|add).{0,40}(system|module|service|feature|component|framework|pipeline|架构|系统|模块|服务|功能|组件|框架|流水线)\b/i,
    /\b(full|complete|comprehensive|end.to.end|完整实现|完全|端到端)\b/i,
    /\b(multi.?stage|multi.?step|多阶段|多步骤|分阶段)\b/i
  ]
  const isLongAgent = longagentPatterns.some(re => re.test(lower))

  if (isLongAgent) {
    return { mode: "longagent", confidence: "high", reason: "multi_file_or_system_task" }
  }
  // 长文本通常是复杂任务
  if (len > 400 && !isQuestion) {
    return { mode: "longagent", confidence: "medium", reason: "long_complex_prompt" }
  }

  // --- 简单单文件任务信号 → agent ---
  const agentPatterns = [
    /\b(fix|debug|patch|update|change|modify|rename|delete|remove|add|insert|append)\b/i,
    /\b(修复|调试|修改|更新|删除|添加|插入|改一下|帮我改|帮我加)\b/i,
    /\b(run|execute|test|check|verify|运行|执行|测试|检查|验证)\b/i
  ]
  const isAgent = agentPatterns.some(re => re.test(lower))

  if (isAgent && len < 250) {
    return { mode: "agent", confidence: "medium", reason: "simple_action_task" }
  }
  if (len > 50 && !isQuestion) {
    return { mode: "agent", confidence: "low", reason: "default_agent" }
  }

  return { mode: "ask", confidence: "low", reason: "default_ask" }
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
