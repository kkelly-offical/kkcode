import { processTurnLoop } from "./loop.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

function buildScaffoldPrompt(objective, stagePlan) {
  const allFiles = new Set()
  const taskSpecs = []

  for (const stage of stagePlan.stages || []) {
    for (const task of stage.tasks || []) {
      for (const file of task.plannedFiles || []) {
        allFiles.add(file)
      }
      taskSpecs.push({
        taskId: task.taskId,
        prompt: task.prompt,
        plannedFiles: task.plannedFiles,
        acceptance: task.acceptance
      })
    }
  }

  const fileList = [...allFiles].sort()
  if (!fileList.length) return null

  return [
    "You are in SCAFFOLDING mode. Your job is to create stub files that define contracts for parallel implementation agents.",
    "",
    `## Objective: ${objective}`,
    "",
    "## Files to scaffold:",
    ...fileList.map((f) => `- ${f}`),
    "",
    "## Task specifications (for context):",
    JSON.stringify(taskSpecs, null, 2),
    "",
    "## Scaffolding rules:",
    "1. Create EVERY file listed above using the `write` tool.",
    "2. For Python files: write function/class signatures with docstrings describing inputs, outputs, and behavior. Use `pass` or `...` as body.",
    "3. For Vue/React components: write component stubs with props/events/slots documented in comments. Include the component shell structure.",
    "4. For TypeScript/JavaScript: write export signatures with JSDoc or TSDoc describing the interface contract.",
    "5. For config/data files: write the expected schema structure with placeholder values and comments.",
    "6. For test files: write test suite structure with describe/it blocks and comments describing what each test should verify.",
    "7. Each file MUST have a header comment explaining: purpose, dependencies, interfaces it implements/exports.",
    "8. Do NOT implement business logic. Only define the contract (signatures, types, interfaces).",
    "9. Include import statements that reference other scaffolded files so the dependency graph is explicit.",
    "10. When done with ALL files, say [SCAFFOLD_COMPLETE].",
    "",
    "Start creating all stub files now."
  ].join("\n")
}

export async function runScaffoldPhase({
  objective,
  stagePlan,
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  agent = null,
  signal = null,
  toolContext = {}
}) {
  const prompt = buildScaffoldPrompt(objective, stagePlan)
  if (!prompt) {
    return { scaffolded: false, fileCount: 0, files: [], errors: [] }
  }

  const out = await processTurnLoop({
    prompt,
    mode: "agent",
    model,
    providerType,
    sessionId,
    configState,
    baseUrl,
    apiKeyEnv,
    agent,
    signal,
    allowQuestion: false,
    toolContext
  })

  // Extract files created from tool events
  const createdFiles = (out.toolEvents || [])
    .filter((e) => e.name === "write" && e.status === "completed")
    .map((e) => e.args?.path)
    .filter(Boolean)

  return {
    scaffolded: true,
    fileCount: createdFiles.length,
    files: createdFiles,
    usage: out.usage,
    toolEvents: out.toolEvents,
    errors: []
  }
}
