/**
 * Task Bus — 并行 task 间的轻量通信机制
 * task 可以发布消息（接口变更、共享数据），其他 task 通过 priorContext 读取
 *
 * Phase 3 增强:
 * - 索引替代时间戳，修复 toDeltaString 竞态
 * - topic 分类支持，按类别查询
 * - parseTaskOutput 支持结构化 JSON 值
 */

export class TaskBus {
  constructor({ maxMessages = 500 } = {}) {
    this._messages = []
    this._shared = {}
    this._maxMessages = maxMessages
    this._lastFlushedIdx = 0
  }

  publish(taskId, key, value, topic = null) {
    this._messages.push({ taskId, key, value, topic, ts: Date.now() })
    // Evict oldest messages when exceeding capacity
    if (this._messages.length > this._maxMessages) {
      const keep = Math.round(this._maxMessages * 0.8)
      const removed = this._messages.length - keep
      this._messages = this._messages.slice(-keep)
      // 调整索引偏移，防止 delta 丢失
      this._lastFlushedIdx = Math.max(0, this._lastFlushedIdx - removed)
    }
    this._shared[key] = { value, from: taskId, topic, ts: Date.now() }
  }

  get(key) {
    return this._shared[key]?.value ?? null
  }

  getByTopic(topic) {
    const result = {}
    for (const [key, entry] of Object.entries(this._shared)) {
      if (entry.topic === topic) result[key] = entry.value
    }
    return result
  }

  snapshot() {
    return { ...this._shared }
  }

  hasPendingMessages() {
    return this._lastFlushedIdx < this._messages.length
  }

  toContextString(maxLen = 2000) {
    const entries = Object.entries(this._shared)
    if (!entries.length) return ""
    const lines = ["### Task Bus (shared context)"]
    for (const [key, { value, from }] of entries) {
      const val = typeof value === "string" ? value : JSON.stringify(value)
      lines.push(`- [${from}] ${key}: ${val.slice(0, 200)}`)
    }
    const result = lines.join("\n")
    return result.length > maxLen ? result.slice(0, maxLen) + "\n..." : result
  }

  toDeltaString(maxLen = 2000) {
    // 用索引替代时间戳，避免竞态丢消息
    const startIdx = this._lastFlushedIdx
    this._lastFlushedIdx = this._messages.length
    if (startIdx >= this._messages.length) return ""
    const newMessages = this._messages.slice(startIdx)
    if (!newMessages.length) return ""
    const lines = ["### Task Bus (new since last stage)"]
    for (const { taskId, key, value } of newMessages) {
      const val = typeof value === "string" ? value : JSON.stringify(value)
      lines.push(`- [${taskId}] ${key}: ${val.slice(0, 200)}`)
    }
    const result = lines.join("\n")
    return result.length > maxLen ? result.slice(0, maxLen) + "\n..." : result
  }

  parseTaskOutput(taskId, text) {
    const marker = "[TASK_BROADCAST:"
    let pos = 0
    while ((pos = text.indexOf(marker, pos)) !== -1) {
      const start = pos + marker.length
      // 提取 key（支持 key@topic 语法）
      const eqIdx = text.indexOf("=", start)
      if (eqIdx === -1) { pos = start; continue }
      const rawKey = text.slice(start, eqIdx).trim()
      if (!rawKey) { pos = start; continue }

      // 提取 value — 处理嵌套括号
      let valStart = eqIdx + 1
      while (valStart < text.length && text[valStart] === " ") valStart++
      let valEnd = -1
      const ch = text[valStart]
      if (ch === "{" || ch === "[") {
        // 平衡括号扫描
        let depth = 0
        for (let i = valStart; i < text.length; i++) {
          if (text[i] === "{" || text[i] === "[") depth++
          else if (text[i] === "}" || text[i] === "]") {
            depth--
            if (depth === 0) { valEnd = i + 1; break }
          }
        }
        if (valEnd === -1) { pos = start; continue }
      } else {
        // 简单值 — 找到下一个 ]
        valEnd = text.indexOf("]", valStart)
        if (valEnd === -1) { pos = start; continue }
      }

      const raw = text.slice(valStart, valEnd).trim()
      // 跳过闭合的 ]
      pos = valEnd + 1

      // 解析值
      let value = raw
      if (raw.startsWith("{") || raw.startsWith("[")) {
        try { value = JSON.parse(raw) } catch { /* 保持字符串 */ }
      }

      // 解析 key@topic
      const topicMatch = rawKey.match(/^(\w+)@(\w+)$/)
      if (topicMatch) {
        this.publish(taskId, topicMatch[1], value, topicMatch[2])
      } else {
        this.publish(taskId, rawKey, value)
      }
    }
  }

  clear() {
    this._messages = []
    this._shared = {}
    this._lastFlushedIdx = 0
  }
}
