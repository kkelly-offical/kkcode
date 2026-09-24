import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { beginToolOperation, listToolOperations, resolveToolOperation } from '../src/kernel/tool/operation-journal.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'
import { touchSession, flushNow } from '../src/kernel/session/store.mjs'

const exec = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-codeql-input-')), state = path.join(root, 'state'), cwd = path.join(root, 'workspace'), previous = process.env.KKCODE_HOME
  await mkdir(state); await mkdir(cwd)
  process.env.KKCODE_HOME = state
  t.after(async () => { await flushNow(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  return { root, state, cwd }
}

test('malformed overlapping env policy key finishes within a child-process deadline and stays fail-closed', { timeout: 10000 }, async t => {
  const { state, cwd } = await fixture(t)
  // The old repeated suffix regex needs exponential work here. Running the real
  // loader in a disposable child ensures a regression is killed, not a hung CI.
  await writeFile(path.join(state, '.env'), `KKCODE_DATA_POLICY__${'0__'.repeat(1024)}!=private-fixture-canary\n`)
  await writeFile(path.join(cwd, '.env'), 'KKCODE_LANGUAGE=zh\n')
  const source = `import { loadConfig } from ${JSON.stringify(new URL('../src/config/load-config.mjs', import.meta.url).href)};
    const start = performance.now(); const state = await loadConfig(process.argv[1]);
    console.log(JSON.stringify({ providers: state.config.data_policy.providers, web: state.config.data_policy.web_origins,
      errors: state.errors.length, leaked: state.errors.some(value => value.includes('private-fixture-canary')), elapsed: performance.now() - start }));`
  const child = await exec(process.execPath, ['--input-type=module', '-e', source, cwd], { timeout: 5000, maxBuffer: 16384,
    env: { ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]])), KKCODE_HOME: state } })
  const result = JSON.parse(child.stdout)
  assert.deepEqual(result.providers, []); assert.deepEqual(result.web, [])
  assert.ok(result.errors); assert.equal(result.leaked, false)
  assert.ok(result.elapsed < 4000)
  t.diagnostic(`Malformed 3 KiB policy declaration rejected in ${Math.ceil(result.elapsed)} ms by the real loader`)
})

test('operation journal uses the complete whitelist basename and preserves existing valid filenames', async t => {
  const { state } = await fixture(t), sessionId = 'legacy_session-123'
  const operation = await beginToolOperation({ sessionId, turnId: 'turn', tool: 'fixture_mutation', args: {} })
  await operation.finish('uncertain')
  const filename = path.join(state, 'operations', `${sessionId}.json`)
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).operations[0].id, operation.id)
  const before = await readdir(path.dirname(filename))
  for (const invalid of ['../outside', '..\\outside', '/tmp/outside', 'C:\\outside', '..', 'valid\n', 'valid\r', 'valid\r\n', 'valid\u2028', 'valid\u2029', 'A'.repeat(129), '%2e%2e%2foutside', ['valid'], { toString: () => 'valid' }]) {
    await assert.rejects(listToolOperations(invalid), /Invalid session identifier/)
    await assert.rejects(beginToolOperation({ sessionId: invalid, turnId: 'turn', tool: 'fixture_mutation', args: {} }), /Invalid session identifier/)
    await assert.rejects(resolveToolOperation(invalid, operation.id, true), /Invalid session identifier/)
  }
  assert.deepEqual(await readdir(path.dirname(filename)), before)
  assert.equal((await listToolOperations(sessionId))[0].state, 'uncertain')
  assert.equal((await listToolOperations(sessionId))[0].fingerprint, undefined)
})

test('authenticated RPC cannot inject journal paths and still fences genuine uncertain operations', async t => {
  const { root, state, cwd } = await fixture(t)
  const service = await new DeviceService({ cwd, roots: [cwd] }).initialize()
  const server = await createDeviceServer({ service, closeService: false, port: 0, bootstrapToken: 'journal-fixture-login' })
  t.after(async () => { await server.close(); await service.close() })
  const sessionId = 'rpc-journal-fixture'
  await touchSession({ sessionId, cwd, providerType: 'fixture', model: 'fixture', mode: 'agent' })
  const operation = await beginToolOperation({ sessionId, turnId: 'turn', tool: 'fixture_mutation', args: {} })
  await operation.finish('uncertain')
  const outside = path.join(root, 'outside.json'), canary = 'OUTSIDE_JOURNAL_CANARY'
  await writeFile(outside, JSON.stringify({ version: 1, operations: [{ id: canary, state: 'uncertain' }] }), { mode: 0o600 })
  const { address } = await server.listen()
  const post = (url, payload, token) => fetch(address + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) })
  const login = await post('/api/v1/auth/pair', { bootstrap: 'journal-fixture-login', native: true })
  const token = (await login.json()).token
  assert.ok(token)
  const files = await readdir(path.join(state, 'operations'))
  for (const supplied of ['../outside', '../../outside', '..\\..\\outside', outside.slice(0, -5), 'rpc-journal-fixture\n', 'rpc-journal-fixture\u2028', { path: outside }, ['rpc-journal-fixture']]) {
    const result = await post('/api/v1/rpc', { id: randomUUID(), method: 'artifacts.prune', params: { sessionId: supplied, confirmed: true } }, token)
    assert.ok(result.status >= 400)
    assert.doesNotMatch(await result.text(), /OUTSIDE_JOURNAL_CANARY/)
  }
  const result = await post('/api/v1/rpc', { id: randomUUID(), method: 'artifacts.prune', params: { sessionId, confirmed: true } }, token)
  assert.equal(result.status, 409)
  assert.match(await result.text(), /artifact_unresolved/)
  assert.deepEqual(await readdir(path.join(state, 'operations')), files)
  assert.equal(JSON.parse(await readFile(outside, 'utf8')).operations[0].id, canary)
})
