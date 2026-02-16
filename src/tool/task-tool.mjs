export function createTaskTool() {
  return {
    name: "task",
    description: "Delegate complex multi-step work to a subagent that makes its own LLM calls. IMPORTANT: Do NOT use this for simple file operations — use 'write' to create files and 'edit' to modify files directly. Only use 'task' when the work requires multiple tool calls, reasoning, or autonomous decision-making (e.g. 'refactor module X', 'write tests for Y'). Background tasks (run_in_background) spawn a separate worker process.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "task prompt" },
        description: { type: "string", description: "short task description" },
        subagent_type: { type: "string", description: "explicit subagent type" },
        category: { type: "string", description: "routing category" },
        run_in_background: { type: "boolean", description: "run async in background" },
        session_id: { type: "string", description: "continue from existing sub session" },
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
