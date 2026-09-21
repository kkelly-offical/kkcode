import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdtemp, chown } from 'node:fs/promises'
import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import pg from 'pg'
import YAML from 'yaml'
import { createGateway } from '../src/remote/gateway.mjs'
import { PostgresStore } from '../src/remote/store.mjs'
import { loadLab, labBrowser } from './lab-browser.mjs'

const exec = promisify(execFile), lab = await loadLab()
const directory = await mkdtemp(path.join(lab.directory, 'dex-acceptance-'))
const id = randomBytes(6).toString('hex'), container = `kkcode-dex-acceptance-${id}`, database = `kkcode_dex_${id}`
const issuer = 'https://10.0.0.2:18481/dex', origin = 'https://10.0.0.2:18482'
const password = randomBytes(24).toString('base64url'), clientSecret = randomBytes(32).toString('base64url')
const hash = await new Promise((resolve, reject) => {
  const child = execFile('python3', ['-c', 'import bcrypt,sys; print(bcrypt.hashpw(sys.stdin.buffer.read(), bcrypt.gensalt()).decode())'], (error, stdout) => error ? reject(new Error('bcrypt hashing failed')) : resolve(stdout.trim()))
  child.stdin.end(password)
})
const certificate = await readFile(path.join(lab.directory, 'tls.crt')), key = await readFile(path.join(lab.directory, 'tls.key'))
const config = { issuer, storage: { type: 'sqlite3', config: { file: '/dex/dex.db' } }, web: { https: '10.0.0.2:18481', tlsCert: '/dex/tls.crt', tlsKey: '/dex/tls.key' }, oauth2: { responseTypes: ['code'], skipApprovalScreen: true }, staticClients: [{ id: 'kkcode-gateway', redirectURIs: [`${origin}/auth/callback`], name: 'KK Code Enterprise Acceptance', secret: clientSecret }], enablePasswordDB: true, staticPasswords: [{ email: 'owner@dex.kkcode.test', hash, username: 'Dex Owner', userID: randomUUID() }] }
await chown(directory, 1001, 1001)
for (const [name, value] of [['config.yaml', YAML.stringify(config)], ['tls.crt', certificate], ['tls.key', key]]) { const file = path.join(directory, name); await writeFile(file, value, { mode: 0o600 }); await chown(file, 1001, 1001) }
const compose = ['compose', '--env-file', path.join(lab.directory, 'lab.env'), '-f', path.resolve('deploy/lab/compose.yaml')]
const { stdout: databaseContainer } = await exec('docker', [...compose, 'ps', '-q', 'gateway-database'])
const { stdout: address } = await exec('docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', databaseContainer.trim()])
const connection = new URL(`postgresql://kkcode@${address.trim()}:5432/kkcode`); connection.password = lab.credentials.gatewayPassword
const admin = new pg.Client({ connectionString: connection.href }); await admin.connect()
let app, proxy, browser, started = false, created = false
try {
  await admin.query(`CREATE DATABASE ${database}`); created = true
  connection.pathname = `/${database}`
  await exec('docker', ['run', '-d', '--name', container, '--network', 'host', '--mount', `type=bind,source=${directory},target=/dex`, 'ghcr.io/dexidp/dex:v2.44.0', 'dex', 'serve', '/dex/config.yaml']); started = true
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(1000) })).ok } catch { /* startup */ }
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.ok(ready, 'Real Dex container failed to become ready')
  const store = await new PostgresStore(connection.href).initialize()
  app = await createGateway({ origin, issuer, clientId: 'kkcode-gateway', clientSecret, store, organization: 'Dex Enterprise Acceptance', rolesClaim: 'groups', adminRole: 'kkcode-admin', scopes: 'openid profile email groups' })
  const backend = await app.listen({ host: '127.0.0.1', port: 0 })
  proxy = createServer({ cert: certificate, key }, (req, res) => {
    const forward = httpRequest(new URL(req.url, backend), { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res) })
    forward.on('error', () => { res.writeHead(503); res.end() }); req.pipe(forward)
  })
  await new Promise(resolve => proxy.listen(18482, '10.0.0.2', resolve))
  browser = await labBrowser()
  const context = await browser.newContext({ ignoreHTTPSErrors: true }), page = await context.newPage()
  const flow = await (await fetch(origin + '/auth/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'client', name: 'Real Dex acceptance' }) })).json()
  await page.goto(flow.verification_uri_complete)
  await page.getByRole('button', { name: 'Continue with organization SSO' }).click()
  try {
    await page.locator('input[name="login"]').fill('owner@dex.kkcode.test')
    await page.locator('input[name="password"]').fill(password)
    await page.getByRole('button', { name: /log\s*in/i }).click()
  } catch {
    console.log('Dex form diagnostics:', JSON.stringify(await page.locator('input,button,a').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, name: element.getAttribute('name'), type: element.getAttribute('type'), text: element.tagName === 'INPUT' ? '' : element.textContent.trim() })))))
    throw new Error('Dex login form did not complete (credential diagnostics suppressed)')
  }
  await page.getByRole('button', { name: 'Allow this device' }).click()
  await page.getByRole('heading', { name: 'Device approved' }).waitFor()
  const exchange = await context.request.post(origin + '/auth/token', { data: { device_code: flow.device_code, browser: true } })
  assert.equal(exchange.status(), 200)
  const completed = await exchange.json(); assert.equal(completed.authenticated, true); assert.equal(completed.access_token, undefined)
  const profile = await (await context.request.get(origin + '/api/v1/profile')).json()
  assert.equal(profile.email, 'owner@dex.kkcode.test'); assert.equal(profile.admin, false); assert.equal(profile.organization, 'Dex Enterprise Acceptance')
  assert.equal((await context.request.post(origin + '/auth/refresh', { data: {} })).status(), 200)
  assert.equal((await context.request.post(origin + '/auth/logout', { data: {} })).status(), 200)
  assert.equal((await context.request.get(origin + '/api/v1/profile')).status(), 401)
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ provider: 'Dex v2.44.0', issuer, gateway: origin, at: new Date().toISOString(), pkce: true, jwks: true, groupsScope: true, httpOnlyBrowserExchange: true, refresh: true, logout: true }), { mode: 0o600 })
  console.log('Real Dex v2.44.0 + PostgreSQL over WireGuard HTTPS: PKCE/JWKS login, configurable groups scope, HttpOnly exchange, refresh and logout passed')
} finally {
  await browser?.close()
  if (proxy) await new Promise(resolve => proxy.close(resolve))
  await app?.close()
  if (started) await exec('docker', ['rm', '-f', container])
  if (created) { assert.match(database, /^kkcode_dex_[a-f0-9]{12}$/); await admin.query(`DROP DATABASE ${database}`) }
  await admin.end()
  console.log('Only the owned Dex acceptance container and temporary database were removed; private test artifacts retained outside Git.')
}
