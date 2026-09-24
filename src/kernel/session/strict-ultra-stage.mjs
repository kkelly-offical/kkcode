import path from "node:path"
import { stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { runtimeCwd } from "../core/runtime-context.mjs"
import { createRunSpec } from "../orchestration/run-spec.mjs"
import { getAgent } from "../agent/agent.mjs"
import { processTurnLoop } from "./loop.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { resolveTaskModel } from '../provider/task-model.mjs'

/** Strict first release: one writer, no BackgroundManager/host worker forks.
 * Calls remain on the host control-plane ALS chain; every tool still traverses
 * the delegated kernel's owner-fenced strict backend. Completion is only stage
 * execution progress, never independent acceptance of the final task.
 */
export async function runStrictUltraStage({ stage, sessionId, model, providerType, configState,
  baseUrl, apiKeyEnv, signal, output, toolContext, objective, priorContext,
  seedTaskProgress = {}, onTaskComplete = null }) {
  const cwd = runtimeCwd()
  const route = await resolveTaskModel(configState, { role: 'implementation', model, providerType, baseUrl, apiKeyEnv })
  model = route.model; providerType = route.providerType; baseUrl = route.baseUrl; apiKeyEnv = route.apiKeyEnv
  const tasks = stage.tasks || []
  const ids = new Set(tasks.map(task => task.taskId))
  if (ids.size !== tasks.length) throw new Error("strict stage has duplicate task IDs")
  for (const task of tasks) {
    if ((task.dependsOn || []).some(id => !ids.has(id))) throw new Error("strict stage references an unknown dependency")
    for (const name of task.plannedFiles || []) {
      const relative = path.relative(cwd, path.resolve(cwd, name))
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("strict stage file scope escapes workspace")
    }
  }
  const pending = new Map(tasks.map(task => [task.taskId, task]))
  const taskProgress = {}, fileChanges = []
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolEvents = []
  await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_STAGE_STARTED, sessionId, payload: { stageId: stage.stageId, execution: "strict_sequential" } })
  while (pending.size) {
    signal?.throwIfAborted()
    const task = [...pending.values()].find(item => (item.dependsOn || []).every(id => !pending.has(id)))
    if (!task) throw new Error("strict stage dependency cycle detected")
    pending.delete(task.taskId)
    const seeded = seedTaskProgress[task.taskId] || {}
    const progress = {
      stageId: stage.stageId, taskId: task.taskId, status: "running", attempt: Number(seeded.attempt || 0) + 1,
      plannedFiles: [...(task.plannedFiles || [])], completedFiles: [], remainingFiles: [], lastReply: "", lastError: "", fileChanges: []
    }
    taskProgress[task.taskId] = progress
    if ((task.dependsOn || []).some(id => taskProgress[id]?.status !== "completed")) {
      progress.status = "error"; progress.lastError = "strict stage dependency did not finish"
      continue
    }
    const suffix = createHash("sha256").update(`${stage.stageId}:${task.taskId}`).digest("hex").slice(0, 20)
    const childSessionId = `strict_${sessionId}_${suffix}`
    const timeout = Math.max(1000, Number(task.timeoutMs || 600000))
    const childSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_STAGE_TASK_DISPATCHED, sessionId,
      payload: { stageId: stage.stageId, taskId: task.taskId, subSessionId: childSessionId, execution: "strict_sequential", attempt: progress.attempt } })
    try {
      const agent = getAgent("coding-agent")
      const outcome = await processTurnLoop({
        prompt: ["## Strict delegated stage", `Objective: ${objective}`, priorContext,
          `Task: ${task.prompt}`, `Planned files: ${progress.plannedFiles.join(", ")}`,
          "Work only inside the approved task scope. Do not weaken the host acceptance sources. Final acceptance runs separately."].filter(Boolean).join("\n\n"),
        mode: "agent", agent, model, providerType, sessionId: childSessionId, configState,
        baseUrl, apiKeyEnv, signal: childSignal, output, allowQuestion: false, toolContext,
        runSpec: createRunSpec({ sessionId: childSessionId, parentSessionId: sessionId, model, provider: providerType,
          role: agent, workspace: { root: cwd, cwd, isolation: "strict", writeScope: progress.plannedFiles }, limits: { deadlineAt: Date.now() + timeout } })
      })
      progress.lastReply = String(outcome.reply || "")
      for (const key of Object.keys(usage)) usage[key] += Number(outcome.usage?.[key] || 0)
      toolEvents.push(...(outcome.toolEvents || []))
      progress.fileChanges = (outcome.toolEvents || []).flatMap(event => event?.metadata?.fileChanges || [])
      fileChanges.push(...progress.fileChanges)
      for (const name of progress.plannedFiles) {
        const present = await stat(path.resolve(cwd, name)).then(info => info.isFile(), () => false)
        if (present) progress.completedFiles.push(name)
        else progress.remainingFiles.push(name)
      }
      progress.status = progress.remainingFiles.length ? "error" : "completed"
      progress.lastError = progress.remainingFiles.length ? "planned outputs are missing; final acceptance has not passed" : ""
      if (onTaskComplete && progress.status === "completed") await onTaskComplete(progress)
    } catch (error) {
      progress.status = "error"
      progress.lastError = String(error?.message || error)
      signal?.throwIfAborted()
    }
    await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_STAGE_TASK_FINISHED, sessionId,
      payload: { stageId: stage.stageId, taskId: task.taskId, status: progress.status, attempt: progress.attempt, remainingFiles: progress.remainingFiles } })
  }
  const successCount = Object.values(taskProgress).filter(task => task.status === "completed").length
  return { allSuccess: successCount === tasks.length && tasks.length > 0, successCount, failCount: tasks.length - successCount,
    taskProgress, fileChanges, completionMarkerSeen: false, usage, toolEvents }
}
