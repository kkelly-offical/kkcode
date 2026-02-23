/**
 * Task Bus — 并行 task 间的轻量通信机制
 * task 可以发布消息（接口变更、共享数据），其他 task 通过 priorContext 读取
 */

export class TaskBus {
  constructor() {
    this._messages = []
    this._shared = {}
  }

  publish(taskId, key, value) {
    this._messages.push({ taskId, key, value, ts: Date.now() })
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

  parseTaskOutput(taskId, text) {
    const pattern = /\[TASK_BROADCAST:\s*(\w+)\s*=\s*(.*?)\]/g
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
