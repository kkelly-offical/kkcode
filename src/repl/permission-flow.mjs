export const POLICY_CHOICES = [
  { label: "Ask", value: "ask", desc: "prompt before each tool call" },
  { label: "Allow", value: "allow", desc: "allow all tool calls" },
  { label: "Deny", value: "deny", desc: "deny all tool calls" },
  { label: "Session Clear", value: "session-clear", desc: "clear cached grants" }
]

export function createPolicyPickerState(current = "ask") {
  const idx = POLICY_CHOICES.findIndex((choice) => choice.value === current)
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

  return {
    message: `permission policy → ${choice.value}`,
    permissionConfig: {
      ...permissionConfig,
      default_policy: choice.value
    }
  }
}
