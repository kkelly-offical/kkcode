import { newId } from "../core/types.mjs"
import { processTurnLoop } from "./loop.mjs"

function stripFence(text = "") {
  const raw = String(text || "").trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  return raw
}

function parseJsonLoose(text = "") {
  const raw = stripFence(text)
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function normalizeFileList(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .slice(0, 80))]
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .slice(0, 50)
}

function normalizeTask(task, stageId, defaults = {}) {
  const baseId = String(task?.taskId || task?.id || "").trim()
  const taskId = baseId || `${stageId}_task_${newId("t").slice(-6)}`
  const prompt = String(task?.prompt || "").trim()
  if (!prompt) return null
  const timeoutMs = Number(task?.timeoutMs || defaults.timeoutMs || 600000)
  const maxRetries = Number(task?.maxRetries ?? defaults.maxRetries ?? 2)
  const complexity = ["low", "medium", "high"].includes(task?.complexity) ? task.complexity : "medium"
  const dependsOn = normalizeStringList(task?.dependsOn || [])
  return {
    taskId,
    prompt,
    subagentType: task?.subagentType ? String(task.subagentType) : undefined,
    category: task?.category ? String(task.category) : undefined,
    plannedFiles: normalizeFileList(task?.plannedFiles),
    acceptance: normalizeStringList(task?.acceptance),
    dependsOn,
    complexity,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 600000,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 2
  }
}

function normalizeStage(stage, defaults = {}, idx = 0) {
  const stageId = String(stage?.stageId || stage?.id || `stage_${idx + 1}`).trim() || `stage_${idx + 1}`
  const name = String(stage?.name || `Stage ${idx + 1}`).trim() || `Stage ${idx + 1}`
  const tasks = Array.isArray(stage?.tasks)
    ? stage.tasks.map((t) => normalizeTask(t, stageId, defaults)).filter(Boolean)
    : []
  return {
    stageId,
    name,
    passRule: "all_success",
    tasks
  }
}

export function defaultStagePlan(objective, defaults = {}) {
  const stageId = "stage_1"
  return {
    planId: newId("plan"),
    objective: String(objective || "").trim(),
    stages: [
      {
        stageId,
        name: "Execution",
        passRule: "all_success",
        tasks: [
          {
            taskId: `${stageId}_task_1`,
            prompt: String(objective || "").trim(),
            plannedFiles: [],
            acceptance: ["Task objective is fully usable"],
            timeoutMs: Number(defaults.timeoutMs || 600000),
            maxRetries: Number(defaults.maxRetries ?? 2)
          }
        ]
      }
    ]
  }
}

export function validateAndNormalizeStagePlan(input, { objective = "", defaults = {} } = {}) {
  if (!input || typeof input !== "object") {
    return { plan: defaultStagePlan(objective, defaults), errors: ["plan is not object"] }
  }

  const plan = {
    planId: String(input.planId || newId("plan")),
    objective: String(input.objective || objective || "").trim(),
    stages: Array.isArray(input.stages)
      ? input.stages.map((s, idx) => normalizeStage(s, defaults, idx))
      : []
  }

  const errors = []
  if (!plan.objective) errors.push("objective is empty")
  if (!plan.stages.length) errors.push("no stages")
  for (const stage of plan.stages) {
    if (!stage.tasks.length) errors.push(`stage "${stage.stageId}" has no tasks`)
    // Early file isolation check — detect overlapping file ownership at plan time
    const ownership = new Map()
    for (const task of stage.tasks) {
      for (const file of task.plannedFiles || []) {
        if (ownership.has(file)) {
          errors.push(`stage "${stage.stageId}": file "${file}" claimed by "${ownership.get(file)}" and "${task.taskId}"`)
        } else {
          ownership.set(file, task.taskId)
        }
      }
    }
  }

  // Cross-stage dependency check: later stages should not own files already owned by earlier stages
  const globalOwnership = new Map()
  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      for (const file of task.plannedFiles || []) {
        if (globalOwnership.has(file)) {
          const prev = globalOwnership.get(file)
          errors.push(`file "${file}" appears in stage "${prev}" and "${stage.stageId}" — split into dependency chain or deduplicate`)
        } else {
          globalOwnership.set(file, stage.stageId)
        }
      }
    }
  }

  // Quality score: penalize tasks with no files or no acceptance criteria
  let qualityScore = 100
  let totalTasks = 0
  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      totalTasks += 1
      if (!task.plannedFiles.length) qualityScore -= 15
      if (!task.acceptance.length) qualityScore -= 10
    }
  }
  qualityScore = Math.max(0, Math.min(100, qualityScore))

  if (errors.length) {
    return {
      plan: defaultStagePlan(objective || plan.objective, defaults),
      errors,
      qualityScore: 0
    }
  }
  return { plan, errors: [], qualityScore }
}

