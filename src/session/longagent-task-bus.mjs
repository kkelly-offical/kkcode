/**
 * Task Bus — 并行 task 间的轻量通信机制
 * task 可以发布消息（接口变更、共享数据），其他 task 通过 priorContext 读取
 */

export class TaskBus {
  constructor({ maxMessages = 500 } = {}) {
    this._messages = []
    this._shared = {}
    this._maxMessages = maxMessages
    this._lastFlushedTs = 0
  }

  publish(taskId, key, value) {
    this._messages.push({ taskId, key, value, ts: Date.now() })
    // Evict oldest messages when exceeding capacity
    if (this._messages.length > this._maxMessages) {
      this._messages = this._messages.slice(-Math.round(this._maxMessages * 0.8))
    }
    this._shared[key] = { value, from: taskId, ts: Date.now() }
  }

  get(key) {
    return this._shared[key]?.value ?? null
  }

  snapshot() {
    return { ...this._shared }
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
    const cutoff = this._lastFlushedTs
    const newMessages = this._messages.filter(m => m.ts > cutoff)
    this._lastFlushedTs = Date.now()
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
    const pattern = /\[TASK_BROADCAST:\s*(\w+)\s*=\s*([\s\S]*?)\]/g
    let match
    while ((match = pattern.exec(text)) !== null) {
      this.publish(taskId, match[1], match[2].trim())
    }
  }

  clear() {
    this._messages = []
    this._shared = {}
  }
}
