import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { appendMessage, flushNow, configureSessionStore, touchSession, getSession } from '../src/kernel/session/store.mjs'

test('a queued timer cannot create a store lock after an explicit flush resolves', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkcode-flush-fence-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  t.after(async () => {
    t.mock.timers.reset(); t.mock.restoreAll(); syncBuiltinESMExports()
    await flushNow()
    configureSessionStore({ flushIntervalMs: 1000 })
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await fs.rm(root, { recursive: true, force: true })
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  configureSessionStore({ flushIntervalMs: 100 })
  await touchSession({ sessionId: 'flush-fence', mode: 'agent', model: 'fixture' })
  await appendMessage('flush-fence', 'user', 'persist this exactly once')
  const pending = flushNow()
  // Dispatch the scheduled callback while the explicit flush is still queued.
  // The old callback acquires a fresh process lock behind the completed flush.
  t.mock.timers.tick(100)
  await pending
  let lockWrites = 0, dataWrites = 0
  const originalWrite = fs.default?.writeFile || fs.writeFile
  const fsDefault = (await import('node:fs/promises')).default
  t.mock.method(fsDefault, 'writeFile', async (...args) => {
    const file = String(args[0])
    if (file.startsWith(path.join(root, 'sessions') + path.sep)) {
      if (path.basename(file).startsWith('.store.lock.') && file.endsWith('.candidate')) lockWrites++
      else dataWrites++
    }
    return originalWrite(...args)
  })
  syncBuiltinESMExports()
  await new Promise(resolve => setImmediate(resolve))
  // Joining through a read drains previously queued transactions without itself
  // requesting a flush. withLock -> acquireProcessLock still writes a private
  // .store.lock.<pid>.<uuid>.candidate, even when flushUnsafe is a clean no-op.
  await getSession('flush-fence')
  assert.equal(lockWrites, 1, 'only the explicit reader may acquire a new lock; stale timer must not write')
  assert.equal(dataWrites, 0, 'clean reader and fenced timer must not rewrite persisted session data')
  const saved = JSON.parse(await fs.readFile(path.join(root, 'sessions', 'flush-fence.json'), 'utf8'))
  assert.equal(saved.messages.filter(m => m.content === 'persist this exactly once').length, 1)
})
