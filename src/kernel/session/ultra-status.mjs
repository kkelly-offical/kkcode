import { GOAL_MET, GOAL_BLOCKED_MANUAL } from "./goal-verifier.mjs"

/**
 * Ultra 的诚实终局状态。
 *
 * 0.4.x 的 resolveHybridCompletionStatus 只看两个布尔（门禁过没过、模型有没有
 * 说 [TASK_COMPLETE]），停止 / 超时 / 预算耗尽 / stage 放弃在顶层状态上与正常
 * 完成**无法区分**。这里的第一原则：**completionMarker 只是模型的自我声明，
 * 不是证据，它单独永远不产生 completed** —— completed 只能来自验收判据。
 */

export const ULTRA_STATUS = Object.freeze({
  COMPLETED: "completed",             // 全部 blocking 判据 pass
  PARTIAL: "partial",                 // 有实质产出，但部分判据未达成 / 用户选择交付
  BLOCKED: "blocked",                 // 停滞或立即受阻 —— 报告说明卡在哪
  BLOCKED_MANUAL: "blocked_manual",   // 只差人工判据待确认
  USER_STOPPED: "user_stopped",
  BUDGET_EXHAUSTED: "budget_exhausted",
  DEADLINE_EXHAUSTED: "deadline_exhausted",
  PLAN_REJECTED: "plan_rejected",     // 用户在 H0/H2 中止
  NEEDS_OBJECTIVE: "needs_objective", // 目标不可执行（原 "blocked" —— 与受阻语义撞词，改名）
  FATAL: "fatal"                      // 内部错误。唯一配得上 session=failed 的状态
})

/**
 * @param {object} p
 * @param {object} p.verification  verifyGoal 的结果（可为 null —— goal_mode 关闭时）
 * @returns {string} ULTRA_STATUS 之一
 */
export function resolveUltraStatus({
  fatalError = null,
  stopped = false,
  userDecision = "",           // "" | "stop" | "deliver_partial"
  exhausted = "",              // "" | "budget" | "iterations" | "deadline"
  verification = null,
  usabilityGatesPassed = false,
  completionMarkerSeen = false,
  hadOutput = false            // 有没有实质产出（文件变更 / 完成的任务）
} = {}) {
  if (fatalError) return ULTRA_STATUS.FATAL
  if (stopped || userDecision === "stop") return ULTRA_STATUS.USER_STOPPED
  if (exhausted === "budget" || exhausted === "iterations") return ULTRA_STATUS.BUDGET_EXHAUSTED
  if (exhausted === "deadline") return ULTRA_STATUS.DEADLINE_EXHAUSTED

  if (verification) {
    if (verification.status === GOAL_MET && usabilityGatesPassed) return ULTRA_STATUS.COMPLETED
    if (verification.status === GOAL_BLOCKED_MANUAL) return ULTRA_STATUS.BLOCKED_MANUAL
    // 「交付已完成部分」的前提是**有**已完成的部分 —— 零达成时仍是 blocked，
    // 否则 CI 里一次彻底停滞的运行会以退出码 0 静默通过
    if (userDecision === "deliver_partial") {
      return verification.passed > 0 ? ULTRA_STATUS.PARTIAL : ULTRA_STATUS.BLOCKED
    }
    if (verification.passed > 0 && hadOutput) return ULTRA_STATUS.PARTIAL
    // 纯 unknown（如没有任何可执行判据）时，完成标记最多把 blocked 抬到 partial
    if (verification.status === "unknown" && completionMarkerSeen && hadOutput) return ULTRA_STATUS.PARTIAL
    return ULTRA_STATUS.BLOCKED
  }

  // goal_mode 关闭（0.4.x 语义）：沿用旧的二值判定，但名字诚实一点
  if (!usabilityGatesPassed) return ULTRA_STATUS.BLOCKED
  return completionMarkerSeen ? ULTRA_STATUS.COMPLETED : ULTRA_STATUS.PARTIAL
}

/** CLI 退出码。0 = 交付了东西；非 0 = 需要用户注意。 */
export function exitCodeForUltraStatus(status) {
  switch (status) {
    case ULTRA_STATUS.COMPLETED:
    case ULTRA_STATUS.PARTIAL:
    case ULTRA_STATUS.USER_STOPPED:
    case ULTRA_STATUS.PLAN_REJECTED:
      return 0
    case ULTRA_STATUS.BLOCKED:
    case ULTRA_STATUS.NEEDS_OBJECTIVE:
      return 2
    case ULTRA_STATUS.BLOCKED_MANUAL:
      return 3
    case ULTRA_STATUS.BUDGET_EXHAUSTED:
    case ULTRA_STATUS.DEADLINE_EXHAUSTED:
      return 4
    case ULTRA_STATUS.FATAL:
    default:
      return 1
  }
}

/**
 * 映射到会话存储状态。**failed 只留给 fatal** —— 0.4.x 门禁没过就标 failed，
 * 会话恢复路径会以为会话坏了，而实际上工作还在，只是没达标。
 */
export function sessionStatusForUltraStatus(status) {
  switch (status) {
    case ULTRA_STATUS.COMPLETED: return "completed"
    case ULTRA_STATUS.FATAL: return "failed"
    default: return "active"
  }
}
