import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, link, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDeviceServer } from '../src/device/server.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { getConversationHistory, touchSession, appendUserMessage, flushNow } from '../src/kernel/session/store.mjs'
import { writePrivateFile } from '../src/storage/private-file.mjs'

const invalidIds = ['../outside', '..\\outside', '/outside', 'C:\\outside', 'C:/outside', '\\\\server\\share\\outside', '//server/share/outside', '%2e%2e%2foutside', '%252e%252e%252foutside', 'safe/../../outside', '.', '..', '', 'safe\0', 'safe\n', 'safe\r', 'safe\r\n', 'safe\u2028', 'safe\u2029', 'safe\u2215outside', 'safe\uff0foutside', 'a'.repeat(129), '__proto__', 'constructor', 'prototype']
const canonicalReserved = new Set(['__proto__', 'constructor', 'prototype'])
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-codeql-path-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const workspace = path.join(root, 'workspace'), canary = path.join(root, 'outside.json')
  await mkdir(workspace)
  await writeFile(canary, JSON.stringify({ messages: [{ role: 'user', content: 'OUTSIDE_CANARY_NOT_REMOTE_HISTORY' }], parts: [] }))
  t.after(async () => {
    try { await flushNow() } finally { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous }
    await rm(root, { recursive: true, force: true })
  })
  return { root, workspace, canary, state: process.env.KKCODE_HOME }
}

test('canonical session paths reject traversal, device paths, encoded separators, terminal newlines and non-string IDs before reads', async t => {
  const f = await fixture(t), before = await readFile(f.canary, 'utf8')
  for (const sessionId of [...invalidIds, null, 1, [], {}]) {
    await assert.rejects(getConversationHistory(sessionId), { code: 'invalid_session' }, `Rejected ${JSON.stringify(sessionId)}`)
    await assert.rejects(touchSession({ sessionId, cwd: f.workspace, mode: 'assistant', model: 'fixture', providerType: 'fixture' }), { code: 'invalid_session' })
  }
  assert.equal(await readFile(f.canary, 'utf8'), before)
  await touchSession({ sessionId: 'safe_123-ID', cwd: f.workspace, mode: 'assistant', model: 'fixture', providerType: 'fixture' })
  await appendUserMessage('safe_123-ID', 'Inside canonical root')
  assert.equal((await getConversationHistory('safe_123-ID'))[0].content, 'Inside canonical root')
})

test('authenticated HTTP requests cannot pass malicious session IDs to canonical/replay sinks; valid replay rotation stays inside state', { timeout: 15000 }, async t => {
  const f = await fixture(t), service = await new DeviceService({ cwd: f.workspace, roots: [f.workspace] }).initialize()
  const server = await createDeviceServer({ service, port: 0, bootstrapToken: 'path-guard-fixture' })
  try {
    // A deliberately poisoned local index forces sessions.configure all the way
    // to the canonical shard resolver. Even existing metadata must not bypass it.
    await mkdir(path.join(f.state, 'sessions'), { recursive: true })
    await writeFile(path.join(f.state, 'sessions', 'index.json'), JSON.stringify({ version: 2, sessions: Object.fromEntries(invalidIds.map(id => [id, { id, cwd: f.workspace }])) }))
    const { address } = await server.listen()
    const post = (route, body, token) => fetch(address + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    assert.equal((await post('/api/v1/rpc', { id: 'unauthenticated', method: 'events.list', params: { sessionId: '../outside' } })).status, 401)
    const pairing = await post('/api/v1/auth/pair', { bootstrap: 'path-guard-fixture', native: true }), token = (await pairing.json()).token
    let sequence = 0
    const rpc = (method, params) => post('/api/v1/rpc', { id: `request-${++sequence}`, method, params }, token)
    for (const sessionId of invalidIds) {
      assert.equal((await rpc('control.acquire', { sessionId })).status, 200)
      for (const method of ['sessions.configure', 'sessions.get', 'events.list']) {
        const response = await rpc(method, { sessionId }), body = await response.text()
        // Replay uses Map keys and prefixed filenames, so object-prototype
        // names are safe there; the canonical object-index additionally rejects
        // them. Neither spelling contains a path separator or escapes its root.
        if (method === 'events.list' && canonicalReserved.has(sessionId)) {
          assert.equal(response.status, 200)
          assert.deepEqual(JSON.parse(body).result.events, [])
        } else assert.ok(response.status >= 400, `${method} must reject ${JSON.stringify(sessionId)}`)
        assert.ok(!body.includes('OUTSIDE_CANARY'), 'remote response must not expose the outside file')
      }
    }
    const time = Date.now()
    service.replay.now = () => time
    await service.record({ type: 'stream.text.delta', sessionId: 'valid-replay', payload: { text: 'inside' } })
    service.replay.now = () => time + 8 * 86400000
    const rotated = await rpc('events.list', { sessionId: 'valid-replay' })
    assert.equal(rotated.status, 200)
    assert.deepEqual((await rotated.json()).result.events, [])
    assert.equal(await readFile(path.join(f.state, 'device', 'events-valid-replay.jsonl'), 'utf8'), '')
    assert.equal(JSON.parse(await readFile(path.join(f.state, 'device', 'cursor-valid-replay.json'), 'utf8')).cursor, 1)
    assert.ok(!(await readdir(path.join(f.state, 'device'))).some(name => name.endsWith('.tmp')))
    assert.match(await readFile(f.canary, 'utf8'), /OUTSIDE_CANARY_NOT_REMOTE_HISTORY/)
    assert.deepEqual((await readdir(f.root)).sort(), ['outside.json', 'state', 'workspace'])
  } finally { await server.close() }
})

test('private atomic writes replace a hard-linked leaf without overwriting its external inode', async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'private.json'), before = await readFile(f.canary, 'utf8')
  await link(f.canary, file)
  await writePrivateFile(file, 'local replacement')
  assert.equal(await readFile(file, 'utf8'), 'local replacement')
  assert.equal(await readFile(f.canary, 'utf8'), before)
})

test('private atomic writes replace a symbolic-link leaf without following the external target', { skip: process.platform === 'win32' ? 'Windows file symlink creation requires additional OS privilege' : false }, async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'private.json'), before = await readFile(f.canary, 'utf8')
  await symlink(f.canary, file)
  await writePrivateFile(file, 'local replacement')
  assert.equal((await lstat(file)).isSymbolicLink(), false)
  assert.equal(await readFile(file, 'utf8'), 'local replacement')
  assert.equal(await readFile(f.canary, 'utf8'), before)
})
