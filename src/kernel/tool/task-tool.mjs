import { currentDurableRun } from '../orchestration/run-runtime.mjs'
import { isTaskGraphHost } from '../orchestration/task-graph-runtime.mjs'

function strictGraph(context) {
  const binding = currentDurableRun()
  if (!binding) return null
  if (!isTaskGraphHost(binding.taskGraph)) throw new Error('严格委派缺少宿主任务图能力；不会回退到普通子代理。')
  return { host: binding.taskGraph, context: { parentRunId: binding.runId, ownerEpoch: binding.ownerEpoch, invocationId: context.toolCallId, signal: context.signal } }
}

function taskProperties() {
  // Property order is the reading order for the model: core delegation fields
  // first, structured brief fields next, orchestration-internal fields last.
  return {
    prompt: { type: "string", description: "self-contained task brief for the delegated subagent" },
    description: { type: "string", description: "short task description for background task tracking" },
    subagent_type: { type: "string", description: "explicit subagent type" },
    run_in_background: { type: "boolean", description: "run async in background for non-blocking sidecar work" },
    execution_mode: { type: "string", enum: ["fresh_agent", "fork_context"], description: "delegation mode: fresh_agent for isolated work, fork_context for read-only sidecars that inherit the parent transcript" },
    objective: { type: "string", description: "primary outcome to achieve when synthesizing a delegation brief" },
    why: { type: "string", description: "context or decision pressure behind the delegated work" },
    write_scope: { type: "string", description: "explicit write scope such as read-only, specific files, or no mutations" },
    starting_points: { type: "array", items: { type: "string" }, description: "relevant files, symbols, tests, or commands the subagent should start from" },
    constraints: { type: "array", items: { type: "string" }, description: "architectural boundaries, forbidden edits, or safety constraints for the delegated run" },
    deliverable: { type: "string", description: "expected output from the subagent, such as a patch, findings, or a concise summary" },
    category: { type: "string", description: "routing category (alternative to subagent_type; mutually exclusive)" },
    inherit_context: { type: "boolean", description: "shortcut for execution_mode=fork_context; only valid for read-only sidecar work" },
    session_id: { type: "string", description: "continue from an existing delegated sub-session instead of starting fresh" },
    isolation: { type: "string", enum: ["default", "worktree"], description: "execution isolation for delegated work" },
    allow_question: { type: "boolean", description: "allow question tool during delegated run; foreground only" },
    planned_files: { type: "array", items: { type: "string" }, description: "planned files for this task" },
    budget_usd: { type: "number", description: "hard USD ceiling for this delegation; the subagent aborts when its own spend crosses it" },
    deadline_at: { type: "number", description: "epoch-ms deadline; the subagent aborts past this timestamp" },
    group_id: { type: "string", description: "optional parallel group id for related delegated tasks (orchestration)" },
    group_label: { type: "string", description: "optional human-readable parallel group label (orchestration)" },
    stage_id: { type: "string", description: "optional stage id (orchestration-internal)" },
    task_id: { type: "string", description: "optional logical task id (orchestration-internal)" },
    depends_on: { type: "array", items: { type: "string" }, description: "strict host task graph: logical sibling IDs whose candidate evidence must be host-approved first" }
  }
}

function newGroupId() {
  return "grp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

const TASK_CORE_KEYS = ['prompt', 'description', 'subagent_type', 'category', 'run_in_background', 'execution_mode', 'session_id']

function taskSchema() {
  const properties = taskProperties()
  const brief = { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => !TASK_CORE_KEYS.includes(key))) }
  return { type: 'object', properties: { ...properties, brief }, required: [] }
}

/** Model sees a compact core + brief; old flat SDK/recorded calls remain valid. */
export function taskModelSchema(fullSchema = taskSchema()) {
  return { ...fullSchema, properties: Object.fromEntries([...TASK_CORE_KEYS, 'brief'].filter(key => fullSchema.properties[key]).map(key => [key, fullSchema.properties[key]])) }
}

export function normalizeTaskBrief(args = {}) {
  if (args.brief == null) return args
  if (typeof args.brief !== 'object' || Array.isArray(args.brief)) throw new Error('task.brief must be an object')
  const allowed = taskSchema().properties.brief.properties
  if (Object.keys(args.brief).some(key => !Object.hasOwn(allowed, key))) throw new Error('task.brief contains unknown fields; routing fields belong at the top level')
  const { brief, ...flat } = args
  return { ...brief, ...flat }
}

export function createTaskTool() {
  return {
    name: "task",
    description: "Delegate complex multi-step work to a subagent that makes its own LLM calls. Use inherit_context=true or execution_mode=fork_context for read-only sidecars that need the parent transcript. Background tasks spawn a separate worker process and must be observed via task_list/task_output.",
    inputSchema: taskSchema(),
    async execute(args, ctx) {
      const graph = strictGraph(ctx)
      if (graph) return graph.host.delegateTask(normalizeTaskBrief(args || {}), graph.context)
      if (typeof ctx.delegateTask !== "function") return { error: "task delegate unavailable" }
      const result = await ctx.delegateTask(normalizeTaskBrief(args || {}))
      return formatTaskResult(result)
    }
  }
}

/**
 * 前台委派结果的序列化。0.6.0 之前整个对象走 JSON.stringify 再被硬砍到
 * 3000 字符 —— reply 的有效预算被 JSON 转义与元数据字段吃掉一大截，还常在
 * 转义序列中间断掉。改为：reply 原文在前，元数据压成尾部几行。
 * 后台句柄与错误对象保持原样（结构本身就是给模型的操作指引）。
 */
export function formatTaskResult(result) {
  if (!result || typeof result !== "object") return result
  if (result.error || result.background_task_id || result.cancelled) return result
  if (typeof result.reply !== "string") return result

  const files = Array.isArray(result.file_changes) ? result.file_changes : []
  const meta = [
    `subagent: ${result.subagent || "?"} · session: ${result.session_id || "?"} · tool events: ${result.tool_events ?? 0}`,
    ...(files.length ? [`files changed: ${files.map((f) => f.path || f).slice(0, 20).join(", ")}`] : [])
  ]
  return {
    output: `${result.reply.trim()}\n\n--- delegation ---\n${meta.join("\n")}`,
    metadata: {
      session_id: result.session_id,
      subagent: result.subagent,
      execution_mode: result.execution_mode,
      group_id: result.group_id
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
        budget_usd: { type: "number", description: "strict graph total USD ceiling; node reservations must fit this ceiling" },
        deadline_at: { type: "number", description: "strict graph persisted epoch-ms deadline; restarting does not extend it" },
        max_concurrency: { type: "integer", minimum: 1, maximum: 8, description: "strict graph concurrent child limit" },
        tasks: { type: "array", description: "subagent tasks to launch in parallel", items: taskSchema() }
      },
      required: ["tasks"]
    },
    async execute(args, ctx) {
      const graph = strictGraph(ctx)
      if (graph) return graph.host.delegateTaskGroup({ ...args, tasks: (args?.tasks || []).map(normalizeTaskBrief) }, graph.context)
      if (typeof ctx.delegateTask !== "function") return { error: "task delegate unavailable" }
      const tasks = Array.isArray(args?.tasks) ? args.tasks : []
      if (tasks.length === 0) return { error: "task_group.tasks must contain at least one task" }
      const groupId = String(args.group_id || newGroupId())
      const groupLabel = String(args.group_label || "parallel subagents")
      const results = []
      for (let i = 0; i < tasks.length; i++) {
        const task = normalizeTaskBrief(tasks[i] || {})
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
