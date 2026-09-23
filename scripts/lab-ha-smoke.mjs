import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import net from 'node:net'
import { request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import WebSocket from 'ws'
import pg from 'pg'
import { loadLab } from './lab-browser.mjs'
import { PostgresStore } from '../src/remote/store.mjs'
import { identityHash } from '../src/remote/identity.mjs'

const exec = promisify(execFile), lab = await loadLab(), freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
const compose = ['compose', '--env-file', path.join(lab.directory, 'lab.env'), '-f', path.resolve('deploy/lab/compose.yaml')]
const { stdout: databaseContainer } = await exec('docker', [...compose, 'ps', '-q', 'gateway-database'])
const { stdout: address } = await exec('docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', databaseContainer.trim()])
const connection = new URL(`postgresql://kkcode@${address.trim()}:5432/kkcode`); connection.password = lab.credentials.gatewayPassword
const admin = new pg.Client({ connectionString: connection.href }); await admin.connect()
const database = `kkcode_ha_${randomBytes(6).toString('hex')}`, secret = randomBytes(32).toString('hex')
const idp = Fastify(); let issuer, store, created = false
idp.get('/.well-known/openid-configuration', async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] }))
issuer = await idp.listen({ host: '127.0.0.1', port: 0 })
const processes = [], sockets = []
const clientToken = randomBytes(32).toString('hex'), deviceToken = randomBytes(32).toString('hex')
// Node fetch intentionally rewrites Host; use HTTP transport to emulate a reverse proxy.
const gatewayFetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = httpRequest(url, { method: options.method || 'GET', headers: options.headers, timeout: 35000 }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, ok: response.statusCode < 400, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }))
  })
  request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Acceptance request timed out'))); request.end(options.body)
})
async function startNode(label) {
  const port = await freePort(), clusterPort = await freePort(), origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['apps/gateway/main.mjs'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: connection.href, KKCODE_GATEWAY_DEV: '1', KKCODE_GATEWAY_ORIGIN: 'http://localhost', KKCODE_OIDC_ISSUER: issuer, KKCODE_OIDC_CLIENT_ID: 'ha-acceptance', KKCODE_OIDC_CLIENT_SECRET: randomBytes(24).toString('hex'), KKCODE_ORGANIZATION: 'HA Acceptance', KKCODE_CLUSTER_ADDRESS: `http://127.0.0.1:${clusterPort}`, KKCODE_CLUSTER_HOST: '127.0.0.1', KKCODE_CLUSTER_PORT: String(clusterPort), KKCODE_CLUSTER_SECRET: secret, KKCODE_CLUSTER_NODE_ID: label, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child); child.stdout.resume(); child.stderr.resume()
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Gateway ${label} exited during startup`)
    try { if ((await gatewayFetch(origin + '/health', { headers: { Host: 'localhost' } })).ok) return { child, origin, label } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Gateway ${label} did not become ready`)
}
const rpc = (node, id) => gatewayFetch(node.origin + '/api/v1/devices/computer/rpc', { method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` }, body: JSON.stringify({ id, method: 'status', params: { marker: 'never-persist-this-ha-conversation' } }) })
async function device(node) {
  const socket = new WebSocket(node.origin.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: `Bearer ${deviceToken}` } }); sockets.push(socket)
  await once(socket, 'open')
  const registered = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'register', device: { id: 'computer', name: 'HA acceptance computer' } }))
  assert.equal(JSON.parse((await registered)[0]).type, 'registered')
  socket.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'request') socket.send(JSON.stringify({ type: 'response', id: message.id, result: { through: node.label, marker: message.request.params.marker } })) })
  return socket
}
try {
  await admin.query(`CREATE DATABASE ${database}`); created = true; connection.pathname = `/${database}`
  store = await new PostgresStore(connection.href).initialize()
  const account = { id: 'owner', name: 'HA Owner', organization: 'HA Acceptance' }; await store.put('account:owner', account)
  for (const [id, kind, token] of [['client', 'client', clientToken], ['device', 'device', deviceToken]]) {
    await store.put(`identity-session:${id}`, { id, accountId: 'owner', kind, expires: Date.now() + 600000 })
    await store.put(`token:${identityHash(token)}`, { sessionId: id, kind, account, expires: Date.now() + 600000 })
  }
  const a = await startNode('node-a'), b = await startNode('node-b')
  const sshBook = (node, body) => gatewayFetch(node.origin + '/api/v1/connections/ssh', { method: body ? 'POST' : 'GET', headers: { Host: 'localhost', 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  assert.deepEqual(await (await sshBook(a)).json(), { revision: 0, items: [] })
  const profile = { id: 'qa-ssh', name: 'QA SSH metadata only', host: '127.0.0.1', username: 'qa' }
  const saved = await sshBook(a, { revision: 0, connection: profile }); assert.equal(saved.status, 200)
  assert.equal((await (await sshBook(b)).json()).items[0].name, profile.name)
  const concurrent = await Promise.all([a, b].map((node, index) => sshBook(node, { revision: 1, connection: { ...profile, name: `concurrent-${index}` } })))
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409])
  assert.equal((await sshBook(b, { revision: 2, connection: { ...profile, privateKey: 'never-accepted' } })).status, 400)
  assert.equal(JSON.stringify(await store.list('ssh-profiles:')).includes('privateKey'), false)
  console.log('PASS: account SSH metadata crosses two real PostgreSQL-backed gateways; concurrent revisions conflict and credential fields are rejected.')
  const first = await device(a)
  const routed = await rpc(b, 'before-crash'); assert.equal(routed.status, 200); assert.equal((await routed.json()).result.through, 'node-a')
  // Terminate only connections to this explicitly created acceptance database.
  // Pool idle-error handling must keep both gateway processes alive and reconnect.
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()', [database])
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(a.child.exitCode, null); assert.equal(b.child.exitCode, null)
  assert.equal((await rpc(b, 'after-database-connection-loss')).status, 200)
  // SIGKILL bypasses cleanup and deliberately leaves a lease in PostgreSQL.
  const disconnected = once(first, 'close'), dead = once(a.child, 'exit'); a.child.kill('SIGKILL'); await dead; await disconnected
  const unavailable = await rpc(b, 'during-failover'); assert.equal(unavailable.status, 503)
  await device(b)
  const recovered = await rpc(b, 'after-crash'); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).result.through, 'node-b')
  const restarted = await startNode('node-a-restarted')
  assert.equal((await rpc(restarted, 'after-restart')).status, 200)
  assert.equal(JSON.stringify(await store.list('')).includes('never-persist-this-ha-conversation'), false)
  // Cross-node refresh grants are atomic PostgreSQL DELETE ... RETURNING.
  const refresh = randomBytes(32).toString('hex'); await store.put(`refresh:${identityHash(refresh)}`, { sessionId: 'client', expires: Date.now() + 60000 })
  const rotations = await Promise.all([b, restarted].map(node => gatewayFetch(node.origin + '/auth/refresh', { method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) })))
  assert.deepEqual(rotations.map(result => result.status).sort(), [200, 401])
  await store.delete('identity-session:device')
  assert.equal((await rpc(restarted, 'revocation-on-other-node')).status, 503)
  await store.prune({ maxAudit: 100 })
  console.log('Two independent gateway processes + PostgreSQL: encrypted cross-node RPC, forced DB connection recovery, SIGKILL failover/reconnect, restart routing, cross-node single-use refresh and revocation passed; no conversation payload persisted')
} finally {
  for (const socket of sockets) socket.terminate()
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended }
  await idp.close(); await store?.close()
  if (created) { assert.match(database, /^kkcode_ha_[a-f0-9]{12}$/); await admin.query(`DROP DATABASE ${database}`) }
  await admin.end()
  console.log('Only acceptance gateway processes and the explicitly created HA database were stopped/removed; the live enterprise lab was unchanged.')
}
