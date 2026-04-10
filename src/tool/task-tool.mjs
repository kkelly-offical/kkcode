export function createTaskTool() {
  return {
    name: "task",
    description: "Delegate complex multi-step work to a subagent that makes its own LLM calls. Prefer staying local for simple edits or critical-path work that immediately depends on your next action. New delegated runs start with fresh context unless you explicitly set execution_mode='fork_context' or continue an existing sub-session via session_id. IMPORTANT: Do NOT use this for simple file operations — use 'write' to create files and 'edit' to modify files directly. Background tasks (run_in_background) spawn a separate worker process for sidecar work.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "self-contained task brief for the delegated subagent" },
        description: { type: "string", description: "short task description for background task tracking" },
        subagent_type: { type: "string", description: "explicit subagent type" },
        category: { type: "string", description: "routing category" },
        execution_mode: { type: "string", description: "delegation mode: 'fresh_agent' (default) or 'fork_context' to inherit the parent session transcript into a forked child session" },
        run_in_background: { type: "boolean", description: "run async in background for non-blocking sidecar work" },
        session_id: { type: "string", description: "continue from an existing delegated sub-session instead of starting fresh" },
        stage_id: { type: "string", description: "optional stage id for orchestration" },
        task_id: { type: "string", description: "optional logical task id" },
        planned_files: { type: "array", items: { type: "string" }, description: "planned files for this task" },
        allow_question: { type: "boolean", description: "allow question tool during delegated run" }
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
