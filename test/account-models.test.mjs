import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { MemoryStore } from '../src/remote/store.mjs'
import { registerAccountModels } from '../src/remote/account-models.mjs'
test('account model templates are private, encrypted, versioned, and copied as independent data', async () => {
  const app = Fastify(), store = new MemoryStore(), secret = 'model-key-never-stored-plain'
  registerAccountModels({ app, store, origin: 'https://gateway.invalid', encryptionKey: Buffer.alloc(32, 7).toString('base64'), authenticate: async req => { if(!req.headers.authorization) throw Object.assign(new Error('Login required'), {statusCode: 401}); return { account: { id: req.headers.authorization } } } })
  const request = (account, method, path, payload) => app.inject({method, url: '/api/v1/account/models' + path, headers: account ? {authorization: account} : {}, payload})
  try {
    assert.equal((await request(null, 'GET', '')).statusCode, 401)
    const saved = await request('alice', 'POST', '', { revision: 0, provider: { team: { type: 'openai', base_url: 'https://models.invalid/v1', api_key: secret, api_key_env: '', default_model: 'sample' } } })
    assert.equal(saved.statusCode, 200); assert.equal(saved.json().provider.team.api_key, '[REDACTED]')
    assert.ok(!JSON.stringify(await store.list('account-models:')).includes(secret))
    assert.deepEqual((await request('bob', 'GET', '')).json().provider, {})
    const copy = (await request('alice', 'POST', '/resolve', {})).json()
    assert.equal(copy.provider.team.api_key, secret)
    assert.equal((await request('alice', 'POST', '', {revision:0, provider:{}})).statusCode,409)
    await request('alice', 'POST', '', {revision:1, provider:{team:{default_model:'next',api_key:'[REDACTED]'}}})
    assert.equal(copy.provider.team.default_model, 'sample', 'an earlier copy remains independent')
    const latest = (await request('alice', 'POST', '/resolve', {})).json()
    assert.equal(latest.provider.team.api_key, secret); assert.equal(latest.provider.team.default_model,'next')
    assert.equal((await request('alice','GET','')).headers['cache-control'],'no-store')
  } finally { await app.close() }
})
