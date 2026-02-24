/**
 * LongAgent 共享工具函数
 * 被 longagent.mjs、longagent-hybrid.mjs 共同使用
 */

export const LONGAGENT_FILE_CHANGES_LIMIT = 400

export function isComplete(text) {
  const lower = String(text || "").toLowerCase()
  if (lower.includes("[task_complete]")) return true
  if (lower.includes("task complete")) return true
  if (lower.includes("completed successfully")) return true
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
export function createStuckTracker(maxRecent = 10) {
  const recentToolCalls = []
  let consecutiveReadOnlyCount = 0

  return {
    /** 记录本轮 tool events，返回 { isStuck, reason } */
    track(toolEvents = []) {
      const sigs = toolEvents.map(e => `${e.name}:${JSON.stringify(e.args || {})}`)
      recentToolCalls.push(...sigs)
      while (recentToolCalls.length > maxRecent) recentToolCalls.shift()

      const allReadOnly = toolEvents.length > 0 && toolEvents.every(e => isReadOnlyTool(e.name))
      if (allReadOnly) consecutiveReadOnlyCount++
      else consecutiveReadOnlyCount = 0

      const loop = detectExplorationLoop(recentToolCalls)
      if (loop.isLoop) return { isStuck: true, reason: loop.reason }
      if (detectToolCycle(recentToolCalls)) return { isStuck: true, reason: "tool_cycle_detected" }
      if (consecutiveReadOnlyCount >= 4) return { isStuck: true, reason: "excessive_read_only_exploration" }
      return { isStuck: false, reason: null }
    },
    /** 重置连续只读计数（警告注入后调用） */
    resetReadOnlyCount() { consecutiveReadOnlyCount = 0 },
    get consecutiveReadOnly() { return consecutiveReadOnlyCount }
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
  return merged.length <= maxEntries ? merged : merged.slice(merged.length - maxEntries)
}
