import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { identityHash } from '../src/remote/identity.mjs'
import { ANDROID_LOGIN_RETURN, nativeLoginRequest, nativeLoginProof, nativeLoginReturn } from '../src/remote/native-login.mjs'

const verifier = 'v'.repeat(43), state = 's'.repeat(43)
const native = { platform: 'android', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }
async function fixture(run) {
  const store = new MemoryStore(), account = { id: 'owner', name: 'Owner', organization: 'QA' }
  await store.put('account:owner', account)
  await store.put('identity-session:browser', { id: 'browser', accountId: 'owner', kind: 'client', expires: Date.now() + 60000 })
  await store.put(`token:${identityHash('fixture-browser')}`, { sessionId: 'browser', account, kind: 'client', expires: Date.now() + 60000 })
  const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', clientId: 'test', dev: true, oidcConfig: {}, store, organization: 'QA' })
  const request = (url, payload, authenticated = false) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url,
    headers: { host: 'localhost', ...(authenticated ? { authorization: 'Bearer fixture-browser' } : {}) }, ...(payload === undefined ? {} : { payload }) })
  async function prepare(body = { name: 'KK Code Android', kind: 'client', native }) {
    const response = await request('/auth/device', body)
    assert.equal(response.statusCode, 200)
    const flow = response.json(), key = `login-code:${identityHash(flow.device_code)}`
    await store.put(key, { ...await store.get(key), account, confirmation: identityHash('fixture-confirmation') })
    return { flow, key, proof: { device_code: flow.device_code, code_verifier: verifier }, confirm: () => request('/auth/confirm', { code: flow.user_code, confirmation: 'fixture-confirmation' }, true) }
  }
  try { await run({ app, store, request, prepare }) } finally { await app.close() }
}

test('native capability uses one fixed return address with required S256 proof', () => fixture(async ({ request }) => {
  const capability = (await request('/api/v1/discovery')).json().authentication.nativeLogin
  assert.deepEqual(capability, { version: 1, platform: 'android', redirectUri: ANDROID_LOGIN_RETURN, pkce: 'S256' })
  const login = await request('/login')
  assert.equal(login.headers['referrer-policy'], 'same-origin', 'form navigation must not turn same-origin POSTs into Origin:null')
  assert.equal(login.headers['cache-control'], 'no-store')
}))

test('malformed native requests and arbitrary return addresses cannot create a grant', () => fixture(async ({ request, store }) => {
  for (const body of [
    { kind: 'device', native }, { kind: 'client', native: null }, { kind: 'client', native: { ...native, platform: 'web' } },
    { kind: 'client', native: { ...native, state: `${state}\n` } }, { kind: 'client', native: { ...native, code_challenge_method: 'plain' } },
    { kind: 'client', native: { ...native, code_challenge: 'short' } }, { kind: 'client', native: { ...native, redirect_uri: 'https://evil.invalid' } },
    { kind: 'client', native, return_uri: 'https://evil.invalid' }, { kind: 'client', return_url: 'https://evil.invalid' },
    { kind: 'client', redirect_uri: ANDROID_LOGIN_RETURN }
  ]) assert.equal((await request('/auth/device', body)).statusCode, 400)
  assert.equal((await store.list('login-code:')).length, 0)
}))

test('Android confirmation returns to the App without tokens or a WebUI primary action', () => fixture(async ({ prepare }) => {
  const { flow, confirm } = await prepare()
  assert.equal(flow.native_return, true)
  const response = await confirm()
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /Device approved/)
  assert.match(response.body, /返回 KK Code App/)
  assert.match(response.body, /window\.location\.assign/)
  const script = response.body.match(/<script nonce="[^"]+">([^<]+)<\/script>/)?.[1]
  assert.equal(script, "setTimeout(function(){window.location.assign(document.getElementById('return-app').href)},150)")
  assert.ok(!script.includes(state), 'transaction data never becomes JavaScript source')
  assert.match(response.body, new RegExp(`cn\\.kkcode\\.remote://auth/complete\\?state=${state}`))
  assert.doesNotMatch(response.body, /Open WebUI|access_token|refresh_token|device_code|code_verifier/)
  assert.ok(!response.body.includes(flow.device_code))
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['referrer-policy'], 'no-referrer')
  assert.match(response.headers['content-security-policy'], /script-src 'nonce-/)
}))

