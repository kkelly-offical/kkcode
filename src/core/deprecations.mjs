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

// 旧别名的移除目标。曾写 0.5.0，但三套别名一路活到了 0.9.x —— 提示语里
// 承诺一个已经过去的版本比不承诺更糟。现锚定到 1.0.0：大版本才允许破坏兼容。
const REMOVAL_VERSION = "1.0.0"

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

/**
 * 模块级默认实例的兼容别名（1.0.0 阶段 2b，M3 §四.2 单例收编）。
 *
 * 被收编的单例仍按原名字导出同一个默认实例 —— 旧 import 路径行为不变；
 * 差别只在每次方法调用会经 noteDeprecation 记一笔（每 key 每进程只出一条），
 * 用来盘点仍停留在模块级路径上的调用点。别名本身长期保留（§7.2 回退策略），
 * 移除目标锚定 1.x 而非 1.0.0。
 *
 * @template {object} T
 * @param {string} key 弃用 key（每进程只提示一次）
 * @param {string} message 提示语
 * @param {T} instance 默认实例
 * @param {{ removal?: string }} [options]
 * @returns {T} 与默认实例同型的代理
 */
export function deprecatedSingletonAlias(key, message, instance, { removal = "1.x" } = {}) {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      return function aliasedSingletonMethod(...args) {
        noteDeprecation(key, message, { removal })
        return Reflect.apply(value, target, args)
      }
    }
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
