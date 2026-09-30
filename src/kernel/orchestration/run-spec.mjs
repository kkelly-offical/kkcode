import { runtimeCwd } from "../core/runtime-context.mjs"
import { newId } from "../core/types.mjs"

function freezeObject(value) {
  if (!value || typeof value !== "object") return value
  for (const child of Object.values(value)) freezeObject(child)
  return Object.freeze(value)
}

function finiteLimit(value, name) {
  if (value == null) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a finite nonnegative number`)
  return number
}

export function createRunSpec(input = {}) {
  const role = input.role || {}
  const workspace = input.workspace || {}
  const limits = input.limits || {}
  return freezeObject({
    runId: input.runId || newId("run"),
    sessionId: input.sessionId || null,
    parentSessionId: input.parentSessionId || null,
    mode: input.mode || "agent",
    model: input.model || null,
    provider: input.provider || null,
    role: {
      name: role.name || "default-subagent",
      prompt: role.prompt || "",
      tools: Array.isArray(role.tools) ? [...role.tools] : null,
      permission: role.permission || null,
      temperature: role.temperature ?? null,
      maxSteps: Number(role.maxSteps || role.maxTurns || 0) || null
    },
    workspace: {
      root: workspace.root || runtimeCwd(),
      cwd: workspace.cwd || workspace.root || runtimeCwd(),
      isolation: workspace.isolation || "default",
      writeScope: workspace.writeScope || null
    },
    limits: {
      deadlineAt: finiteLimit(limits.deadlineAt, 'deadlineAt'),
      budgetUsd: finiteLimit(limits.budgetUsd, 'budgetUsd')
    },
    toolContext: { ...(input.toolContext || {}) }
  })
}

export function runSpecRole(spec) {
  if (!spec?.role) return null
  return {
    name: spec.role.name,
    prompt: spec.role.prompt,
    tools: spec.role.tools,
    permission: spec.role.permission,
    temperature: spec.role.temperature,
    maxTurns: spec.role.maxSteps
  }
}
