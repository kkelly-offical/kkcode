import {
  MODE_CYCLE,
  MODE_IDS,
  DEFAULT_MODE_ID,
  getMode,
  laneOf,
  approvalOf,
  nextModeId,
  modeIdFromLegacy,
  modeIdFromLaneAndApproval
} from "../core/modes.mjs"
import { applyPermissionLevel } from "./permission-flow.mjs"

/**
 * 模式切换的纯函数层。
 *
 * 5 档扁平循环同时决定执行航道与审批档，因此每次切换都要写两处：
 * state.modeId（唯一真值）与 config.permission.level（判定链读的）。
 * state.mode 仍是 0.3.x 的航道值，供 executeTurn 等既有消费者使用。
 */

export const MODE_PICKER_CHOICES = MODE_CYCLE.map((mode) => ({
  label: `${mode.icon} ${mode.label}`,
  value: mode.id,
  desc: mode.hint
}))

/** 由任意新旧写法解析出模式 id，无法识别时回落到默认档。 */
export function resolveModeId(input, fallback = DEFAULT_MODE_ID) {
  return modeIdFromLegacy(input) || fallback
}

/**
 * 计算一次模式切换的结果。不改动入参。
 * @returns {{modeId, mode, approval, permissionConfig, label, icon, hint}}
 */
export function applyModeSelection(modeId, { permissionConfig = {} } = {}) {
  const id = resolveModeId(modeId)
  const mode = getMode(id)
  return {
    modeId: id,
    mode: laneOf(id),
    approval: approvalOf(id),
    permissionConfig: applyPermissionLevel(approvalOf(id), permissionConfig),
    label: mode.label,
    icon: mode.icon,
    hint: mode.hint
  }
}

export function cycleModeSelection(currentModeId, { permissionConfig = {} } = {}) {
  return applyModeSelection(nextModeId(resolveModeId(currentModeId)), { permissionConfig })
}

export function createModePickerState(currentModeId = DEFAULT_MODE_ID) {
  const index = MODE_IDS.indexOf(resolveModeId(currentModeId))
  return { selected: Math.max(0, index) }
}

/** 状态栏与 toast 的统一措辞。 */
export function formatModeBadge(modeId) {
  const mode = getMode(resolveModeId(modeId))
  return `${mode.icon} ${mode.label}`
}

/**
 * 恢复历史会话时，session 只存了航道与审批档，据此重建模式 id。
 */
export function restoreModeId({ mode, permissionConfig = {} } = {}) {
  return modeIdFromLaneAndApproval(mode, permissionConfig.level)
}
