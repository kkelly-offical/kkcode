import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loginMcpOAuth, createMcpOAuthProvider } from '../src/kernel/mcp/oauth.mjs'
import { createSdkMcpClient } from '../src/kernel/mcp/client-sdk.mjs'
import { startOfficialHttpFixture } from './fixtures/official-mcp-server.mjs'

test('real MCP OAuth uses PKCE/state/issuer, encrypted persistence and refresh without reopening login', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-mcp-auth-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  const upstream = await startOfficialHttpFixture({ modern: true })
  let base, challenge, expected = 'fixture-access-one', exchanges = 0, refreshes = 0, client
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await(const chunk of req) body += chunk
      const url = new URL(req.url, base)
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
      if(url.pathname === '/.well-known/oauth-protected-resource') return json({ resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['mcp'] })
      if(url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true })
      if(url.pathname === '/register') { const metadata = JSON.parse(body); return json({ ...metadata, client_id: 'fixture-client' }) }
      if(url.pathname === '/token') {
        const form = new URLSearchParams(body)
        if(form.get('grant_type') === 'refresh_token') { assert.equal(form.get('refresh_token'), 'fixture-refresh'); refreshes++ }
        else { assert.equal(form.get('code'), 'fixture-code'); assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge); exchanges++ }
        return json({ access_token: expected, token_type: 'Bearer', refresh_token: 'fixture-refresh', expires_in: 3600 })
      }
      if(url.pathname === '/mcp') {
        if(req.headers.authorization !== `Bearer ${expected}`) { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }); res.end('Authorization required'); return }
        const headers = { ...req.headers }; delete headers.host; delete headers.authorization; delete headers['content-length']
        const response = await fetch(upstream.url, { method: req.method, headers, ...(body ? { body } : {}) })
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return
      }
      res.writeHead(404).end()
    } catch { res.writeHead(500).end('Fixture validation failed') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await client?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await upstream.close(); if(previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const config = { transport: 'streamable-http', url: base + '/mcp', timeout_ms: 3000 }
  const authorize = async (url, wrongIssuer = false) => {
    challenge = url.searchParams.get('code_challenge')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    const callback = new URL(url.searchParams.get('redirect_uri'))
    callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', 'wrong')
    assert.equal((await fetch(callback)).status, 400)
    callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('iss', wrongIssuer ? 'https://wrong.invalid' : base)
    assert.equal((await fetch(callback)).status, 200)
  }
  assert.equal((await loginMcpOAuth('fixture', config, { timeoutMs: 5000, onAuthorization: authorize })).authorized, true)
  assert.equal(exchanges, 1)
  const persisted = await createMcpOAuthProvider('fixture', config).store.read()
  assert.equal(persisted.tokens.issuer, base)
  assert.equal(persisted.verifier, undefined)
  await loginMcpOAuth('fixture', config, { timeoutMs: 5000, onAuthorization: () => { throw new Error('Existing valid authorization must not restart login') } })
  assert.deepEqual((await createMcpOAuthProvider('fixture', config).store.read()).client, persisted.client)
  for(const file of await readdir(path.join(root, 'credentials'))) {
    const raw = await readFile(path.join(root, 'credentials', file), 'utf8')
    assert.ok(!raw.includes('fixture-refresh')); assert.ok(!raw.includes('fixture-access-one'))
  }
  client = createSdkMcpClient('fixture', config)
  assert.equal((await client.health()).ok, true)
  expected = 'fixture-access-two'
  assert.equal((await client.callTool('echo', { text: 'OAuth refreshed' })).output, 'OAuth refreshed')
  assert.equal(refreshes, 1)
  await assert.rejects(loginMcpOAuth('wrong-issuer', config, { timeoutMs: 5000, onAuthorization: url => authorize(url, true) }), /issuer|authorization server/i)
  assert.equal(exchanges, 1, 'issuer mismatch must not exchange the authorization code')
  await assert.rejects(loginMcpOAuth('timed-out', config, { timeoutMs: 200, onAuthorization: () => {} }), /timed out|closed|abort/i)
  const controller = new AbortController()
  await assert.rejects(loginMcpOAuth('cancelled', config, { signal: controller.signal, timeoutMs: 2000, onAuthorization: () => { controller.abort() } }), /cancelled|closed|abort/i)
  assert.equal(exchanges, 1, 'cancelled flows must not exchange codes')
})
