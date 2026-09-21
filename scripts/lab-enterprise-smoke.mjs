import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, mkdtemp, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn, execFileSync, execFile } from 'node:child_process'
import { labBrowser, loadLab, approveLabLogin, loginLabAccount, labPost } from './lab-browser.mjs'
import { startLabProvider, LAB_ATTACHMENT_TEXT, LAB_ATTACHMENT_PNG } from './lab-fixture-provider.mjs'
import { DeviceClient } from '../src/sdk/client.mjs'
import { writePrivateFile } from '../src/storage/private-file.mjs'
import { expect } from '@playwright/test'
import WebSocket from 'ws'

const root = fileURLToPath(new URL('../', import.meta.url)), lab = await loadLab()
// The SSO/database credential directory is deliberately never a remote workspace.
const runs = path.join(os.homedir(), '.local/share/kkcode-enterprise-runs')
await mkdir(runs, { recursive: true, mode: 0o700 })
const runDirectory = await mkdtemp(path.join(runs, 'integration-')), state = path.join(runDirectory, '.kkcode'), workspace = path.join(runDirectory, 'workspace')
await mkdir(state, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 })
const branchWorkspace = path.join(workspace, 'git-fixture')
await mkdir(branchWorkspace, { mode: 0o700 })
await writePrivateFile(path.join(branchWorkspace, 'README.md'), 'Owned KK Code acceptance repository. No user project changes.\n')
const run = (command, args, options = {}) => new Promise((resolve, reject) => execFile(command, args, { encoding: 'utf8', timeout: 60000, ...options }, (error, output) => error ? reject(error) : resolve(output)))
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'KK Code Acceptance'], ['config', 'user.email', 'test@example.invalid'], ['add', 'README.md'], ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Isolated acceptance fixture']]) await run('git', ['-c', `core.hooksPath=${path.join(runDirectory, 'disabled-hooks')}`, '-c', 'core.fsmonitor=false', ...args], { cwd: branchWorkspace })
const fixture = await startLabProvider(lab), browser = await labBrowser()
const config = { provider: { default: 'lab-openai', 'lab-openai': { type: 'openai-compatible', base_url: `${fixture.url}/v1`, api_key: 'lab-fixture', default_model: 'lab-model-a', stream: false, retry_attempts: 0 }, 'lab-anthropic': { type: 'anthropic', base_url: `${fixture.url}/anthropic`, api_key: 'lab-fixture', default_model: 'lab-model-a', stream: false, retry_attempts: 0 } }, language: 'zh', skills: { auto_seed: false }, mcp: { auto_discover: false }, updates: { enabled: false } }
await writePrivateFile(path.join(state, 'config.json'), JSON.stringify(config))
await writePrivateFile(path.join(state, 'profile.yaml'), 'beginner: false\ntech_stack: []\n')
const environment = { ...process.env, KKCODE_HOME: state, KKCODE_DISABLE_UPDATE_CHECK: '1', TERM: 'dumb', NODE_EXTRA_CA_CERTS: lab.ca }
const children = new Set()
const child = (args, options = {}) => {
  const process = spawn(globalThis.process.execPath, [path.join(root, 'src/index.mjs'), ...args], { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'], ...options })
  let output = ''; process.stdout.on('data', data => { output += data }); process.stderr.on('data', data => { output += data })
  const closed = new Promise(resolve => process.on('close', code => resolve(code)))
  const result = { process, output: () => output, closed }; children.add(result)
  return result
}
async function until(check, label, milliseconds = 20000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(`Timed out: ${label}`)
}
async function retiredDeviceToken(token, deviceId) {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(`${lab.gateway.replace(/^http/, 'ws')}/relay/device`, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000 })
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(result) }
    const timer = setTimeout(() => finish(new Error('Retired device credential was not rejected')), 10000)
    socket.on('open', () => socket.send(JSON.stringify({ type: 'register', device: { id: deviceId, name: 'Retired acceptance device' } })))
    socket.on('message', data => { if (JSON.parse(data.toString()).type === 'registered') finish(new Error('Retired device credential registered again')) })
    socket.on('close', code => finish(null, code))
    socket.on('unexpected-response', (_request, response) => { response.resume(); finish(null, response.statusCode) })
    socket.on('error', () => { if (!settled) finish(new Error('Retired device credential check failed at the transport layer')) })
  })
}
let remote
try {
  // The CLI itself initiates the device grant, then the real IdP approves it.
  const login = child(['remote', 'login', '--gateway', `https://127.0.0.1:${lab.credentials.gatewayPort}`])
  const url = await until(() => login.output().match(/https:\/\/[^\s]+\/login\?code=\d+/)?.[0], 'CLI login URL')
  const browserOwner = await approveLabLogin(browser, lab, { url })
  assert.equal(await login.closed, 0)
  const loginStatus = child(['remote', 'status']); await loginStatus.closed
  assert.equal(JSON.parse(loginStatus.output()).loggedIn, true)
  remote = child(['remote', '--trust', '--root', workspace, '--web', '--port', '18476'])
  const runtime = await until(async () => {
    if (remote.process.exitCode != null) throw new Error(`Remote CLI exited (${remote.process.exitCode}): ${remote.output().replace(/#bootstrap=\S+/g, '#bootstrap=[redacted]').slice(-2500)}`)
    try { const value = JSON.parse(await readFile(path.join(state, 'remote-status.json'), 'utf8')); return value.connection === 'connected' && value } catch { return null }
  }, 'outbound relay registration')
  const peer = await loginLabAccount(browser, lab, { name: 'Second control client' })
  const sdk = new DeviceClient({ url: lab.gateway, deviceId: runtime.deviceId, token: peer.credentials.access_token, refreshToken: peer.credentials.refresh_token })
  const other = new DeviceClient({ url: lab.gateway, deviceId: runtime.deviceId, fetch: async (url, options = {}) => { const response = await browserOwner.context.request.fetch(url, { method: options.method, headers: options.headers, data: options.body }); return new Response(await response.body(), { status: response.status() }) }, retries: 0 })
  assert.equal((await sdk.request('status')).device.id, runtime.deviceId)
  console.log('PASS: CLI first login, organization status and registered Relay device')

  remote.process.stdin.write('LAB_HELLO\n')
  const sessions = await until(async () => { const value = await sdk.request('sessions.list'); return value.length && value }, 'terminal session persisted')
  const sessionId = sessions[0].id
  await until(async () => !(await sdk.request('events.list', { sessionId })).running, 'terminal turn finished')
  await until(() => remote.output().replace(/\x1b\[[0-9;]*m/g, '').includes('LAB_HELLO_OK'), 'terminal reply').catch(error => { throw new Error(`${error.message}; terminal: ${remote.output().replace(/#bootstrap=\S+/g, '#bootstrap=[redacted]').slice(-3000)}`) })
  await browserOwner.page.setViewportSize({ width: 390, height: 844 })
  await browserOwner.page.goto(lab.gateway)
  await browserOwner.page.locator('.remote-session').first().click().catch(async () => {
    await browserOwner.page.screenshot({ path: path.join(runDirectory, 'enterprise-failure.png') })
    throw new Error(`Remote WebUI session list unavailable: ${(await browserOwner.page.locator('body').innerText()).slice(0, 1500)}`)
  })
  await expect(browserOwner.page.getByText('LAB_HELLO_OK', { exact: true })).toBeVisible()
  const localUrl = await until(() => remote.output().match(/Local WebUI: (https?:\/\/[^\s]+)/)?.[1], 'loopback WebUI address')
  const local = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await local.goto(localUrl)
  await local.locator('nav .session').first().click()
  await expect(local.getByText('LAB_HELLO_OK', { exact: true })).toBeVisible()
  console.log('PASS: terminal history is visible through both loopback and WireGuard WebUI')

  for (const provider of ['lab-openai', 'lab-anthropic']) {
    const catalog = await sdk.request('models.discover', { provider, refresh: true })
    assert.deepEqual(catalog.models.map(model => model.id), ['lab-model-a', 'lab-model-b'])
  }
  await sdk.request('control.acquire', { sessionId })
  const configured = await sdk.request('commands.run', { sessionId, command: '/model lab-model-b' })
  assert.equal(configured.state.model, 'lab-model-b')
  await sdk.request('control.release', { sessionId })
  await sdk.request('settings.update', { config: { provider: { 'lab-openai': { default_model: 'lab-model-b' } } } })
  assert.equal((await sdk.request('settings.get')).provider['lab-openai'].api_key, '[REDACTED]')
  console.log('PASS: OpenAI/Anthropic Base URL discovery, slash model selection, hot configuration and redaction')

  await browserOwner.page.getByRole('button', { name: '对话设置' }).click()
  await browserOwner.page.getByRole('dialog').getByRole('button', { name: '模型与渠道', exact: true }).click()
  await browserOwner.page.getByRole('dialog').getByRole('button', { name: /^lab-openai/ }).click()
  await browserOwner.page.getByRole('dialog').getByRole('button', { name: 'lab-model-b', exact: true }).click()
  await expect(browserOwner.page.getByRole('dialog')).toHaveCount(0)
  assert.equal((await sdk.request('sessions.get', { sessionId })).model, 'lab-model-b')
  console.log('PASS: WebUI live model catalog selection uses the same SDK/session state')

  await sdk.request('control.acquire', { sessionId })
  const requestId = crypto.randomUUID()
  const started = await Promise.all([sdk.request('turns.start', { sessionId, prompt: 'LAB_APPROVAL', mode: 'agent' }, { id: requestId }), sdk.request('turns.start', { sessionId, prompt: 'LAB_APPROVAL', mode: 'agent' }, { id: requestId })])
  assert.equal(started[0].turnId, started[1].turnId)
  await assert.rejects(other.request('control.acquire', { sessionId }), error => error.code === 'control_busy')
  const approval = await until(async () => (await sdk.request('events.list', { sessionId })).approvals[0], 'cross-client write approval')
  assert.equal(approval.kind, 'permission')
  await browserOwner.page.getByRole('button', { name: '允许本次', exact: true }).click()
  await until(async () => !(await sdk.request('events.list', { sessionId })).running, 'approved tool completes')
  assert.equal(await readFile(path.join(workspace, 'approved.txt'), 'utf8'), 'remote synchronized\n')
  await expect(local.getByRole('button', { name: '允许本次', exact: true })).toHaveCount(0)
  await expect(browserOwner.page.getByText('LAB_TOOL_OK', { exact: true }).last()).toBeVisible()
  assert.ok(fixture.requests.some(request => request.method === 'inference' && request.model === 'lab-model-b'))
  console.log('PASS: idempotent turn, one real write, approval on a different client, synchronized dismissal')

  await sdk.request('control.acquire', { sessionId })
  await sdk.request('turns.start', { sessionId, prompt: 'LAB_QUESTION' })
  await until(async () => (await sdk.request('events.list', { sessionId })).approvals.some(approval => approval.kind === 'question'), 'question broadcast')
  await browserOwner.page.getByLabel('继续测试', { exact: false }).check()
  await browserOwner.page.getByRole('button', { name: '提交回答', exact: true }).click()
  await until(async () => !(await sdk.request('events.list', { sessionId })).running, 'question resolved')
  console.log('PASS: structured question answered in WebUI using its actual question ID')

  await sdk.request('control.acquire', { sessionId })
  await sdk.request('turns.start', { sessionId, prompt: 'LAB_WAIT' })
  await sdk.request('turns.cancel', { sessionId })
  await until(async () => !(await sdk.request('events.list', { sessionId })).running, 'cancelled turn')
  console.log('PASS: remote cancellation settles the active turn')

  const attachments = [
    await sdk.request('attachments.upload', { sessionId, name: 'acceptance.txt', mediaType: 'text/plain', data: Buffer.from(LAB_ATTACHMENT_TEXT).toString('base64') }),
    await sdk.request('attachments.upload', { sessionId, name: 'pixel.png', mediaType: 'image/png', data: LAB_ATTACHMENT_PNG })
  ]
  const imageHash = createHash('sha256').update(Buffer.from(LAB_ATTACHMENT_PNG, 'base64')).digest('hex')
  for (const provider of ['lab-openai', 'lab-anthropic']) {
    await sdk.request('control.acquire', { sessionId })
    await sdk.request('sessions.configure', { sessionId, provider, model: 'lab-model-b' })
    const from = fixture.requests.length
    await sdk.request('turns.start', { sessionId, prompt: 'LAB_ATTACHMENT_RELAY', attachmentIds: attachments.map(item => item.id) })
    await until(async () => !(await sdk.request('events.list', { sessionId })).running, `${provider} attachment turn completed`)
    const actual = fixture.requests.slice(from).find(request => request.method === 'inference' && request.tag === 'LAB_ATTACHMENT_RELAY')
    assert.equal(actual?.attachmentTextReceived, true)
    assert.equal(actual.anthropic, provider === 'lab-anthropic')
    assert.ok(actual.images.some(image => image.sha256 === imageHash && image.mediaType === 'image/png' && image.size === Buffer.from(LAB_ATTACHMENT_PNG, 'base64').length))
  }
  const projected = JSON.stringify(await sdk.request('sessions.get', { sessionId }))
  assert.equal(projected.includes(LAB_ATTACHMENT_PNG), false)
  assert.ok(projected.includes('[Image attachment: image/png]'))
  await until(async () => {
    try { return (await readFile(path.join(state, 'sessions', `${sessionId}.json`), 'utf8')).includes(LAB_ATTACHMENT_PNG) } catch { return false }
  }, 'canonical local history retains complete image bytes')
  for (const attachment of attachments) await sdk.request('attachments.remove', { sessionId, id: attachment.id })
  assert.ok((await readFile(path.join(state, 'sessions', `${sessionId}.json`), 'utf8')).includes(LAB_ATTACHMENT_PNG))
  console.log('PASS: Relay text/PNG uploads reach both provider protocols, transport strips binary, canonical history survives staging deletion')

  await sdk.request('control.acquire', { sessionId })
  await sdk.request('commands.run', { sessionId, command: '/permission readonly' })
  assert.equal((await sdk.request('sessions.get', { sessionId })).approval, 'readonly')
  await sdk.request('turns.start', { sessionId, prompt: 'LAB_PERMISSION_PRESERVED' })
  await until(async () => {
    const result = await sdk.request('events.list', { sessionId })
    assert.equal(result.approvals.length, 0, 'Readonly must not silently revert to a manual write prompt')
    return !result.running
  }, 'readonly next turn completes without writing')
  await assert.rejects(access(path.join(workspace, 'must-not-write.txt')), { code: 'ENOENT' })
  assert.equal((await sdk.request('sessions.get', { sessionId })).approval, 'readonly')
  await sdk.request('control.acquire', { sessionId })
  await sdk.request('commands.run', { sessionId, command: '/permission manual' })
  await sdk.request('control.release', { sessionId })
  console.log('PASS: slash permission policy persists into the next real model/tool turn')

  const branchSession = await sdk.request('sessions.create', { cwd: branchWorkspace, title: 'Isolated branch acceptance' })
  const branchState = await sdk.request('branches.list', { sessionId: branchSession.id })
  assert.equal(branchState.current, 'main'); assert.equal(branchState.clean, true)

  const viewer = await loginLabAccount(browser, lab, { account: 'viewer', name: 'Read-only colleague' })
  const administrator = await loginLabAccount(browser, lab, { account: 'administrator', name: 'Organization administrator' })
  const viewerSdk = new DeviceClient({ url: lab.gateway, deviceId: runtime.deviceId, token: viewer.credentials.access_token, retries: 0 })
  const adminSdk = new DeviceClient({ url: lab.gateway, deviceId: runtime.deviceId, token: administrator.credentials.access_token, retries: 0 })
  await assert.rejects(viewerSdk.request('status'), error => error.status === 403)
  await assert.rejects(adminSdk.request('status'), error => error.status === 403)
  const share = role => labPost(lab, `/api/v1/devices/${runtime.deviceId}/share`, { accountId: viewer.credentials.profile.id, sessionId, role }, peer.credentials.access_token)
  assert.equal((await share('view')).status, 200)
  assert.deepEqual((await viewerSdk.request('sessions.list')).map(session => session.id), [sessionId])
  assert.equal((await viewerSdk.request('status')).shared, true)
  await assert.rejects(viewerSdk.request('settings.get'), error => error.status === 403)
  await assert.rejects(viewerSdk.request('control.acquire', { sessionId }), error => error.status === 403)
  assert.equal((await share('control')).status, 200)
  await viewerSdk.request('control.acquire', { sessionId })
  await viewerSdk.request('control.release', { sessionId })
  assert.equal((await share('remove')).status, 200)
  await assert.rejects(viewerSdk.request('sessions.get', { sessionId }), error => error.status === 403)
  console.log('PASS: private-by-default sessions, administrator isolation, read/control sharing and immediate revocation')

  if (process.env.KKCODE_ANDROID_SERIAL) {
    const serial = process.env.KKCODE_ANDROID_SERIAL
    if (serial !== 'emulator-5580') throw new Error('This lab script is scoped to the dedicated emulator-5580')
    const adb = path.join(process.env.ANDROID_HOME || '/root/android-sdk', 'platform-tools/adb')
    const hostKeys = execFileSync('ssh', ['-i', '/tmp/kkcode-101-qa-z23B4i/id_ed25519', '-o', 'UserKnownHostsFile=/tmp/kkcode-101-qa-z23B4i/known_hosts', '-o', 'StrictHostKeyChecking=yes', 'qa@192.168.122.8', 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256; ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub -E sha256; ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub -E sha256'], { encoding: 'utf8' }).match(/SHA256:[A-Za-z0-9+/]+/g)
    const fixturePath = path.join(state, 'android-test.json')
    await writePrivateFile(fixturePath, JSON.stringify({ gateway: lab.gateway, accessToken: peer.credentials.access_token, deviceId: runtime.deviceId, sessionId, branchSessionId: branchSession.id, sshHost: '192.168.122.8', sshFingerprints: hostKeys, sshPrivateKey: await readFile('/tmp/kkcode-101-qa-z23B4i/id_ed25519', 'utf8') }))
    const callAdb = args => new Promise((resolve, reject) => execFile(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 180000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
    await callAdb(['install', '-r', path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk')])
    await callAdb(['install', '-r', path.join(root, 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')])
    await callAdb(['shell', 'run-as', 'cn.kkcode.remote', 'mkdir', '-p', 'files'])
    const uid = (await callAdb(['shell', 'stat', '-c', '%u', '/data/user/0/cn.kkcode.remote'])).trim()
    if (!/^\d+$/.test(uid)) throw new Error('Cannot determine the test app UID')
    const target = '/data/user/0/cn.kkcode.remote/files/enterprise-test.json'
    const nativeLogin = '/data/user/0/cn.kkcode.remote/files/enterprise-login.json'
    await callAdb(['shell', 'rm', '-f', nativeLogin])
    await callAdb(['push', fixturePath, target]); await callAdb(['shell', 'chown', `${uid}:${uid}`, target]); await callAdb(['shell', 'chmod', '600', target]); await callAdb(['shell', 'restorecon', target])
    try {
      let finished = false
      const instrument = callAdb(['shell', 'am', 'instrument', '-w', '-r', '-e', 'enterprise', 'true', '-e', 'class', 'cn.kkcode.remote.EnterpriseNetworkTest', 'cn.kkcode.remote.test/androidx.test.runner.AndroidJUnitRunner']).then(output => { finished = true; return output })
      const loginUri = await until(async () => {
        if (finished) throw new Error(await instrument)
        try { return JSON.parse(await callAdb(['shell', 'cat', nativeLogin])).url } catch { return null }
      }, 'native Android device login', 90000)
      const verified = new URL(loginUri)
      assert.equal(verified.origin, lab.gateway); assert.equal(verified.pathname, '/login')
      await approveLabLogin(browser, lab, { url: loginUri })
      const output = await instrument
      if (!/OK \(3 tests\)/.test(output)) throw new Error(output)
      await expect(browserOwner.page.getByText('LAB_ANDROID_OK', { exact: true })).toBeVisible()
      await expect(local.getByText('LAB_ANDROID_OK', { exact: true })).toBeVisible()
      assert.equal((await sdk.request('sessions.get', { sessionId })).providerType, 'lab-anthropic')
      assert.equal((await sdk.request('branches.list', { sessionId: branchSession.id })).current, 'main')
      console.log('PASS: native Android login/model/mode/conversation sync, document upload/removal, safe Git branch selection, HTTPS Relay and verified SSH')
    } finally { await callAdb(['shell', 'rm', '-f', target, nativeLogin]) }
  }
  if (process.env.KKCODE_LAB_RESTART_GATEWAY === '1') {
    const before = await sdk.request('sessions.get', { sessionId })
    await new Promise((resolve, reject) => execFile('docker', ['compose', '--env-file', path.join(lab.directory, 'lab.env'), '-f', path.join(root, 'deploy/lab/compose.yaml'), 'restart', 'gateway'], { timeout: 60000 }, error => error ? reject(error) : resolve()))
    await until(async () => {
      try { const items = await sdk.listDevices(); return items.some(device => device.id === runtime.deviceId && device.online) } catch { return false }
    }, 'foreground device reconnects after its gateway restarts', 45000)
    assert.equal((await sdk.profile()).organization, 'KK Code Enterprise Lab')
    const after = await sdk.request('sessions.get', { sessionId })
    assert.equal(after.messages.length, before.messages.length)
    const replay = await sdk.request('events.list', { sessionId, after: Math.max(0, before.eventCursor - 1) })
    assert.ok(replay.events.some(event => event.seq === before.eventCursor))
    assert.equal((await sdk.request('settings.get')).provider['lab-openai'].api_key, '[REDACTED]')
    await expect(browserOwner.page.getByText('LAB_HELLO_OK', { exact: true }).first()).toBeVisible()
    console.log('PASS: gateway restart preserves database login/device ownership and resumes Relay/history/event replay')
  }
  await browserOwner.page.screenshot({ path: path.join(runDirectory, 'enterprise-live-web.png'), animations: 'disabled' })

  assert.equal((await share('view')).status, 200)
  assert.equal((await viewerSdk.request('sessions.get', { sessionId })).id, sessionId)
  const retiredCredentials = JSON.parse(await readFile(path.join(state, 'remote-credentials.json'), 'utf8'))
  const stop = child(['remote', 'stop']); assert.equal(await stop.closed, 0)
  await remote.closed
  await until(async () => !(await sdk.listDevices()).find(device => device.id === runtime.deviceId)?.online, 'foreground shutdown makes device offline')
  const status = child(['remote', 'status']); await status.closed; assert.equal(JSON.parse(status.output()).running, false)
  console.log('PASS: remote stop, authenticated status and foreground device-offline lifecycle')

  const unbind = child(['remote', 'unbind', '--confirm', runtime.deviceId])
  assert.equal(await unbind.closed, 0, 'Exact-ID local unbind must succeed')
  const unbound = JSON.parse(await readFile(path.join(state, 'device', 'identity.json'), 'utf8'))
  assert.notEqual(unbound.id, runtime.deviceId); assert.equal(unbound.owner, null)
  assert.equal((await sdk.listDevices()).some(device => device.id === runtime.deviceId), false)
  await assert.rejects(viewerSdk.request('sessions.get', { sessionId }), error => error.status === 403)
  assert.equal((await labPost(lab, '/auth/refresh', { refresh_token: retiredCredentials.refresh_token })).status, 401)
  assert.ok([401, 1008].includes(await retiredDeviceToken(retiredCredentials.access_token, runtime.deviceId)))
  console.log('PASS: exact-ID CLI unbind rotates identity, removes old shares and revokes old device access/refresh credentials')

  const noConsent = child(['remote', 'transfer', '--gateway', lab.gateway, '--confirm', unbound.id])
  assert.notEqual(await noConsent.closed, 0)
  const transfer = child(['remote', 'transfer', '--gateway', lab.gateway, '--confirm', unbound.id, '--include-history'])
  const transferUrl = await until(() => {
    if (transfer.process.exitCode != null) throw new Error('Explicit history transfer exited before SSO approval')
    return transfer.output().match(/https:\/\/[^\s]+\/login\?code=\d+/)?.[0]
  }, 'new-owner transfer login URL')
  await approveLabLogin(browser, lab, { url: transferUrl, account: 'viewer' })
  assert.equal(await transfer.closed, 0, 'Explicit consent plus new-owner SSO must transfer binding')
  remote = child(['remote', '--trust', '--root', workspace])
  const transferred = await until(async () => {
    if (remote.process.exitCode != null) throw new Error('Transferred foreground hub exited before registration')
    try { const value = JSON.parse(await readFile(path.join(state, 'remote-status.json'), 'utf8')); return value.connection === 'connected' && value } catch { return null }
  }, 'transferred device registers under new account')
  assert.equal(transferred.deviceId, unbound.id)
  const newOwner = new DeviceClient({ url: lab.gateway, deviceId: transferred.deviceId, token: viewer.credentials.access_token, retries: 0 })
  const formerOwner = new DeviceClient({ url: lab.gateway, deviceId: transferred.deviceId, token: peer.credentials.access_token, retries: 0 })
  assert.equal((await newOwner.request('status')).device.owner, viewer.credentials.profile.id)
  const inherited = await newOwner.request('sessions.get', { sessionId })
  assert.ok(JSON.stringify(inherited.messages).includes('LAB_HELLO_OK'))
  assert.ok(JSON.stringify(inherited.messages).includes('LAB_ATTACHMENT_OK'))
  assert.equal((await newOwner.request('settings.get')).provider['lab-openai'].api_key, '[REDACTED]')
  await assert.rejects(formerOwner.request('status'), error => error.status === 403)
  await assert.rejects(formerOwner.request('sessions.get', { sessionId }), error => error.status === 403)
  assert.equal((await formerOwner.listDevices()).some(device => device.id === transferred.deviceId), false)
  console.log('PASS: explicit CLI account/history transfer, fresh device namespace and new-owner-only access to retained history/configuration')
  const stopTransferred = child(['remote', 'stop']); assert.equal(await stopTransferred.closed, 0)
  await remote.closed
  await until(async () => !(await newOwner.listDevices()).find(device => device.id === transferred.deviceId)?.online, 'transferred hub stops foreground exposure')
  console.log(JSON.stringify({ suite: 'enterprise', result: 'passed', workspace: runDirectory, gateway: lab.gateway }))
} finally {
  await Promise.all([...children].filter(item => item.process.exitCode == null && item.process.signalCode == null).map(async item => { item.process.kill('SIGTERM'); await Promise.race([item.closed, new Promise(resolve => setTimeout(resolve, 5000))]) }))
  await browser.close(); await fixture.close()
}
