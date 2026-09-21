import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { touchSession, appendUserMessage, getSession, flushNow, configureSessionStore } from '../src/kernel/session/store.mjs'

test('deferred writes remain bound to the storage root where they were created', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-store-roots-')), previous = process.env.KKCODE_HOME
  const first = path.join(root, 'first'), second = path.join(root, 'second')
  configureSessionStore({ flushIntervalMs: 60000 })
  try {
    process.env.KKCODE_HOME = first
    await touchSession({ sessionId: 'one', mode: 'agent', model: 'fixture', providerType: 'fixture', cwd: root })
    await appendUserMessage('one', 'first root only')
    process.env.KKCODE_HOME = second
    await touchSession({ sessionId: 'two', mode: 'agent', model: 'fixture', providerType: 'fixture', cwd: root })
    await appendUserMessage('two', 'second root only')
    assert.equal(await getSession('one'), null)
    assert.equal((await getSession('two')).messages[0].content, 'second root only')
    process.env.KKCODE_HOME = first
    assert.equal(await getSession('two'), null)
    assert.equal((await getSession('one')).messages[0].content, 'first root only')
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(first, 'sessions', 'index.json'), 'utf8')).sessions), ['one'])
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(second, 'sessions', 'index.json'), 'utf8')).sessions), ['two'])
  } finally {
    for (const directory of [first, second]) { process.env.KKCODE_HOME = directory; await flushNow() }
    configureSessionStore({ flushIntervalMs: 1000 })
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
