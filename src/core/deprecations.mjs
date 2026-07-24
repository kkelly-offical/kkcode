/**
 * 0.4.0 兼容层的一次性弃用提示。
 *
 * 旧模式名、旧权限等级、旧配置键在 0.4.0 仍然可用并自动映射，但每个
 * 弃用点在一个进程生命周期内只提示一次。提示的产生点大多是同步纯函数
 * （normalizePermissionLevel、resolveMode 等），因此这里刻意保持同步、
 * 不依赖 EventBus，避免在纯函数里引入异步副作用与模块循环依赖。
 *
 * 消费方式：
 *   - TUI  订阅 onDeprecation() 转成底部 toast
 *   - CLI  在命令收尾处 drainDeprecations() 写 stderr
 */

const REMOVAL_VERSION = "0.5.0"

const seen = new Set()
const listeners = new Set()
let pending = []

/**
 * 记录一次弃用命中。同一 key 只会生效一次。
 * @returns {boolean} 本次是否是首次命中（首次才产生提示）
 */
export function noteDeprecation(key, message, { detail = "", removal = REMOVAL_VERSION } = {}) {
  const id = String(key || "").trim()
  if (!id || seen.has(id)) return false
  seen.add(id)

  const notice = {
    key: id,
    message: String(message || id),
    detail: String(detail || ""),
    removal,
    at: Date.now()
  }
  pending.push(notice)
  for (const fn of listeners) {
    try { fn(notice) } catch (err) {
      console.error("[deprecations] listener error:", err?.message || err)
    }
  }
  return true
}

/** 便捷封装：`旧写法` 已更名为 `新写法`。 */
export function noteRenamed(key, { from, to, kind = "配置项" }) {
  return noteDeprecation(key, `${kind} \`${from}\` 已更名为 \`${to}\``, {
    detail: `旧写法在 ${REMOVAL_VERSION} 移除`
  })
}

export function onDeprecation(fn) {
  if (typeof fn !== "function") return () => {}
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 取出全部未消费的提示并清空。 */
export function drainDeprecations() {
  const out = pending
  pending = []
  return out
}

/** 只读查看已产生的提示，不清空。 */
export function listDeprecations() {
  return [...pending]
}

export function formatDeprecation(notice) {
  const detail = notice?.detail ? `（${notice.detail}）` : ""
  return `${notice?.message || ""}${detail}`
}

/** 仅供测试重置进程级状态。 */
export function resetDeprecations() {
  seen.clear()
  pending = []
  listeners.clear()
}
