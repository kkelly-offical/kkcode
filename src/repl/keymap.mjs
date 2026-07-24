/**
 * 键位相关的模式循环。0.4.0 起模式表的唯一真源是 src/core/modes.mjs，
 * 这里只做 re-export 以保持既有调用点不变。
 */
export { MODE_IDS as MODE_CYCLE_ORDER, MODE_CYCLE, nextModeId, prevModeId } from "../core/modes.mjs"

import { MODE_IDS, nextModeId } from "../core/modes.mjs"

/** 兼容 0.3.x 的调用签名：nextMode(current, order?) */
export function nextMode(currentMode, order = MODE_IDS) {
  if (order === MODE_IDS) return nextModeId(currentMode)
  const idx = order.indexOf(currentMode)
  const nextIdx = idx >= 0 ? (idx + 1) % order.length : 0
  return order[nextIdx]
}
