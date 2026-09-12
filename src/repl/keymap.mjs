/**
 * 键位相关的模式循环。0.4.0 起模式表的唯一真源是 src/kernel/core/modes.mjs，
 * 这里只做 re-export 以保持既有调用点不变（经 kernel facade 白名单取用，
 * 架构 §4.2.1）。
 */
export { MODE_IDS as MODE_CYCLE_ORDER, MODE_CYCLE, nextModeId, prevModeId } from "../kernel/index.mjs"

import { MODE_IDS, nextModeId } from "../kernel/index.mjs"

/** 兼容 0.3.x 的调用签名：nextMode(current, order?) */
export function nextMode(currentMode, order = MODE_IDS) {
  if (order === MODE_IDS) return nextModeId(currentMode)
  const idx = order.indexOf(currentMode)
  const nextIdx = idx >= 0 ? (idx + 1) % order.length : 0
  return order[nextIdx]
}
