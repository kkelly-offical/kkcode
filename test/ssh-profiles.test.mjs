import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { MemoryStore } from '../src/remote/store.mjs'
import { registerSshProfiles, validateSshProfile } from '../src/remote/ssh-profiles.mjs'

const profile = { id: 'one', name: '主机一', host: '10.0.0.2', username: 'alice', hostKey: 'SHA256:' + 'A'.repeat(43) }
test('SSH address books are account scoped, secret-free and optimistic-concurrency protected', async t => {
  const app = Fastify(), store = new MemoryStore()
  registerSshProfiles({ app, store, authenticate: async req => ({ account: { id: req.headers['x-account'] || 'alice', organization: 'org' } }) })
  t.after(() => app.close())
  const request = (url, body, user = 'alice') => app.inject({ url, method: body ? 'POST' : 'GET', headers: { 'x-account': user }, ...(body ? { payload: body } : {}) })
  assert.deepEqual((await request('/api/v1/connections/ssh')).json(), { revision: 0, items: [] })
  const saved = await request('/api/v1/connections/ssh', { revision: 0, connection: profile })
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().items[0].name, '主机一')
  assert.equal((await request('/api/v1/connections/ssh', null, 'bob')).json().items.length, 0)
  assert.equal((await request('/api/v1/connections/ssh', { revision: 0, connection: profile })).statusCode, 409)
  assert.equal((await request('/api/v1/connections/ssh', { revision: 1, connection: { ...profile, privateKey: 'private' } })).statusCode, 400)
  const changed = await request('/api/v1/connections/ssh', { revision: 1, connection: { ...profile, host: 'other.example' } })
  assert.equal(changed.json().items[0].hostKey, '')
  const removed = await request('/api/v1/connections/ssh/one/delete', { revision: 2 })
  assert.equal(removed.json().items.length, 0)
  assert.ok(!(JSON.stringify(await store.list('ssh-profiles:'))).includes('privateKey'))
})
test('SSH metadata validates targets without initiating any network access', () => {
  for (const host of ['https://example.com', 'user@example.com', '-oProxyCommand=x', 'example.com/path', 'bad\nname']) assert.throws(() => validateSshProfile({ ...profile, host }))
  assert.equal(validateSshProfile({ ...profile, host: '2001:db8::1' }).port, 22)
  for (const patch of [{ password: 'x' }, { port: 0 }, { username: 'a b' }, { hostKey: 'trust-me' }]) assert.throws(() => validateSshProfile({ ...profile, ...patch }))
})
