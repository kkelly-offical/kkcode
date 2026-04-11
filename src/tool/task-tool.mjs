export function createTaskTool() {
  return {
    name: "task",
    description: "Delegate complex multi-step work to a subagent that makes its own LLM calls. Prefer staying local for simple edits or critical-path work that immediately depends on your next action. New delegated runs start with fresh context unless you explicitly set execution_mode='fork_context' or continue an existing sub-session via session_id. `fork_context` is reserved for read-only sidecar work such as audits, reviews, and follow-up verification. You may provide either a fully written prompt or structured brief fields (objective/why/write_scope/starting_points/constraints/deliverable) for kkcode to synthesize a directive delegation brief. IMPORTANT: Do NOT use this for simple file operations — use 'write' to create files and 'edit' to modify files directly. Background tasks (run_in_background) spawn a separate worker process for sidecar work, cannot ask interactive questions, and must be observed via deterministic status/result retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "self-contained task brief for the delegated subagent" },
        objective: { type: "string", description: "primary outcome to achieve when synthesizing a delegation brief" },
        why: { type: "string", description: "context or decision pressure behind the delegated work" },
        write_scope: { type: "string", description: "explicit write scope such as read-only, specific files, or no mutations" },
        starting_points: { type: "array", items: { type: "string" }, description: "relevant files, symbols, tests, or commands the subagent should start from" },
        constraints: { type: "array", items: { type: "string" }, description: "architectural boundaries, forbidden edits, or safety constraints for the delegated run" },
        deliverable: { type: "string", description: "expected output from the subagent, such as a patch, findings, or a concise summary" },
        description: { type: "string", description: "short task description for background task tracking" },
        subagent_type: { type: "string", description: "explicit subagent type" },
        category: { type: "string", description: "routing category" },
        execution_mode: { type: "string", enum: ["fresh_agent", "fork_context"], description: "delegation mode: 'fresh_agent' (default) for implementation or isolated new work, or 'fork_context' for read-only sidecar work that must inherit the parent transcript" },
        run_in_background: { type: "boolean", description: "run async in background for non-blocking sidecar work; background delegates cannot ask interactive questions" },
        session_id: { type: "string", description: "continue from an existing delegated sub-session instead of starting fresh" },
        stage_id: { type: "string", description: "optional stage id for orchestration" },
        task_id: { type: "string", description: "optional logical task id" },
        planned_files: { type: "array", items: { type: "string" }, description: "planned files for this task" },
        allow_question: { type: "boolean", description: "allow question tool during delegated run; foreground only, not supported for run_in_background=true" }
      },
      required: []
    },
    async execute(args, ctx) {
      if (typeof ctx.delegateTask !== "function") {
        return { error: "task delegate unavailable" }
      }
      return ctx.delegateTask(args || {})
    }
  }
}
