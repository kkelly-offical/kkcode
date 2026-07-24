import { APPROVAL_LEVELS, DEFAULT_APPROVAL, approvalFromLegacy } from "../core/modes.mjs"

/**
 * 审批弹窗的选项。「Always Allow」把授权写入用户级配置的
 * permission.rules[]，重启后依然有效；「Allow Session」只活在内存。
 */
export const PERMISSION_PROMPT_CHOICES = [
  { label: "Allow Once", value: "allow_once" },
  { label: "Allow Session", value: "allow_session" },
  { label: "Always Allow", value: "allow_always" },
  { label: "Deny", value: "deny" }
]

export const PERMISSION_PROMPT_VALUES = PERMISSION_PROMPT_CHOICES.map((choice) => choice.value)

export function defaultPermissionChoiceIndex(defaultAction) {
  const index = PERMISSION_PROMPT_VALUES.indexOf(
    defaultAction === "allow" ? "allow_once" : String(defaultAction || "")
  )
  return index >= 0 ? index : PERMISSION_PROMPT_VALUES.indexOf("deny")
}

export const POLICY_CHOICES = [
  { label: "Readonly", value: "readonly", desc: "只读检查，不执行任何修改" },
  { label: "Manual", value: "manual", desc: "只读与白名单命令自动放行，编辑前确认" },
  { label: "Accept Edits", value: "accept-edits", desc: "自动接受编辑与子任务，危险命令仍确认" },
  { label: "YOLO", value: "yolo", desc: "跳过全部审批" },
  { label: "Session Clear", value: "session-clear", desc: "清除本会话已授权的缓存" }
]

export const PERMISSION_LEVEL_CYCLE = APPROVAL_LEVELS

function currentPermissionValue(permissionConfigOrValue = DEFAULT_APPROVAL) {
  if (typeof permissionConfigOrValue === "string") {
    return approvalFromLegacy(permissionConfigOrValue) || DEFAULT_APPROVAL
  }
  const config = permissionConfigOrValue || {}
  if (config.level) return approvalFromLegacy(config.level) || DEFAULT_APPROVAL
  if (config.mode === "yolo") return "yolo"
  if (config.mode === "auto") return "manual"
  if (config.default_policy === "allow") return "accept-edits"
  if (config.default_policy === "deny") return "readonly"
  return DEFAULT_APPROVAL
}

export function createPolicyPickerState(current = DEFAULT_APPROVAL) {
  const value = currentPermissionValue(current)
  const idx = POLICY_CHOICES.findIndex((choice) => choice.value === value)
  return { selected: Math.max(0, idx) }
}

export function applyPolicyChoice(choice, { permissionConfig = {}, sessionId, clearSession } = {}) {
  if (!choice) return { message: null, permissionConfig }
  if (choice.value === "session-clear") {
    clearSession?.(sessionId)
    return {
      message: "permission session cache cleared",
      permissionConfig
    }
  }

  if (PERMISSION_LEVEL_CYCLE.includes(choice.value)) {
    return {
      message: `permission level → ${choice.value}`,
      permissionConfig: applyPermissionLevel(choice.value, permissionConfig)
    }
  }

  return {
    message: null,
    permissionConfig
  }
}

export function nextPermissionLevel(permissionConfigOrValue = DEFAULT_APPROVAL, order = PERMISSION_LEVEL_CYCLE) {
  const current = currentPermissionValue(permissionConfigOrValue)
  const idx = order.indexOf(current)
  return order[idx >= 0 ? (idx + 1) % order.length : 0]
}

/**
 * 写回审批档。0.3.x 会同时写 `mode` 字段，0.4.0 起 `level` 是唯一真源，
 * 因此这里顺带清掉旧的 `mode` / `default_policy`，避免两套词汇再次分叉。
 */
export function applyPermissionLevel(level, permissionConfig = {}) {
  const value = approvalFromLegacy(level) || DEFAULT_APPROVAL
  const next = { ...permissionConfig, level: value }
  delete next.mode
  delete next.default_policy
  return next
}
