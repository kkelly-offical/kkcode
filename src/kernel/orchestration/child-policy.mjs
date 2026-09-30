// One vocabulary at the planning AND execution boundary. A scope accepted as
// read-only by the scheduler must never become writable in a child loop.
export function isReadOnlyWriteScope(value) {
  const scope = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ')
  return /^(none|readonly|read only|no mutations?|no writes?)(?:\s|$)/.test(scope)
}

const LEVELS = ['readonly', 'manual', 'accept-edits', 'yolo']
function level(value, fallback = 'manual') {
  if (value === 'none') return 'readonly'
  if (value === 'default') return 'manual'
  return LEVELS.includes(value) ? value : fallback
}
const minLimit = (a, b) => a == null ? b ?? null : b == null ? a : Math.min(a, b)

/** @param {{role: any, parentAgent?: any, parentRunSpec?: any, permission?: any, writeScope?: any, limits?: {budgetUsd?: number, deadlineAt?: number}}} input */
export function inheritChildPolicy({ role, parentAgent, parentRunSpec, permission, writeScope, limits = {} }) {
  const inheritedRole = parentRunSpec?.role || parentAgent || {}
  const parentLevel = level(permission?.level)
  const roleLevel = level(role.permission, parentLevel)
  const inheritedLevel = level(inheritedRole.permission, parentLevel)
  const parentScope = parentRunSpec?.workspace?.writeScope
  const readOnly = isReadOnlyWriteScope(parentScope) || isReadOnlyWriteScope(writeScope)
  if (parentScope && !isReadOnlyWriteScope(parentScope) && writeScope && writeScope !== parentScope && !readOnly) {
    throw new Error('child write_scope cannot replace its parent scope')
  }
  const parentTools = inheritedRole.tools
  const tools = Array.isArray(parentTools)
    ? parentTools.filter(name => !Array.isArray(role.tools) || role.tools.includes(name))
    : role.tools
  const steps = value => Number(value) > 0 && Number.isFinite(Number(value)) ? Number(value) : null
  const maxSteps = minLimit(steps(inheritedRole.maxSteps ?? inheritedRole.maxTurns), steps(role.maxSteps ?? role.maxTurns))
  return {
    role: { ...role, maxSteps, temperature: role.temperature ?? inheritedRole.temperature, tools, permission: readOnly ? 'readonly' : LEVELS[Math.min(LEVELS.indexOf(parentLevel), LEVELS.indexOf(roleLevel), LEVELS.indexOf(inheritedLevel))] },
    writeScope: readOnly ? 'read-only' : parentScope || writeScope || null,
    limits: { budgetUsd: minLimit(parentRunSpec?.limits?.budgetUsd, limits.budgetUsd), deadlineAt: minLimit(parentRunSpec?.limits?.deadlineAt, limits.deadlineAt) }
  }
}

/** Never let prose or a self-reported completion marker override engine state. */
export function childOutcome(out = {}, aborted = false) {
  const rawStatus = String(out.budgetExceeded || out.stopReason === 'no-progress' ? 'blocked' : out.maxSteps || out.stopReason === 'max-steps' ? 'incomplete' : out.status || '').toLowerCase()
  const cancelled = Boolean(aborted || out.cancelled || rawStatus === 'cancelled')
  const nonSuccess = ['error', 'failed', 'interrupted', 'blocked', 'unknown', 'incomplete', 'max_steps', 'max_steps_exceeded', 'max_turns'].includes(rawStatus)
  const status = cancelled ? 'cancelled' : out.error ? 'error' : nonSuccess ? rawStatus : rawStatus && !['completed', 'success', 'succeeded'].includes(rawStatus) ? 'unknown' : 'completed'
  return { status, ...(cancelled ? { cancelled: true } : {}), ...(out.error ? { error: out.error } : {}), ...(out.verification ? { verification: out.verification } : {}), ...(out.stopReason ? { stop_reason: out.stopReason } : {}), ...(out.partialReply ? { partial_reply: out.partialReply } : {}), ...(out.interruptionReason ? { interruption_reason: out.interruptionReason } : {}), ...(out.terminationReason ? { termination_reason: out.terminationReason } : {}) }
}
