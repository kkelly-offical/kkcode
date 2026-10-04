import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptTodoSnapshot, todoProgressSummary, scopedSubagents, mergeSubagentEvent, mergeSubagentSnapshot, subagentProgressSummary } from '../src/ui/todo-progress.mjs'
import { createActivityRenderer, formatTodoProgress } from '../src/ui/activity-renderer.mjs'
import { createTranscriptModel } from '../src/ui/transcript-model.mjs'

const snapshot = (revision = 1, items = ['completed', 'in_progress', 'in_progress', 'blocked', 'cancelled'].map((status, i) => ({ id: String(i), content: `Task ${i}`, status, owner: { sessionId: 's', agentId: i ? `child-${i}` : '' }, dependencies: i ? ['0'] : [] }))) => ({ sessionId: 's', revision, items })

test('durable progress counts all active children and keeps authored completion separate from verification', () => {
  const result = todoProgressSummary(snapshot())
  assert.deepEqual(result, { total: 5, completed: 1, active: 2, blocked: 1, cancelled: 1, text: '待办 1/5 · 进行中 2 · 受阻 1 · 已取消 1' })
  assert.equal(todoProgressSummary(snapshot(1, [])), null)
  assert.equal(todoProgressSummary(null), null)
  const block = formatTodoProgress(snapshot())
  assert.equal(block.expanded, false)
  assert.ok(block.details.includes('任务状态由代理更新；已完成不等于已验证。'))
  assert.ok(block.details.some(line => line.includes('child-1 · 依赖：0')))
  assert.doesNotMatch(block.summary, /%|已验证/)
})

test('old/replayed/wrong-session/malformed snapshots cannot replace current progress; newer empty snapshot clears it', () => {
  const current = snapshot(4)
  for (const incoming of [snapshot(2), snapshot(4), { ...snapshot(7), sessionId: 'other' }, { ...snapshot(7), revision: NaN }, snapshot(7, [{ id: 'invalid', status: 'verified', content: 'No proof' }]), snapshot(7, [{ id: 'same', status: 'pending', content: 'one' }, { id: 'same', status: 'pending', content: 'two' }])]) assert.equal(acceptTodoSnapshot(current, incoming, 's'), current)
  assert.equal(acceptTodoSnapshot(null, snapshot(4), 'other'), null)
  for (const invalid of [{ activeForm: {} }, { dependencies: 'not-an-array' }, { owner: { agentId: {} } }]) assert.equal(acceptTodoSnapshot(current, snapshot(7, [{ id: 'malformed', status: 'pending', content: 'test', ...invalid }]), 's'), current)
  assert.equal(acceptTodoSnapshot(current, snapshot(5, []), 's').items.length, 0)
})

test('terminal updates one collapsed durable block, sanitizes labels, ignores stale writes and removes empty progress', () => {
  let accept
  const transcript = createTranscriptModel()
  const renderer = createActivityRenderer({ output: transcript, eventBus: { subscribe(handler) { accept = handler; return () => {} } } })
  renderer.start()
  const emit = value => accept({ type: 'todo.updated', sessionId: 's', payload: { snapshot: value } })
  emit(snapshot())
  emit(snapshot(2, [{ id: 'safe', content: '\u001b[2Jforged', status: 'completed', owner: { agentId: '\u001b[2Jchild' }, dependencies: ['\u001b[2Jdep'] }]))
  emit(snapshot())
  assert.equal(transcript.getItems().length, 1)
  const [block] = transcript.getItems()
  assert.equal(block.summary, '待办 1/1 · 进行中 0 · 受阻 0')
  assert.doesNotMatch(block.details.join('\n'), /\u001b/)
  emit(snapshot(3, []))
  assert.equal(transcript.getItems().length, 0)
  renderer.stop()
})

test('child snapshots/events are parent scoped, content free, multi-active, and unknown/error are not successful completion', () => {
  let items = scopedSubagents([{ session_id: 'one', parent_session_id: 's', status: 'running', subagent: 'worker', result: { secret: 'not UI data' } }, { session_id: 'foreign', parent_session_id: 'other', status: 'completed' }], 's')
  assert.equal(items.length, 1); assert.equal(items[0].result, undefined)
  const event = (type, id, status) => ({ type, sessionId: 's', payload: { subSessionId: id, subagent: 'worker', status } })
  items = mergeSubagentEvent(items, event('subagent.delegated', 'two'), 's')
  assert.equal(subagentProgressSummary(items), '子代理 0/2 · 进行中 2 · 需关注 0')
  items = mergeSubagentEvent(items, event('subagent.settled', 'one', 'error'), 's')
  items = mergeSubagentEvent(items, event('subagent.settled', 'two'), 's')
  assert.equal(subagentProgressSummary(items), '子代理 0/2 · 进行中 0 · 需关注 2')
  assert.equal(mergeSubagentEvent(items, { ...event('subagent.settled', 'one', 'completed'), sessionId: 'foreign' }, 's'), items)
})

test('child refresh and delayed progress events cannot regress a newer terminal or erase a newly delegated sibling', () => {
  const child = { session_id: 'one', parent_session_id: 's', revision: 5, status: 'completed', model: 'm', provider: 'p', runtime: { thinking: '深思', api_key: 'private' } }
  const current = scopedSubagents([child, { ...child, session_id: 'two', revision: 1, status: 'running' }], 's')
  const refreshed = mergeSubagentSnapshot(current, [{ ...child, revision: 3, status: 'running' }], 's')
  assert.equal(refreshed.length, 2); assert.equal(refreshed[0].status, 'completed')
  assert.equal(refreshed[0].runtime.api_key, undefined)
  const stale = { type: 'subagent.progress', sessionId: 's', payload: { subSessionId: 'one', child: { ...child, revision: 4, status: 'running' } } }
  assert.equal(mergeSubagentEvent(current, stale, 's'), current)
  assert.equal(mergeSubagentEvent(current, { ...stale, payload: { ...stale.payload, child: { ...child, session_id: 'foreign', revision: 9 } } }, 's'), current)
})