test('native proof failures never consume a grant and browser exchange cannot bypass proof', () => fixture(async ({ prepare, request, store }) => {
  const { proof, key, confirm } = await prepare(); await confirm()
  for (const candidate of [{ device_code: proof.device_code }, { ...proof, code_verifier: 'x'.repeat(43) }, { ...proof, browser: true }]) {
    const result = await request('/auth/token', candidate)
    assert.equal(result.statusCode, 400); assert.equal(result.json().error, 'invalid_grant')
    assert.ok(await store.get(key))
  }
  const result = await request('/auth/token', proof)
  assert.equal(result.statusCode, 200); assert.ok(result.json().access_token)
  assert.equal((await request('/auth/token', proof)).json().error, 'expired_token')
}))

test('native polling waits for explicit confirmation and respects the existing interval', () => fixture(async ({ prepare, request }) => {
  const { proof } = await prepare()
  assert.equal((await request('/auth/token', proof)).json().error, 'authorization_pending')
  assert.equal((await request('/auth/token', proof)).json().error, 'slow_down')
}))

test('native cancellation requires proof, is idempotent and prevents later confirmation', () => fixture(async ({ prepare, request, store }) => {
  const { proof, key, confirm } = await prepare()
  assert.equal((await request('/auth/cancel', { device_code: proof.device_code })).statusCode, 400)
  assert.equal((await request('/auth/cancel', proof)).statusCode, 200)
  assert.equal((await request('/auth/cancel', proof)).statusCode, 200)
  assert.equal((await request('/auth/token', proof)).json().error, 'access_denied')
  assert.equal((await confirm()).statusCode, 403)
  assert.ok((await store.get(key)).denied)
}))

test('valid SSO denial returns to Android while forged OAuth state cannot redirect', () => fixture(async ({ prepare, store, app, request }) => {
  const { flow, proof } = await prepare()
  const oidcState = 'fixture-oidc-state'
  await store.put(`oidc-flow:${identityHash(oidcState)}`, { code: flow.user_code, expires: Date.now() + 60000 })
  const forged = await request(`/auth/callback?state=${oidcState}&error=access_denied`)
  assert.equal(forged.statusCode, 400); assert.doesNotMatch(forged.body, /cn\.kkcode\.remote:/)
  const response = await app.inject({ url: `/auth/callback?state=${oidcState}&error=access_denied`, headers: { host: 'localhost', cookie: `kkcode_oauth_state=${oidcState}` } })
  assert.equal(response.statusCode, 200); assert.match(response.body, /Login cancelled/); assert.match(response.body, /返回 KK Code App/)
  assert.equal((await request('/auth/token', proof)).json().error, 'access_denied')
}))

test('legacy CLI and Web grants remain compatible and never gain native redirection', () => fixture(async ({ prepare, request }) => {
  for(const kind of ['device', 'client']) {
    const { flow, confirm } = await prepare({ kind, name: 'Legacy client' })
    assert.equal(flow.native_return, undefined)
    const response = await confirm()
    assert.match(response.body, /Open WebUI/); assert.doesNotMatch(response.body, /cn\.kkcode\.remote:/)
    const exchanged = await request('/auth/token', { device_code: flow.device_code, ...(kind === 'client' ? { browser: true } : {}) })
    assert.equal(exchanged.statusCode, 200)
    if(kind === 'client') { assert.equal(exchanged.json().authenticated, true); assert.equal(exchanged.json().access_token, undefined) }
    else assert.ok(exchanged.json().access_token)
  }
}))

test('failed SSO code validation ends native polling and offers safe App return without issuing credentials', () => fixture(async ({ prepare, store, app, request }) => {
  const { flow, proof } = await prepare()
  const oidcState = 'fixture-oidc-failure'
  await store.put(`oidc-flow:${identityHash(oidcState)}`, { code: flow.user_code, verifier, nonce: 'fixture-nonce', expires: Date.now() + 60000 })
  // The deliberately invalid fixture OIDC config cannot validate/exchange a code.
  const response = await app.inject({ url: `/auth/callback?state=${oidcState}&code=invalid-fixture-code`, headers: { host: 'localhost', cookie: `kkcode_oauth_state=${oidcState}` } })
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /Login could not be completed/)
  assert.match(response.body, /返回 KK Code App/)
  assert.doesNotMatch(response.body, /invalid-fixture-code|access_token|refresh_token|Device approved/)
  assert.equal((await request('/auth/token', proof)).json().error, 'authorization_failed')
  assert.equal((await store.list('identity-session:')).length, 1, 'only the fixture browser session exists')
}))

test('native helpers reject tampered records and never interpolate an untrusted URL', () => {
  assert.equal(nativeLoginRequest({ kind: 'client' }), undefined)
  assert.equal(nativeLoginProof({}, {}), true)
  assert.equal(nativeLoginReturn({ native: { platform: 'android', state: '"><script>' } }), null)
  assert.equal(nativeLoginProof({ native: { challenge: 'bad' } }, { code_verifier: verifier }), false)
})
