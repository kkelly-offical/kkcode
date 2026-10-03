import { currentRuntime } from '../core/runtime-context.mjs'
import { BackgroundManager } from '../orchestration/background-manager.mjs'

function parentSession(ctx = {}) {
  const bound = currentRuntime()?.sessionId
  const supplied = ctx.sessionId
  // A model invocation always carries the canonical session. Direct host calls
  // outside a session retain the legacy administrative API, never a model knob.
  if (bound != null && (typeof bound !== 'string' || !bound.trim()) ||
      supplied != null && (typeof supplied !== 'string' || !supplied.trim()) ||
      bound != null && supplied != null && bound !== supplied) {
    throw Object.assign(new Error('Background task session scope is invalid'), { code: 'background_task_scope' })
  }
  return bound ?? supplied ?? null
}

export async function scopedBackgroundTasks(ctx) {
  const owner = parentSession(ctx)
  const tasks = await BackgroundManager.list()
  return owner == null ? tasks : tasks.filter(task => task.payload?.parentSessionId === owner)
}

export async function scopedBackgroundTask(id, ctx) {
  const owner = parentSession(ctx)
  const task = await BackgroundManager.get(id)
  return task && (owner == null || task.payload?.parentSessionId === owner) ? task : null
}

export async function cancelScopedBackgroundTask(id, ctx) {
  const owner = parentSession(ctx)
  return BackgroundManager.cancel(id, owner == null ? {} : { parentSessionId: owner })
}

export async function stopScopedBackgroundTask(id, ctx) {
  const owner = parentSession(ctx)
  return BackgroundManager.requestStop(id, owner == null ? {} : {parentSessionId: owner})
}
