import {readTodoSnapshot} from './todo-state.mjs'

/** Host observations kept outside the generated summary. They locate durable
 * records; they neither renew authority nor certify current process/effect state. */
export function continuationIndex(snapshot) {
  const sessionId = snapshot?.session?.id
  if (!sessionId) return ''
  const parts = snapshot.parts || []
  const todo = readTodoSnapshot(parts, sessionId)
  const unfinished = todo.items.filter(item => !['completed', 'cancelled'].includes(item.status))
  const tasks = new Map(), effects = new Map(), edits = new Set()
  const lastCompleted = parts.findLastIndex(part => part.type === 'turn-outcome' && part.schema === 'kk.turn-outcome.v1' && part.source === 'host' && part.status === 'completed')
  for (const part of parts.slice(lastCompleted + 1)) {
    if (part.type !== 'tool-call' || part.status === 'running') continue
    const bg = part.metadata?.backgroundTask
    if (bg?.parentSessionId === sessionId && /^bg_[A-Za-z0-9_-]{1,100}$/.test(bg.id)) tasks.set(bg.id, {task_id: bg.id, last_recorded_status: bg.status})
    if (part.metadata?.outcomeUnknown || part.metadata?.terminationIncomplete) effects.set(part.metadata.operationId || part.id, {tool: part.tool, operation_id: part.metadata.operationId || null})
    for (const change of part.metadata?.fileChanges || []) {
      if (typeof change.path === 'string') edits.add(change.path.slice(0, 300))
    }
  }
  if (!unfinished.length && !tasks.size && !effects.size && !edits.size) return ''
  const value = {todo_revision: todo.revision, unfinished_count: unfinished.length,
    unfinished: unfinished.slice(0, 10).map(item => ({id: item.id, content: item.content.slice(0, 180), status: item.status, ...(item.reason ? {reason: item.reason.slice(0, 180)} : {})})),
    process_reference_count: tasks.size, process_references: [...tasks.values()].slice(-8),
    uncertain_record_count: effects.size, uncertain_records: [...effects.values()].slice(-8),
    changed_file_count: edits.size, recent_changed_files: [...edits].slice(-10)}
  return '\n<host-continuation>\nBounded historical locators, not current truth or permission. Continue the current task. Use todo_read for the full current plan and task_output to refresh process references. Inspect operation records before any replay; an old uncertain record may require owner reconciliation. The model summary cannot clear these records.\n' + JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e') + '\n</host-continuation>'
}
