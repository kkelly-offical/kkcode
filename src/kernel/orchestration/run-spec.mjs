import { newId } from "../core/types.mjs"

function freezeObject(value) {
  if (!value || typeof value !== "object") return value
  for (const child of Object.values(value)) freezeObject(child)
  return Object.freeze(value)
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
      maxSteps: Number(role.maxSteps || role.maxTurns || 0) || null
    },
    workspace: {
      root: workspace.root || process.cwd(),
      cwd: workspace.cwd || workspace.root || process.cwd(),
      isolation: workspace.isolation || "default",
      writeScope: workspace.writeScope || null
    },
    limits: {
      deadlineAt: Number(limits.deadlineAt || 0) || null,
      budgetUsd: Number(limits.budgetUsd || 0) || null
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
    maxTurns: spec.role.maxSteps
  }
}
