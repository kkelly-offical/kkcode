import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createChildInbox } from '../src/kernel/orchestration/child-inbox.mjs'
import { EventBus } from '../src/kernel/core/events.mjs'
import { touchSession, flushNow, getSession } from '../src/kernel/session/store.mjs'

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-child-inbox-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  await touchSession({ sessionId: 'parent', cwd: root })
  const row = { session_id: 'child', parent_session_id: 'parent', operation_id: 'operation', background: true, status: 'running', started_at: Date.now(), result: null }
  const rows = [row], controller = { list: async () => structuredClone(rows) }, baseline = EventBus.listenerCount()
  const inbox = createChildInbox({ controller, sessionId: 'parent', turnId: 'turn', startedAt: row.started_at, ...options })
  await inbox.initialize()
  t.after(async () => { inbox.close(); assert.equal(EventBus.listenerCount(), baseline); await flushNow(); if(previous === undefined)delete process.env.KKCODE_HOME;else process.env.KKCODE_HOME=previous; await rm(root,{recursive:true,force:true}) })
  return { inbox, row, rows, controller }
}
const signalReport = sessionId => EventBus.emit({ type: 'task.settled', sessionId, payload: { id: 'task' } })

test('foreign and unrelated completion events do not resume inference; actual reports are delivered once across inbox recreation', async t => {
  const f = await fixture(t)
  let resumed = false
  const waiting = f.inbox.wait().then(() => { resumed = true })
  await signalReport('foreign'); await signalReport('parent')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(resumed, false)
  f.row.status = 'completed'; f.row.result = { reply: 'Actual child result' }
  await signalReport('parent'); await waiting
  assert.equal(await f.inbox.deliver(), 1)
  assert.equal(await f.inbox.deliver(), 0)
  f.inbox.close()
  const restored = createChildInbox({ controller: f.controller, sessionId: 'parent', turnId: 'turn', startedAt: f.row.started_at })
  try {
    await restored.initialize(); assert.equal(await restored.deliver(), 0)
    assert.equal((await getSession('parent')).messages.filter(message => message.childReports).length, 1)
  } finally { restored.close() }
})

test('user cancellation breaks a parked parent promptly without completing or restarting its child', async t => {
  const abort = new AbortController(), f = await fixture(t, { signal: abort.signal })
  const waiting = f.inbox.wait()
  abort.abort(new DOMException('User stopped', 'AbortError'))
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(f.row.status, 'running')
  assert.equal((await getSession('parent')).messages.length, 0)
})

test('parked parent observes steering and hard deadline without polling child results for timeouts', async t => {
  let input = false
  const f = await fixture(t, { hasPendingInput: async () => input })
  const waiting = f.inbox.wait()
  input = true
  assert.ok(['input', 'ready'].includes(await waiting))
  f.inbox.close()
  const deadline = createChildInbox({ controller: f.controller, sessionId: 'parent', turnId: 'deadline', startedAt: f.row.started_at, deadlineAt: Date.now() + 20 })
  try { await deadline.initialize(); assert.equal(await deadline.wait(), 'deadline') }
  finally { deadline.close() }
})
