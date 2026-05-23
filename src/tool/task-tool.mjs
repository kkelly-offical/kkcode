function taskProperties() {
  return {
    prompt: { type: "string", description: "self-contained task brief for the delegated subagent" },
    objective: { type: "string", description: "primary outcome to achieve when synthesizing a delegation brief" },
    why: { type: "string", description: "context or decision pressure behind the delegated work" },
    write_scope: { type: "string", description: "explicit write scope such as read-only, specific files, or no mutations" },
    description: { type: "string", description: "short task description for background task tracking" },
    subagent_type: { type: "string", description: "explicit subagent type" },
    category: { type: "string", description: "routing category" },
    session_id: { type: "string", description: "continue from an existing delegated sub-session instead of starting fresh" },
    stage_id: { type: "string", description: "optional stage id for orchestration" },
    task_id: { type: "string", description: "optional logical task id" },
    group_id: { type: "string", description: "optional parallel group id for related delegated tasks" },
    group_label: { type: "string", description: "optional human-readable parallel group label" },
    starting_points: { type: "array", items: { type: "string" }, description: "relevant files, symbols, tests, or commands the subagent should start from" },
    constraints: { type: "array", items: { type: "string" }, description: "architectural boundaries, forbidden edits, or safety constraints for the delegated run" },
    deliverable: { type: "string", description: "expected output from the subagent, such as a patch, findings, or a concise summary" },
    execution_mode: { type: "string", enum: ["fresh_agent", "fork_context"], description: "delegation mode: fresh_agent for isolated work, fork_context for read-only sidecars that inherit the parent transcript" },
    inherit_context: { type: "boolean", description: "shortcut for execution_mode=fork_context; only valid for read-only sidecar work" },
    isolation: { type: "string", enum: ["default", "worktree"], description: "execution isolation for delegated work" },
    run_in_background: { type: "boolean", description: "run async in background for non-blocking sidecar work" },
    planned_files: { type: "array", items: { type: "string" }, description: "planned files for this task" },
    allow_question: { type: "boolean", description: "allow question tool during delegated run; foreground only" }
  }
}

function newGroupId() {
  return "grp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export function createTaskTool() {
  return {
    name: "task",
    description: "Delegate complex multi-step work to a subagent that makes its own LLM calls. Use inherit_context=true or execution_mode=fork_context for read-only sidecars that need the parent transcript. Background tasks spawn a separate worker process and must be observed via task_list/task_output.",
    inputSchema: { type: "object", properties: taskProperties(), required: [] },
    async execute(args, ctx) {
      if (typeof ctx.delegateTask === "function") return ctx.delegateTask(args || {})
      return { error: "task delegate unavailable" }
    }
  }
}

export function createTaskGroupTool() {
  return {
    name: "task_group",
    description: "Launch multiple delegated subagents as one parallel background group. Use this when the user explicitly asks to summon multiple agents, run agents in parallel, split research/review/verification lanes, or compare independent specialist findings.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string", description: "optional stable parallel group id" },
        group_label: { type: "string", description: "human-readable label for the parallel group" },
        inherit_context: { type: "boolean", description: "default context inheritance for tasks that do not specify execution_mode" },
        execution_mode: { type: "string", enum: ["fresh_agent", "fork_context"], description: "default execution mode for tasks" },
        isolation: { type: "string", enum: ["default", "worktree"], description: "default isolation mode for tasks" },
        tasks: { type: "array", description: "subagent tasks to launch in parallel", items: { type: "object", properties: taskProperties(), required: [] } }
      },
      required: ["tasks"]
    },
    async execute(args, ctx) {
      if (typeof ctx.delegateTask !== "function") return { error: "task delegate unavailable" }
      const tasks = Array.isArray(args?.tasks) ? args.tasks : []
      if (tasks.length === 0) return { error: "task_group.tasks must contain at least one task" }
      const groupId = String(args.group_id || newGroupId())
      const groupLabel = String(args.group_label || "parallel subagents")
      const results = []
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i] || {}
        const merged = {
          ...task,
          group_id: task.group_id || groupId,
          group_label: task.group_label || groupLabel,
          run_in_background: true,
          inherit_context: task.inherit_context ?? args.inherit_context,
          execution_mode: task.execution_mode || args.execution_mode,
          isolation: task.isolation || args.isolation || "default",
          description: task.description || task.objective || task.prompt || groupLabel,
          task_id: task.task_id || "lane_" + (i + 1)
        }
        results.push(await ctx.delegateTask(merged))
      }
      return {
        group_id: groupId,
        group_label: groupLabel,
        status: results.some((r) => r?.error) ? "partial_error" : "launched",
        tasks: results,
        visualization: results.map((result, index) => ({ lane: index + 1, task_id: result.background_task_id || null, subagent: tasks[index]?.subagent_type || tasks[index]?.category || "default-subagent", status: result.status || (result.error ? "error" : "unknown"), session_id: result.session_id || null, error: result.error || null }))
      }
    }
  }
}
