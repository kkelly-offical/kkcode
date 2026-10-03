import test from 'node:test'
import assert from 'node:assert/strict'
import {emptyTodoSnapshot, reduceTodoSnapshot} from '../src/kernel/session/todo-state.mjs'
import {continuationIndex} from '../src/kernel/session/continuation-state.mjs'
import {childHandoff} from '../src/kernel/orchestration/child-handoff.mjs'

test('incremental replanning preserves other work, cancellation reasons and revision guards', () => {
  const options = {sessionId: 'owner', now: 1}
  const initial = reduceTodoSnapshot(emptyTodoSnapshot('owner'), {expectedRevision: 0, todos: [
    {content: 'Implement backend', status: 'in_progress'}, {content: 'Implement frontend', status: 'pending'}
  ]}, options)
  const revised = reduceTodoSnapshot(initial, {mode: 'merge', expectedRevision: 1, todos: [
    {id: initial.items[0].id, content: initial.items[0].content, status: 'blocked', reason: 'Waiting for schema decision'}
  ]}, {...options, now: 2})
  assert.equal(revised.items[1].status, 'pending')
  assert.equal(revised.items[0].reason, 'Waiting for schema decision')
  const cancelled = reduceTodoSnapshot(revised, {mode: 'merge', expectedRevision: 2, todos: [{id: revised.items[1].id, content: revised.items[1].content, status: 'cancelled', reason: 'User deferred the UI'}]}, {...options, now: 3})
  assert.equal(cancelled.items[0].status, 'blocked')
  assert.equal(cancelled.items[1].reason, 'User deferred the UI')
  assert.throws(() => reduceTodoSnapshot(cancelled, {mode: 'merge', expectedRevision: 1, todos: []}, options), /revision changed/)
  assert.throws(() => reduceTodoSnapshot(cancelled, {mode: 'merge', expectedRevision: 3, todos: [{id: 'foreign', content: 'invented', status: 'completed'}]}, options), /does not belong/)
})

test('compaction continuation keeps bounded host locators without copying outputs or claiming live process status', () => {
  const todos = reduceTodoSnapshot(emptyTodoSnapshot('owner'), {expectedRevision: 0, todos: [{content: 'Finish the backend', status: 'in_progress'}]}, {sessionId: 'owner', now: 1})
  const text = continuationIndex({session: {id: 'owner'}, parts: [
    {type: 'todo.updated', snapshot: todos},
    {type: 'tool-call', tool: 'bash', status: 'completed', output: 'PRIVATE_OUTPUT_BODY', args: {env: {TOKEN: 'PRIVATE_TOKEN'}}, metadata: {backgroundTask: {id: 'bg_owned', parentSessionId: 'owner', status: 'pending'}}},
    {type: 'tool-call', tool: 'write', status: 'completed', metadata: {fileChanges: [{path: 'src/app.mjs'}]}},
    {type: 'tool-call', tool: 'bash', status: 'error', metadata: {outcomeUnknown: true, operationId: 'unresolved'}}
  ]})
  assert.match(text, /Finish the backend/)
  assert.match(text, /bg_owned/)
  assert.match(text, /task_output/)
  assert.match(text, /unresolved/)
  assert.match(text, /src\/app.mjs/)
  assert.doesNotMatch(text, /PRIVATE_OUTPUT_BODY|PRIVATE_TOKEN/)
})

test('child handoff keeps actual checks, blockers and worktree delivery distinct from prose', () => {
  const result = childHandoff({status: 'incomplete', reply: 'Everything is finished!', file_changes: [{path: 'src/x.mjs'}],
    verification: {state: 'needs_verification', checks: [{label: 'npm test', status: 'failed'}], failures: [{kind: 'failed_check'}]},
    worktree_preserved: true, worktree_path: '/workspace/review-copy'}, {cwd: '/workspace/review-copy'})
  assert.equal(result.status, 'incomplete')
  assert.equal(result.checks[0].status, 'failed')
  assert.equal(result.worktree.applied, false)
  assert.match(result.next_action, /parent files have not been updated/)
  assert.doesNotMatch(JSON.stringify(result), /Everything is finished/)
})
