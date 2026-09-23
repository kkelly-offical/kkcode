import { spawn } from 'node:child_process'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { DeviceClient } from '../src/sdk/client.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const host = process.env.KKCODE_QA_SSH_HOST, user = process.env.KKCODE_QA_SSH_USER
const key = process.env.KKCODE_QA_SSH_KEY, known = process.env.KKCODE_QA_SSH_KNOWN_HOSTS
if (!/^[A-Za-z0-9.-]+$/.test(host || '') || !/^[A-Za-z0-9_-]+$/.test(user || '') || !path.isAbsolute(key || '') || !path.isAbsolute(known || '')) throw new Error('Select an explicit QA SSH host/user/key/known-hosts; never auto-select a user device')
const target = `${user}@${host}`, remotePort = 18579
const scratch = await mkdtemp(path.join(os.tmpdir(), 'kkcode-ssh-acceptance-'))
const sshOptions = ['-i', key, '-o', `UserKnownHostsFile=${known}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function run(command, args, { input, timeout = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${path.basename(command)} acceptance operation timed out`)) }, timeout)
    let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.length > 4 * 1024 * 1024) child.kill('SIGTERM') }); child.stderr.resume()
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} acceptance operation failed (${code}); output omitted to protect fixture credentials`)) })
    child.stdin.end(input)
  })
}
const ssh = command => run('ssh', [...sshOptions, target, command])
const scp = (file, destination) => run('scp', [...sshOptions, file, `${target}:${destination}`])
const guest = (await ssh(`mktemp -d "$HOME/kkcode-preview-acceptance-XXXXXX"`)).trim()
if (!path.isAbsolute(guest) || !/^kkcode-preview-acceptance-[A-Za-z0-9]+$/.test(path.basename(guest))) throw new Error('Unexpected QA directory')
console.log('Provisioning isolated candidate in the explicitly selected QA VM (existing KK Code install unchanged).')
const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch]))[0]
const globalModules = (await run('npm', ['root', '-g'])).trim()
await run('tar', ['-czf', path.join(scratch, 'npm.tgz'), '-C', globalModules, 'npm'])
await Promise.all([scp(path.join(scratch, packed.filename), `${guest}/candidate.tgz`), scp(path.join(scratch, 'npm.tgz'), `${guest}/npm.tgz`), scp(path.join(root, 'scripts/ssh-guest-fixture.mjs'), `${guest}/fixture.mjs`)])
await ssh(`tar -xzf ${quote(guest + '/npm.tgz')} -C ${quote(guest)} && node ${quote(guest + '/npm/bin/npm-cli.js')} install --prefix ${quote(guest + '/install')} --ignore-scripts --no-audit --no-fund ${quote(guest + '/candidate.tgz')}`)
const entry = `${guest}/install/node_modules/@kkelly-offical/kkcode/src/index.mjs`
assert.equal((await ssh(`node ${quote(entry)} --version`)).trim(), JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version)
await ssh(`node ${quote(guest + '/fixture.mjs')} start ${quote(guest)}`)
const commandPrefix = `env KKCODE_HOME=${quote(guest + '/state')} KKCODE_DISABLE_UPDATE_CHECK=1 node ${quote(entry)}`
let tunnel
// Node's browser-compatible fetch intentionally ignores Host overrides. SSH
// forwarding preserves the target Host using the SDK's injectable transport.
const forwardedFetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: options.method || 'GET', headers: options.headers, signal: options.signal }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject)
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })))
  })
  request.on('error', reject); request.end(options.body)
})
async function connect() {
  const ready = JSON.parse((await ssh(`${commandPrefix} ssh-host --json --home-only --port ${remotePort}`)).trim())
  assert.equal(ready.lifetime, 'drain-on-disconnect')
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const local = probe.address().port; await new Promise(resolve => probe.close(resolve))
  tunnel = spawn('ssh', [...sshOptions, '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${local}:127.0.0.1:${remotePort}`, target], { stdio: 'ignore' })
  const headers = { Host: `127.0.0.1:${remotePort}` }, url = `http://127.0.0.1:${local}`
  let response
  for (let attempt = 0; attempt < 40; attempt++) {
    try { response = await forwardedFetch(url + '/api/v1/auth/pair', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrap: ready.bootstrap, native: true }) }); break } catch { await delay(100) }
  }
  assert.ok(response?.ok, 'SSH tunnel must pair successfully')
  return new DeviceClient({ url, headers, fetch: forwardedFetch, token: (await response.json()).token, retries: 0 })
}
function disconnect() { tunnel?.kill('SIGTERM'); tunnel = null }
try {
  let client = await connect()
  const catalog = await client.request('models.discover', { provider: 'ssh-fixture' }); assert.equal(catalog.models[0].id, 'ssh-fixture')
  const session = await client.request('sessions.create', { cwd: guest + '/workspace' })
  await client.request('control.acquire', { sessionId: session.id })
  await client.request('turns.start', { sessionId: session.id, prompt: 'SSH_DETACH_SLOW desktop acceptance' })
  await delay(1500); disconnect(); await delay(1500)
  client = await connect()
  assert.equal((await client.request('sessions.get', { sessionId: session.id })).running, true)
  disconnect(); await delay(22000)
  client = await connect()
  const completed = await client.request('sessions.get', { sessionId: session.id })
  assert.equal(completed.running, false); assert.ok(JSON.stringify(completed.messages).includes('SSH_BACKGROUND_COMPLETED'))
  assert.equal(completed.context.tokens, 136)
  console.log('PASS: real SSH, Base URL model discovery, loss of every client transport, reconnect during execution, completion without clients, persisted result/context.')
  disconnect()
  if (process.env.KKCODE_ANDROID_SERIAL) {
    const serial = process.env.KKCODE_ANDROID_SERIAL
    if (!/^[A-Za-z0-9._:-]+$/.test(serial)) throw new Error('Invalid explicit Android serial')
    const adb = path.join(process.env.ANDROID_HOME, 'platform-tools/adb')
    const fingerprint = (await ssh('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).trim().split(/\s+/)[1]
    const fixture = JSON.stringify({ host, username: user, remotePort, fingerprint, privateKey: await readFile(key, 'utf8'), commandPrefix, workspace: guest + '/workspace' })
    for (const apk of ['debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk']) await run(adb, ['-s', serial, 'install', '-r', path.join(root, 'android/app/build/outputs/apk', apk)])
    await run(adb, ['-s', serial, 'shell', 'run-as', 'cn.kkcode.remote', 'sh', '-c', '"umask 077; mkdir -p files; cat > files/ssh-lifecycle.json"'], { input: fixture })
    const output = await run(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'cn.kkcode.remote.SshLifecycleTest', 'cn.kkcode.remote.test/androidx.test.runner.AndroidJUnitRunner'])
    if (!/OK \(1 test\)/.test(output) || /FAILURES!!!|INSTRUMENTATION_FAILED/.test(output)) throw new Error('Native SSH lifecycle acceptance failed; inspect non-secret Android diagnostics')
    console.log('PASS: Android SSHJ closes all transports twice; a new connection sees the active turn and its completed history/context.')
  }
  let drained = false
  for (let attempt = 0; attempt < 48; attempt++) {
    const result = await ssh(`if test -e ${quote(guest + '/state/ssh-host/control.json')}; then printf active; else printf drained; fi`)
    if (result === 'drained') { drained = true; break }
    await delay(2000)
  }
  assert.equal(drained, true, 'Idle task host must drain after all work and clients finish')
  console.log('PASS: detached SSH task host exits after its idle grace; no permanent Remote exposure was introduced.')
  await mkdir(path.join(root, 'test-results'), { recursive: true })
  await writeFile(path.join(root, 'test-results/ssh-lifecycle.json'), JSON.stringify({ passed: true, version: packed.version, host, guest, nativeAndroid: Boolean(process.env.KKCODE_ANDROID_SERIAL), lifetime: 'drain-on-disconnect', testedAt: new Date().toISOString() }, null, 2))
} finally { disconnect() }
