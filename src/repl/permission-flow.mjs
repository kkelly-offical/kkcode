export const POLICY_CHOICES = [
  { label: "Auto", value: "auto", desc: "auto-approve safe reads, review risky tools" },
  { label: "YOLO", value: "yolo", desc: "allow permission checks without prompts" },
  { label: "Ask", value: "ask", desc: "prompt before each tool call" },
  { label: "Allow", value: "allow", desc: "legacy allow all tool calls" },
  { label: "Deny", value: "deny", desc: "deny all tool calls" },
  { label: "Session Clear", value: "session-clear", desc: "clear cached grants" }
]

function currentPermissionValue(permissionConfigOrValue = "auto") {
  if (typeof permissionConfigOrValue === "string") return permissionConfigOrValue
  return permissionConfigOrValue.mode || permissionConfigOrValue.default_policy || "auto"
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

  if (["auto", "yolo"].includes(choice.value)) {
    return {
      message: `permission mode → ${choice.value}`,
      permissionConfig: {
        ...permissionConfig,
        mode: choice.value
      }
    }
  }

  return {
    message: `permission policy → ${choice.value}`,
    permissionConfig: {
      ...permissionConfig,
      mode: "manual",
      default_policy: choice.value
    }
  }
}