export async function runIntakeDialogue({
  objective,
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  agent = null,
  signal = null,
  maxRounds = 6
}) {
  const rounds = Math.max(1, Number(maxRounds || 6))
  const transcript = []
  let summary = ""

  for (let i = 1; i <= rounds; i++) {
    const prompt = [
      "You are performing pre-planning intake for a long-running coding task that will be split into parallel sub-tasks.",
      "",
      "Your goal: identify ambiguities that would cause parallel agents to make conflicting assumptions.",
      "",
      "Focus on these categories:",
      "1. SCOPE: What exactly is in/out of scope? Which files/modules are affected?",
      "2. TECH CHOICES: What frameworks, libraries, patterns should be used? What already exists in the codebase?",
      "3. INTERFACES: What are the expected inputs/outputs, API contracts, data shapes?",
      "4. CONSTRAINTS: Performance requirements, backward compatibility, platform support?",
      "5. DEPENDENCIES: What must be built first? What can be parallelized?",
      "",
      "For each question, provide your best assumption as the answer based on the objective.",
      "Set enough=true when you have enough clarity to generate a concrete file-level plan.",
      "",
      "Return STRICT JSON:",
      `{"enough":boolean,"summary":"concise technical summary of the task with all resolved assumptions","qa":[{"q":"...","a":"..."}]}`,
      "",
      `Round: ${i}/${rounds}`,
      `Objective: ${objective}`,
      summary ? `Previous summary: ${summary}` : ""
    ].filter(Boolean).join("\n")

    const out = await processTurnLoop({
      prompt,
      mode: "ask",
      model,
      providerType,
      sessionId,
      configState,
      baseUrl,
      apiKeyEnv,
      agent,
      signal,
      output: { write: () => {} },
      allowQuestion: true
    })

    const parsed = parseJsonLoose(out.reply)
    if (parsed && Array.isArray(parsed.qa)) {
      for (const item of parsed.qa.slice(0, 10)) {
        const q = String(item?.q || "").trim()
        const a = String(item?.a || "").trim()
        if (q || a) transcript.push({ q, a })
      }
      summary = String(parsed.summary || "").trim() || summary
      const enough = Boolean(parsed.enough)
      if (enough && i >= 2) break
      continue
    }

    const fallbackLine = String(out.reply || "").trim()
    if (fallbackLine) {
      transcript.push({ q: `Round ${i} synthesis`, a: fallbackLine })
      summary = fallbackLine
    }
    if (i >= 2) break
  }

  return {
    transcript,
    summary: summary || String(objective || "").trim()
  }
}

export async function buildStagePlan({
  objective,
  intakeSummary = "",
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  agent = null,
  signal = null,
  defaults = {}
}) {
  const plannerPrompt = [
    "Generate a stage plan for parallel execution of a coding task.",
    "Return STRICT JSON ONLY with this schema:",
    '{"planId":"...","objective":"...","stages":[{"stageId":"...","name":"...","passRule":"all_success","tasks":[{"taskId":"...","prompt":"...","plannedFiles":["..."],"acceptance":["..."],"timeoutMs":600000,"maxRetries":2}]}]}',
    "",
    "## How This Plan Will Be Executed",
    "1. An ARCHITECT agent will create ALL plannedFiles with detailed inline comments (no real code)",
    "2. Each task is assigned to an independent SUB-AGENT that reads the comments and implements the actual code",
    "3. Sub-agents run IN PARALLEL within the same stage — they cannot see each other's work",
    "4. Stages run SEQUENTIALLY — later stages can depend on earlier stages' output",
    "",
    "## Planning Rules",
    "",
    "### File Assignment (CRITICAL)",
    "- Files that import from each other MUST be in the same task",
    "- A module and its tests MUST be in the same task",
    "- A component and its type definitions MUST be in the same task",
    "- Each task should own 2-8 files. 1 file → merge with related task. >10 files → split.",
    "- NO file may appear in multiple tasks (within or across stages)",
    "",
    "### Stage Ordering",
    "- Order: Infrastructure/config → Core logic → Integration/UI → Validation",
    "- If Task B imports from files Task A creates → different stages (A before B)",
    "- Minimize stage count (fewer stages = faster). Only split when there's a real dependency.",
    "",
    "### Task Prompt Requirements (CRITICAL)",
    "- The sub-agent's ONLY context is: your task prompt + the scaffold file comments + file ownership list",
    "- Task prompts MUST include:",
    "  1. What to implement (specific behavior, not vague goals)",
    "  2. Key algorithms or logic patterns to use",
    "  3. How this task integrates with other tasks (what it exports, what format)",
    "  4. Edge cases and error handling requirements",
    "- NEVER write vague prompts like 'implement the auth module'. Write 'implement JWT token generation using HS256, with 24h expiry, reading secret from env.JWT_SECRET'",
    "",
    "### Acceptance Criteria",
    "- MUST be machine-verifiable: 'node --check <file>', 'npm test passes', 'function X exported from Y'",
    "- NEVER subjective: 'code quality is good', 'implementation is clean'",
    "- FINAL stage must include: 'all modified files parse without errors AND project builds'",
    "",
    `## Objective`,
    objective,
    intakeSummary ? `\n## Intake Summary\n${intakeSummary}` : ""
  ].filter(Boolean).join("\n")

  const out = await processTurnLoop({
    prompt: plannerPrompt,
    mode: "plan",
    model,
    providerType,
    sessionId,
    configState,
    baseUrl,
    apiKeyEnv,
    agent,
    signal,
    output: { write: () => {} },
    allowQuestion: true
  })

  const parsed = parseJsonLoose(out.reply)
  if (!parsed) {
    return {
      plan: defaultStagePlan(objective, defaults),
      errors: ["planner returned unparseable response — falling back to single-stage plan"],
      qualityScore: 0,
      rawReply: out.reply
    }
  }
  const { plan, errors, qualityScore } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
  return { plan, errors, qualityScore, rawReply: out.reply }
}
