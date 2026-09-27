import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { awaitAbortable, isCancellation } from '../src/abort.mjs'

test('shared preparation abort observes late rejection and removes its listener', async () => {
  const controller = new AbortController()
  let reject
  const shared = new Promise((_, fail) => { reject = fail })
  const pending = awaitAbortable(shared, controller.signal)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  reject(new Error('late shared failure'))
  await new Promise(resolve => setImmediate(resolve))
})

test('shared preparation resolve/failure and already-aborted signals clean up', async () => {
  const controller = new AbortController()
  assert.equal(await awaitAbortable(Promise.resolve(42), controller.signal), 42)
  await assert.rejects(awaitAbortable(Promise.reject(new Error('failed')), controller.signal), /failed/)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(isCancellation(new DOMException('provider timeout', 'AbortError'), controller.signal), false)
  controller.abort()
  await assert.rejects(awaitAbortable(Promise.resolve(42), controller.signal), { name: 'AbortError' })
  assert.equal(await awaitAbortable(Promise.resolve(42)), 42)
  assert.equal(isCancellation(new Error('ordinary error')), false)
  assert.equal(isCancellation(new DOMException('cancel', 'AbortError')), true)
  assert.equal(isCancellation(null, controller.signal), true)
})
