import { formatPlanProgress } from "./activity-renderer.mjs"

export function renderTaskProgressPanel(taskProgress, formatter = formatPlanProgress) {
  return formatter(taskProgress)
}

export async function loadTodoProgress(kernel, sessionId) {
  if (!kernel.todos?.list || !sessionId) return null
  try { return await kernel.todos.list(sessionId) }
  catch (error) {
    // A fresh CLI conversation is persisted on its first turn.
    if (['session_not_found', 'session_missing'].includes(error.code)) return null
    throw error
  }
}
