import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRewindToUi } from '../src/repl/rewind-ui.mjs'

test('slash and keyboard rewind apply the same transcript removal and restore the draft', () => {
  const items = [{ id: 'old', kind: 'user' }, { id: 'answer', kind: 'assistant' }, { id: 'last', kind: 'user' }, { id: 'tool', kind: 'tool' }, { id: 'reply', kind: 'assistant' }]
  const removed = [], ui = { input: '', inputCursor: 0, scrollOffset: 7 }
  const transcript = { getItems: () => items, removeLog: id => removed.push(id) }
  assert.equal(applyRewindToUi({ ok: true, prompt: 'Try again' }, { ui, transcript }), true)
  assert.deepEqual(removed, ['last', 'tool', 'reply'])
  assert.deepEqual(ui, { input: 'Try again', inputCursor: 9, scrollOffset: 0 })
})

test('missing or unsuccessful rewind results cannot clear visible content', () => {
  const ui = { input: 'unchanged' }, transcript = { getItems() { throw new Error('must not read') } }
  assert.equal(applyRewindToUi(undefined, { ui, transcript }), false)
  assert.equal(applyRewindToUi({ ok: false }, { ui, transcript }), false)
  assert.equal(ui.input, 'unchanged')
})
