// Authored task state is not execution/verification evidence. Keep the same
// counts in the terminal and browser, without inferred percentages or gates.
const statuses = new Set(['pending', 'in_progress', 'completed', 'blocked', 'cancelled'])
export const todoStatusLabels = Object.freeze({ pending: '待办', in_progress: '进行中', completed: '已完成', blocked: '受阻', cancelled: '已取消' })

export function acceptTodoSnapshot(current, incoming, sessionId) {
  if (!incoming || incoming.sessionId !== sessionId || !Number.isSafeInteger(incoming.revision) || incoming.revision < 0 || !Array.isArray(incoming.items)) return current
  if (current?.sessionId === sessionId && incoming.revision <= current.revision) return current
  const ids = new Set()
  for (const item of incoming.items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.content !== 'string' || !statuses.has(item.status)) return current
    if (item.activeForm !== undefined && typeof item.activeForm !== 'string') return current
    if (item.dependencies !== undefined && (!Array.isArray(item.dependencies) || item.dependencies.some(id => typeof id !== 'string'))) return current
    if (item.owner !== undefined && (!item.owner || typeof item.owner !== 'object' || ['sessionId', 'agentId'].some(key => item.owner[key] !== undefined && typeof item.owner[key] !== 'string'))) return current
    ids.add(item.id)
  }
  return incoming
}

export function todoProgressSummary(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : []
  if (!items.length) return null
  const count = status => items.filter(item => item.status === status).length
  const completed = count('completed'), active = count('in_progress'), blocked = count('blocked'), cancelled = count('cancelled')
  return { total: items.length, completed, active, blocked, cancelled,
    text: `待办 ${completed}/${items.length} · 进行中 ${active} · 受阻 ${blocked}${cancelled ? ` · 已取消 ${cancelled}` : ''}` }
}

export function todoOwnerLabel(item, sessionId) {
  const owner = item?.owner
  return owner?.agentId || (owner?.sessionId && owner.sessionId !== sessionId ? owner.sessionId : '主代理')
}

export const subagentStatusLabels = Object.freeze({ running: '进行中', pending: '等待中', completed: '已完成', blocked: '受阻', error: '失败', cancelled: '已取消', interrupted: '已中断', incomplete: '未完成', unknown: '待核查' })
export function scopedSubagents(value, sessionId) {
  return Array.isArray(value) ? value.filter(item => item?.parent_session_id === sessionId && typeof item.session_id === 'string' && item.session_id).map(item => ({ session_id: item.session_id, parent_session_id: sessionId, subagent: typeof item.subagent === 'string' ? item.subagent : '子代理', status: Object.hasOwn(subagentStatusLabels, item.status) ? item.status : 'unknown' })) : []
}
export function mergeSubagentEvent(items, event, sessionId) {
  if (event.sessionId !== sessionId || !['subagent.delegated', 'subagent.settled'].includes(event.type) || typeof event.payload?.subSessionId !== 'string') return items
  const payload = event.payload
  const [child] = scopedSubagents([{ session_id: payload.subSessionId, parent_session_id: sessionId, subagent: payload.subagent, status: event.type === 'subagent.delegated' ? 'running' : payload.status }], sessionId)
  if (!child) return items
  return [...items.filter(item => item.session_id !== child.session_id), child]
}
export function subagentProgressSummary(items = []) {
  if (!items.length) return null
  const completed = items.filter(item => item.status === 'completed').length
  const active = items.filter(item => ['running', 'pending'].includes(item.status)).length
  const attention = items.filter(item => !['running', 'pending', 'completed', 'cancelled'].includes(item.status)).length
  return `子代理 ${completed}/${items.length} · 进行中 ${active} · 需关注 ${attention}`
}
