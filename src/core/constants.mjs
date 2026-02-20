export const MODES = ["ask", "plan", "agent", "longagent"]

export const TOOL_STATUSES = ["running", "completed", "error", "cancelled"]

export const PERMISSION_DECISIONS = ["allow_once", "allow_session", "deny"]

export const DEFAULT_MAX_STEPS = 8
export const DEFAULT_REQUEST_TIMEOUT_MS = 120000
export const DEFAULT_RETRY_ATTEMPTS = 3
export const DEFAULT_LONGAGENT_RETRY_STORM_THRESHOLD = 3
export const DEFAULT_LONGAGENT_TOKEN_ALERT_THRESHOLD = 120000

export const EVENT_TYPES = {
  TURN_START: "turn.start",
  TURN_STEP_START: "turn.step.start",
  TURN_STEP_FINISH: "turn.step.finish",
  TURN_FINISH: "turn.finish",
  TURN_ERROR: "turn.error",
  TOOL_START: "tool.start",
  TOOL_FINISH: "tool.finish",
  TOOL_ERROR: "tool.error",
  PERMISSION_ASKED: "permission.asked",
  PERMISSION_DECIDED: "permission.decided",
  REVIEW_DECISION: "review.decision",
  MCP_HEALTH: "mcp.health",
  MCP_REQUEST: "mcp.request",
  LONGAGENT_HEARTBEAT: "longagent.heartbeat",
  LONGAGENT_ALERT: "longagent.alert",
  LONGAGENT_PHASE_CHANGED: "longagent.phase.changed",
  LONGAGENT_GATE_CHECKED: "longagent.gate.checked",
  LONGAGENT_RECOVERY_ENTERED: "longagent.recovery.entered",
  LONGAGENT_INTAKE_STARTED: "longagent.intake.started",
  LONGAGENT_PLAN_FROZEN: "longagent.plan.frozen",
  LONGAGENT_STAGE_STARTED: "longagent.stage.started",
  LONGAGENT_STAGE_TASK_DISPATCHED: "longagent.stage.task.dispatched",
  LONGAGENT_STAGE_TASK_FINISHED: "longagent.stage.task.finished",
  LONGAGENT_STAGE_FINISHED: "longagent.stage.finished",
  LONGAGENT_SCAFFOLD_COMPLETE: "longagent.scaffold.complete",
  LONGAGENT_GIT_BRANCH_CREATED: "longagent.git.branch.created",
  LONGAGENT_GIT_STAGE_COMMITTED: "longagent.git.stage.committed",
  LONGAGENT_GIT_MERGED: "longagent.git.merged",
  SESSION_COMPACTED: "session.compacted",
  TURN_USAGE_UPDATE: "turn.usage.update",
  STREAM_TEXT_START: "stream.text.start",
  STREAM_THINKING_START: "stream.thinking.start"
}
