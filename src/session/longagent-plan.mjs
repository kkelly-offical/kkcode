import { newId } from "../core/types.mjs"
import { processTurnLoop } from "./loop.mjs"
import { stripFence, parseJsonLoose } from "./longagent-utils.mjs"

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
  // Downgraded to warnings — cross-stage overlap is common (e.g. shared config) and should not block the plan
  const warnings = []
  const globalOwnership = new Map()
  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      for (const file of task.plannedFiles || []) {
        if (globalOwnership.has(file)) {
          const prev = globalOwnership.get(file)
          warnings.push(`file "${file}" appears in stage "${prev}" and "${stage.stageId}"`)
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
  // Cross-stage file overlap: penalize quality but don't block
  qualityScore -= warnings.length * 5
  qualityScore = Math.max(0, Math.min(100, qualityScore))

  if (errors.length) {
    // If the parsed plan has at least one valid stage with tasks, keep it despite warnings
    const hasValidStages = plan.stages.some(s => s.tasks.length > 0)
    if (hasValidStages) {
      // Filter out empty stages but preserve valid ones
      plan.stages = plan.stages.filter(s => s.tasks.length > 0)
      return { plan, errors, warnings, qualityScore: Math.max(0, qualityScore - errors.length * 10) }
    }
    return {
      plan: defaultStagePlan(objective || plan.objective, defaults),
      errors, warnings,
      qualityScore: 0
    }
  }
  return { plan, errors: [], warnings, qualityScore }
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
      "You are the INTAKE ANALYST for a production-grade parallel coding pipeline.",
      "Multiple independent sub-agents will execute tasks IN PARALLEL — they cannot communicate with each other during execution.",
      "Your job: resolve ALL ambiguities NOW so that parallel agents produce compatible, integrable code.",
      "",
      "## Analysis Categories (address ALL that apply)",
      "",
      "### 1. SCOPE & BOUNDARIES",
      "- What files/modules/directories are IN scope for modification?",
      "- What existing code must NOT be changed (public APIs, shared interfaces, config schemas)?",
      "- Are there related features that should be explicitly excluded to prevent scope creep?",
      "",
      "### 2. TECHNOLOGY & PATTERNS",
      "- What language version, runtime, and framework constraints apply?",
      "- What existing patterns in the codebase MUST be followed (error handling, logging, naming, async style)?",
      "- What existing utilities/helpers MUST be reused instead of reimplemented?",
      "- Are there specific libraries to use or avoid?",
      "",
      "### 3. INTERFACE CONTRACTS",
      "- What are the exact function signatures, parameter types, and return types?",
      "- What data schemas are involved (DB models, API payloads, config shapes)?",
      "- What error types should be thrown/returned and how should callers handle them?",
      "- What events/hooks/callbacks are part of the contract?",
      "",
      "### 4. QUALITY CONSTRAINTS",
      "- What test coverage is expected (unit, integration, e2e)?",
      "- What backward compatibility guarantees must be maintained?",
      "- Are there performance budgets (latency, memory, bundle size)?",
      "- What security considerations apply (input validation, auth, secrets)?",
      "",
      "### 5. DEPENDENCY ORDER",
      "- Which components must exist before others can be built?",
      "- Which components are independent and can be built in parallel?",
      "- Are there shared types/interfaces that must be defined first?",
      "",
      "## Output Rules",
      "- For each question, provide your BEST ASSUMPTION as the answer based on the objective and codebase context.",
      "- Be specific: 'use HS256 JWT with 24h expiry' not 'implement auth'.",
      "- Set enough=true ONLY when you have sufficient clarity to generate a concrete file-level execution plan.",
      "",
      "Return STRICT JSON (no markdown wrapping):",
      `{"enough":boolean,"summary":"technical summary with ALL resolved assumptions and concrete decisions","qa":[{"q":"specific question","a":"concrete answer with implementation detail"}]}`,
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
    "You are the EXECUTION PLANNER for a production-grade parallel coding pipeline.",
    "Generate a stage plan that will be executed by independent sub-agents running in parallel.",
    "",
    "Return STRICT JSON ONLY (no markdown wrapping, no explanation) with this schema:",
    '{"planId":"...","objective":"...","stages":[{"stageId":"...","name":"...","passRule":"all_success","tasks":[{"taskId":"...","prompt":"...","plannedFiles":["..."],"acceptance":["..."],"timeoutMs":600000,"maxRetries":2,"complexity":"low|medium|high"}]}]}',
    "",
    "## Execution Model (understand this before planning)",
    "",
    "1. An ARCHITECT agent creates ALL plannedFiles as scaffolds with detailed inline comments (signatures + logic descriptions, no implementation)",
    "2. Each task is assigned to an INDEPENDENT sub-agent that reads the scaffold and implements real code",
    "3. Sub-agents within the same stage run IN PARALLEL — they CANNOT see each other's work or communicate",
    "4. Stages run SEQUENTIALLY — stage N+1 starts only after ALL tasks in stage N succeed",
    "5. If a task fails, it is retried up to maxRetries times. If all retries fail, the stage fails.",
    "",
    "## File Assignment Rules (violations cause runtime failures)",
    "",
    "- Files that import from each other MUST be in the SAME task (parallel agents cannot resolve cross-task imports)",
    "- A module and its test file MUST be in the same task (tests need the implementation to exist)",
    "- A component and its type definitions MUST be in the same task",
    "- Each task should own 2-8 files. 1 file → merge with a related task. >10 files → split into smaller tasks",
    "- NO file may appear in multiple tasks within a stage or across stages",
    "- Shared types/interfaces that multiple tasks depend on → put in stage 1 as a dedicated 'shared types' task",
    "",
    "## Stage Ordering Strategy",
    "",
    "- Stage 1: Shared types, interfaces, config schemas, utility functions (things others import from)",
    "- Stage 2: Core business logic modules (independent of each other, depend on stage 1)",
    "- Stage 3: Integration layer (routes, controllers, orchestrators that wire stage 2 modules together)",
    "- Stage 4: Tests, validation, documentation (if not already co-located with their modules)",
    "- Minimize stage count — only create a new stage when there is a REAL import dependency from a previous stage",
    "- If all tasks are independent, use a SINGLE stage with multiple parallel tasks",
    "",
    "## Task Prompt Requirements (this is what the sub-agent sees)",
    "",
    "The sub-agent's ONLY context is: (1) your task prompt, (2) the scaffold file with inline comments, (3) the file ownership list.",
    "The sub-agent has NO access to the original user objective, blueprint, or other tasks' prompts.",
    "",
    "Each task prompt MUST include:",
    "1. WHAT to implement — specific behavior with concrete details, not vague goals",
    "2. HOW to implement — key algorithms, data structures, patterns to use",
    "3. INTEGRATION — what this task exports (function names, signatures), what format other tasks expect",
    "4. ERROR HANDLING — what errors to throw/catch, how to handle edge cases (null, empty, invalid input)",
    "5. TESTING — if test files are in this task, what test cases to write (happy path, error cases, edge cases)",
    "",
    "BAD prompt: 'implement the auth module'",
    "GOOD prompt: 'Implement src/auth/jwt.mjs: generateToken(userId, role) returns signed JWT string using HS256 with 24h expiry, reading secret from process.env.JWT_SECRET. Throw AuthError if secret is missing. verifyToken(token) returns decoded payload or throws TokenExpiredError/InvalidTokenError. Export both functions as named exports. Test file: test happy path (valid token roundtrip), expired token, invalid signature, missing secret.'",
    "",
    "## Acceptance Criteria Rules",
    "",
    "- MUST be machine-verifiable commands or assertions:",
    "  - 'node --check src/auth/jwt.mjs' (syntax check)",
    "  - 'node --test test/auth.test.mjs' (test execution)",
    "  - 'grep -q \"export function generateToken\" src/auth/jwt.mjs' (API existence)",
    "- NEVER subjective: 'code is clean', 'implementation is correct', 'works as expected'",
    "- FINAL stage MUST include: 'all modified files parse without syntax errors' AND 'test suite passes'",
    "",
    "## Complexity Rating",
    "",
    "- low: simple CRUD, config changes, straightforward utility functions (< 100 lines total)",
    "- medium: business logic with multiple code paths, moderate error handling (100-500 lines)",
    "- high: complex algorithms, concurrent operations, extensive edge cases (> 500 lines)",
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
