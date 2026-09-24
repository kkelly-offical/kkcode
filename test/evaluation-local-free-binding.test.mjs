import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile, symlink, link } from 'node:fs/promises'
import { prepareEvaluationLocalFreeAuthorization, localFreeServiceBindingHash, readEvaluationLocalFreeBinding } from '../evaluation/v1/local-free-authorization.mjs'
import { localFreePolicy } from '../src/usage/local-free.mjs'
import { localFreePolicyId } from '../src/storage/local-free-policy.mjs'

const withId = policy => ({ ...policy, id: localFreePolicyId(policy) })
const fixturePolicy = () => withId({ version: 1, provider: 'evaluation', model: 'binding-fixture', protocol: 'openai',
  baseUrl: 'http://127.0.0.1:12345/v1', scopeHash: '1'.repeat(64), maxRequests: 8, maxTokens: 1000000,
  listener: { pid: 123, uid: 0, fd: 4, inode: '123', startTimeTicks: '456', executable: '/controlled/fixture' } })

test('local service binding excludes only quota/id and keeps every service identity field', () => {
  const original = fixturePolicy(), hash = localFreeServiceBindingHash(original)
  assert.equal(localFreeServiceBindingHash(withId({ ...original, maxRequests: 2, maxTokens: 1000 })), hash)
  for (const change of [{ model: 'other' }, { provider: 'other' }, { protocol: 'responses' }, { baseUrl: 'http://127.0.0.1:12346/v1' },
    { scopeHash: '2'.repeat(64) }, { listener: { ...original.listener, inode: '987' } }, { listener: { ...original.listener, startTimeTicks: '457' } }]) {
    assert.notEqual(localFreeServiceBindingHash(withId({ ...original, ...change })), hash)
  }
  assert.throws(() => localFreeServiceBindingHash({ ...original, model: 'tampered' }), /ID does not match/)
})

test('prior binding reads only a bounded private ordinary receipt, without following links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-evaluation-binding-read-'))
  try {
    const filename = path.join(root, 'authorization.json'), policy = fixturePolicy()
    await writeFile(filename, JSON.stringify({ schema: 'kk.evaluation.authorization.v1', localFreePolicy: policy }), { mode: 0o600 })
    assert.deepEqual(await readEvaluationLocalFreeBinding(filename), policy)
    await link(filename, path.join(root, 'hardlink.json'))
    await assert.rejects(readEvaluationLocalFreeBinding(filename), /bounded private/)
    await rm(path.join(root, 'hardlink.json'))
    if (process.platform !== 'win32') {
      await symlink(filename, path.join(root, 'link.json'))
      await assert.rejects(readEvaluationLocalFreeBinding(path.join(root, 'link.json')))
    }
    await writeFile(filename, 'x'.repeat(65537))
    await assert.rejects(readEvaluationLocalFreeBinding(filename), /bounded private/)
    await writeFile(filename, JSON.stringify({ schema: 'wrong', localFreePolicy: policy }))
    await assert.rejects(readEvaluationLocalFreeBinding(filename), /Not an evaluation/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a reduced new batch retains the original real listener and rejects replacement before any HTTP', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-evaluation-binding-live-'))
  let server, calls = 0, serial = 0
  const openServer = async port => {
    server = createServer((_request, response) => { calls++; response.end('never requested') })
    server.listen(port, '127.0.0.1'); await once(server, 'listening')
  }
  const close = async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null } }
  try {
    await openServer(0)
    const port = server.address().port
    const profile = { providerType: 'openai', model: 'binding-fixture', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: null,
      contextLimit: 131072, maxTokens: 4096, maxSteps: 1, pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
    const prepare = (expectedPolicy = null, limits = { requestLimit: 8, tokenLimit: 1000000 }, config = profile) =>
      prepareEvaluationLocalFreeAuthorization({ profile: config, limits, expectedPolicy, privateRoot: path.join(root, `authorization-${++serial}`) })
    const original = localFreePolicy(await prepare())
    const reduced = localFreePolicy(await prepare(original, { requestLimit: 2, tokenLimit: 500000 }))
    assert.equal(localFreeServiceBindingHash(original), localFreeServiceBindingHash(reduced))
    assert.notEqual(original.id, reduced.id)
    await assert.rejects(prepare(original, { requestLimit: 9, tokenLimit: 1000000 }), /cannot enlarge/)
    await assert.rejects(prepare(original, { requestLimit: 8, tokenLimit: 1000001 }), /cannot enlarge/)
    await assert.rejects(prepare(original, undefined, { ...profile, model: 'different-model' }), { code: 'EVALUATION_LOCAL_SERVICE_CHANGED' })
    await assert.rejects(prepare(withId({ ...original, scopeHash: '3'.repeat(64) })), { code: 'EVALUATION_LOCAL_SERVICE_CHANGED' })
    await close(); await openServer(port)
    await assert.rejects(prepare(original), { code: 'EVALUATION_LOCAL_SERVICE_CHANGED' })
    assert.equal(calls, 0, 'validation makes no inference, token-counting or health request')
  } finally { await close(); await rm(root, { recursive: true, force: true }) }
})
