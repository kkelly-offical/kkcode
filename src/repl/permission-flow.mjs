export const POLICY_CHOICES = [
  { label: "Readonly", value: "readonly", desc: "read, search, and inspect only" },
  { label: "Review", value: "review", desc: "read plus safe checks; no edits" },
  { label: "Auto", value: "auto", desc: "auto-approve safe tools, review risky tools" },
  { label: "Edit", value: "edit", desc: "allow normal edits; review sensitive actions" },
  { label: "Full Auto", value: "full-auto", desc: "autonomous local edits and checks with danger guards" },
  { label: "YOLO", value: "yolo", desc: "allow permission checks without prompts" },
  { label: "Session Clear", value: "session-clear", desc: "clear cached grants" }
]

export const PERMISSION_LEVEL_CYCLE = ["readonly", "review", "auto", "edit", "full-auto", "yolo"]

function currentPermissionValue(permissionConfigOrValue = "auto") {
  if (typeof permissionConfigOrValue === "string") return permissionConfigOrValue
  if (permissionConfigOrValue.level) return permissionConfigOrValue.level
  if (permissionConfigOrValue.mode === "yolo") return "yolo"
  if (permissionConfigOrValue.mode === "auto") return "auto"
  if (permissionConfigOrValue.default_policy === "allow") return "full-auto"
  if (permissionConfigOrValue.default_policy === "deny") return "readonly"
  return "auto"
}

export function createPolicyPickerState(current = "auto") {
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
      permissionConfig: {
        ...permissionConfig,
        level: choice.value,
        mode: choice.value === "yolo" ? "yolo" : "auto"
      }
    }
  }

  return {
    message: null,
    permissionConfig
  }
}

export function nextPermissionLevel(permissionConfigOrValue = "auto", order = PERMISSION_LEVEL_CYCLE) {
  const current = currentPermissionValue(permissionConfigOrValue)
  const idx = order.indexOf(current)
  return order[idx >= 0 ? (idx + 1) % order.length : 0]
}

export function applyPermissionLevel(level, permissionConfig = {}) {
  const value = PERMISSION_LEVEL_CYCLE.includes(level) ? level : "auto"
  return {
    ...permissionConfig,
    level: value,
    mode: value === "yolo" ? "yolo" : "auto"
  }
}
