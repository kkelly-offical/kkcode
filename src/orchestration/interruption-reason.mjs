export const INTERRUPTION_REASONS = Object.freeze({
  USER_CANCEL: "user_cancel",
  INTERRUPT: "interrupt",
  TIMEOUT: "timeout",
  PERMISSION_CANCEL: "permission_cancel",
  ORPHANED: "orphaned",
  REMOTE_CANCEL: "remote_cancel"
})

export function normalizeInterruptionReason(input, fallback = INTERRUPTION_REASONS.INTERRUPT) {
  const text = String(input || "").trim().toLowerCase()
  if (!text) return fallback
  if (text.includes("remote cancel")) return INTERRUPTION_REASONS.REMOTE_CANCEL
  if (text.includes("permission") && (text.includes("cancel") || text.includes("denied"))) return INTERRUPTION_REASONS.PERMISSION_CANCEL
  if (text.includes("orphan") || text.includes("parent process exited")) return INTERRUPTION_REASONS.ORPHANED
  if (text.includes("timeout")) return INTERRUPTION_REASONS.TIMEOUT
  if (text.includes("cancelled by user") || text.includes("canceled by user") || text.includes("user cancelled") || text.includes("user canceled")) {
    return INTERRUPTION_REASONS.USER_CANCEL
  }
  return fallback
}
