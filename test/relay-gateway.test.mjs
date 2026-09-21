import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import net from 'node:net'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { connectRelay } from '../src/remote/client.mjs'

const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
test('OIDC PKCE device login, relay routing, private device authorization and disconnect', { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'kkcode-relay-test-'))
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(temp, 'state')
  const idp = Fastify(), port = await freePort(), origin = `http://127.0.0.1:${port}`
  const { publicKey, privateKey } = await generateKeyPair('RS256'), jwk = await exportJWK(publicKey); jwk.kid = 'fixture'
  const grants = new Map(); let issuer
  idp.get('/.well-known/openid-configuration', async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] }))
  idp.get('/jwks', async () => ({ keys: [jwk] }))
  idp.get('/authorize', async (req, reply) => { const code = randomUUID(); grants.set(code, req.query); const url = new URL(req.query.redirect_uri); url.searchParams.set('state', req.query.state); url.searchParams.set('code', code); return reply.redirect(url.href) })
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))))
  idp.post('/token', async (req, reply) => {
    const grant = grants.get(req.body.code); grants.delete(req.body.code)
    if (!grant || createHash('sha256').update(req.body.code_verifier).digest('base64url') !== grant.code_challenge) return reply.code(400).send({ error: 'invalid_grant' })
    return { access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, id_token: await new SignJWT({ nonce: grant.nonce, name: 'Fixture User' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setSubject('owner').setAudience('kkcode').setIssuer(issuer).setIssuedAt().setExpirationTime('5m').sign(privateKey) }
  })
  issuer = await idp.listen({ host: '127.0.0.1', port: 0 })
  const store = new MemoryStore()
  let gateway, service, relay
  try {
    gateway = await createGateway({ origin, issuer, clientId: 'kkcode', clientSecret: 'fixture-secret', store, dev: true, organization: 'QA' })
    await gateway.listen({ host: '127.0.0.1', port })
    const post = (p, body, headers = {}) => fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const flow = await (await post('/auth/device', { kind: 'device', name: 'QA device' })).json()
    const start = await fetch(`${origin}/auth/start?code=${flow.user_code}`, { redirect: 'manual' })
    const stateCookie = start.headers.get('set-cookie').split(';')[0]
    const authorized = await fetch(start.headers.get('location'), { redirect: 'manual' })
    const callback = await fetch(authorized.headers.get('location'), { headers: { Cookie: stateCookie }, redirect: 'manual' })
    assert.equal(callback.status, 200, await callback.clone().text())
    const html = await callback.text(), confirmation = /name="confirmation" value="([^"]+)"/.exec(html)[1]
    const browserCookie = callback.headers.get('set-cookie').split(';')[0]
    assert.equal((await post('/auth/confirm', { code: flow.user_code, confirmation }, { Cookie: browserCookie, Origin: origin })).status, 200)
    const credentials = await (await post('/auth/token', { device_code: flow.device_code })).json()
    assert.equal(credentials.profile.organization, 'QA')
    assert.equal((await post('/auth/token', { device_code: flow.device_code })).status, 400)
    service = await new DeviceService({ cwd: temp, roots: [temp] }).initialize()
    relay = await connectRelay({ service, credentials: { ...credentials, gateway: origin, expiresAt: Date.now() + 3600000 } })
    let found
    for (let i = 0; i < 50; i++) { found = await (await fetch(origin + '/api/v1/devices', { headers: { Cookie: browserCookie } })).json(); if (found[0]?.online) break; await new Promise(r => setTimeout(r, 20)) }
    assert.equal(found[0]?.online, true)
    const result = await (await post(`/api/v1/devices/${service.metadata.id}/rpc`, { id: 'status', method: 'status' }, { Cookie: browserCookie })).json()
    assert.equal(result.result.device.id, service.metadata.id)
    assert.equal((await post(`/api/v1/devices/${service.metadata.id}/rpc`, { id: 'intruder', method: 'status' })).status, 401)
    const hostile = await post(`/api/v1/devices/${service.metadata.id}/rpc`, { id: 'evil', method: 'status' }, { Cookie: browserCookie, Origin: 'https://elsewhere.example' })
    assert.equal(hostile.status, 403)
    relay.close()
    await new Promise(r => setTimeout(r, 50))
    assert.equal((await post(`/api/v1/devices/${service.metadata.id}/rpc`, { id: 'offline', method: 'status' }, { Cookie: browserCookie })).status, 503)
  } finally {
    relay?.close(); await service?.close(); await gateway?.close(); await idp.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(temp, { recursive: true, force: true })
  }
})
