import test from "node:test"
import assert from "node:assert/strict"
import { renderTaskProgressPanel, loadTodoProgress } from "../src/ui/repl-task-panel.mjs"

test("renderTaskProgressPanel delegates to formatter", () => {
  const lines = renderTaskProgressPanel({ a: { status: "completed" } }, () => ["ok"])
  assert.deepEqual(lines, ["ok"])
})

test('new CLI sessions without a persisted shard have no todo panel; storage failures stay explicit', async () => {
  assert.equal(await loadTodoProgress({}, 's'), null)
  assert.equal(await loadTodoProgress({ todos: { list: async () => { throw Object.assign(new Error('missing'), { code: 'session_not_found' }) } } }, 's'), null)
  await assert.rejects(loadTodoProgress({ todos: { list: async () => { throw new Error('storage failure') } } }, 's'), /storage failure/)
  const value = { sessionId: 's', revision: 1, items: [] }
  assert.equal(await loadTodoProgress({ todos: { list: async id => { assert.equal(id, 's'); return value } } }, 's'), value)
})
