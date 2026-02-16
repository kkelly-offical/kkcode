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
  return {
    taskId,
    prompt,
    subagentType: task?.subagentType ? String(task.subagentType) : undefined,
    category: task?.category ? String(task.category) : undefined,
    plannedFiles: normalizeFileList(task?.plannedFiles),
    acceptance: normalizeStringList(task?.acceptance),
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
  }

  if (errors.length) {
    return {
      plan: defaultStagePlan(objective || plan.objective, defaults),
      errors
    }
  }
  return { plan, errors: [] }
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
      "You are performing pre-planning intake for a long-running coding task.",
      "Ask the most critical clarifying questions, then answer them with explicit assumptions.",
      "Return STRICT JSON:",
      `{"enough":boolean,"summary":"...","qa":[{"q":"...","a":"..."}]}`,
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
    "Generate a stage plan for parallel execution.",
    "Return STRICT JSON ONLY with this schema:",
    '{"planId":"...","objective":"...","stages":[{"stageId":"...","name":"...","passRule":"all_success","tasks":[{"taskId":"...","prompt":"...","subagentType":"...","category":"...","plannedFiles":["..."],"acceptance":["..."],"timeoutMs":600000,"maxRetries":2}]}]}',
    "Rules:",
    "- passRule must be all_success",
    "- each stage must have 1..8 tasks",
    "- each task must include prompt, plannedFiles, acceptance",
    "- keep task scope independent for parallel execution",
    "",
    `Objective: ${objective}`,
    intakeSummary ? `Intake summary:\n${intakeSummary}` : ""
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
  const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
  return {
    plan,
    errors,
    rawReply: out.reply
  }
}
