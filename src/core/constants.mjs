export const MODES = ["ask", "plan", "agent", "longagent"]

export const TOOL_STATUSES = ["running", "completed", "error", "cancelled"]

export const PERMISSION_DECISIONS = ["allow_once", "allow_session", "deny"]

export const DEFAULT_MAX_STEPS = 8
export const DEFAULT_REQUEST_TIMEOUT_MS = 120000
export const DEFAULT_RETRY_ATTEMPTS = 3
export const DEFAULT_LONGAGENT_RETRY_STORM_THRESHOLD = 3
export const DEFAULT_LONGAGENT_TOKEN_ALERT_THRESHOLD = 120000

export const LONGAGENT_4STAGE_STAGES = {
  PREVIEW: "preview",
  BLUEPRINT: "blueprint",
  CODING: "coding",
  DEBUGGING: "debugging"
}

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
  MCP_RECONNECT: "mcp.reconnect",
  MCP_CIRCUIT_OPEN: "mcp.circuit_open",
  MCP_CIRCUIT_CLOSE: "mcp.circuit_close",
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
  LONGAGENT_4STAGE_PREVIEW_START: "longagent.4stage.preview.start",
  LONGAGENT_4STAGE_PREVIEW_COMPLETE: "longagent.4stage.preview.complete",
  LONGAGENT_4STAGE_BLUEPRINT_START: "longagent.4stage.blueprint.start",
  LONGAGENT_4STAGE_BLUEPRINT_COMPLETE: "longagent.4stage.blueprint.complete",
  LONGAGENT_4STAGE_CODING_START: "longagent.4stage.coding.start",
  LONGAGENT_4STAGE_CODING_COMPLETE: "longagent.4stage.coding.complete",
  LONGAGENT_4STAGE_DEBUGGING_START: "longagent.4stage.debugging.start",
  LONGAGENT_4STAGE_DEBUGGING_COMPLETE: "longagent.4stage.debugging.complete",
  LONGAGENT_4STAGE_RETURN_TO_CODING: "longagent.4stage.return_to_coding",
  LONGAGENT_HYBRID_PREVIEW_START: "longagent.hybrid.preview.start",
  LONGAGENT_HYBRID_PREVIEW_COMPLETE: "longagent.hybrid.preview.complete",
  LONGAGENT_HYBRID_BLUEPRINT_START: "longagent.hybrid.blueprint.start",
  LONGAGENT_HYBRID_BLUEPRINT_COMPLETE: "longagent.hybrid.blueprint.complete",
  LONGAGENT_HYBRID_DEBUGGING_START: "longagent.hybrid.debugging.start",
  LONGAGENT_HYBRID_DEBUGGING_COMPLETE: "longagent.hybrid.debugging.complete",
  LONGAGENT_HYBRID_RETURN_TO_CODING: "longagent.hybrid.return_to_coding",
  LONGAGENT_HYBRID_BLUEPRINT_REVIEW: "longagent.hybrid.blueprint.review",
  LONGAGENT_HYBRID_BLUEPRINT_VALIDATED: "longagent.hybrid.blueprint.validated",
  LONGAGENT_HYBRID_CROSS_REVIEW: "longagent.hybrid.cross_review",
  LONGAGENT_HYBRID_INCREMENTAL_GATE: "longagent.hybrid.incremental_gate",
  LONGAGENT_HYBRID_CONTEXT_COMPRESSED: "longagent.hybrid.context_compressed",
  LONGAGENT_HYBRID_BUDGET_WARNING: "longagent.hybrid.budget_warning",
  LONGAGENT_HYBRID_CHECKPOINT_RESUMED: "longagent.hybrid.checkpoint_resumed",
  LONGAGENT_HYBRID_REPLAN: "longagent.hybrid.replan",
  LONGAGENT_HYBRID_MEMORY_LOADED: "longagent.hybrid.memory_loaded",
  LONGAGENT_HYBRID_MEMORY_SAVED: "longagent.hybrid.memory_saved",
  SESSION_COMPACTED: "session.compacted",
  TURN_USAGE_UPDATE: "turn.usage.update",
  STREAM_TEXT_START: "stream.text.start",
  STREAM_THINKING_START: "stream.thinking.start",
  LONGAGENT_DEGRADATION_APPLIED: "longagent.degradation.applied",
  LONGAGENT_WRITE_LOOP_DETECTED: "longagent.write_loop.detected",
  LONGAGENT_SEMANTIC_ERROR_REPEATED: "longagent.semantic_error.repeated",
  LONGAGENT_PHASE_TIMEOUT: "longagent.phase.timeout",
  LONGAGENT_GIT_CONFLICT_RESOLUTION: "longagent.git.conflict_resolution",
  LONGAGENT_CHECKPOINT_CLEANED: "longagent.checkpoint.cleaned"
}
