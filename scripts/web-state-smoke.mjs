import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve, started: false, armed: false }
}
const assets = path.resolve('src/web')
const devices = [
  { id: 'device-a', name: '工作站 A', online: true },
  { id: 'device-b', name: '工作站 B', online: true },
]
const sessions = {
  'device-a': [
    { id: 'alpha-one', title: 'Alpha 一', cwd: '/workspace/alpha', modeId: 'agent', model: 'model-a', providerType: 'provider-a' },
    { id: 'alpha-two', title: 'Alpha 二', cwd: '/workspace/alpha', modeId: 'agent', model: 'model-b', providerType: 'provider-b' },
  ],
  'device-b': [
    { id: 'device-b-one', title: 'Device B 会话', cwd: '/workspace/device-b', modeId: 'agent', model: 'model-b', providerType: 'provider-b' },
  ],
}
const roots = { 'device-a': '/workspace/alpha', 'device-b': '/workspace/device-b' }
const settings = {
  'device-a': { provider: { default: 'provider-a', 'provider-a': { type: 'openai', default_model: 'model-a' } } },
  'device-b': { provider: { default: 'provider-b', 'provider-b': { type: 'openai', default_model: 'model-b' } } },
}
const calls = [], streams = new Set(), heldEvents = new Set()
const configureGate = deferred(), listGate = deferred(), eventsGate = deferred()
const slowBatch = { armed: false }
const recovery = { enabled: false, failures: 0, unauthorized: false }
let lease = 0
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost'), pathname = url.pathname
  if (pathname === '/api/v1/discovery') return json(response, { protocolVersion: '1' })
  if (pathname === '/api/v1/profile') return json(response, { id: 'fixture', name: '状态回归', organization: '隔离网关' })
  if (pathname === '/api/v1/devices') return json(response, devices)
  if (pathname === '/auth/refresh') { calls.push({ method: 'auth.refresh' }); return json(response, { access_token: 'refreshed-token' }) }
  if (pathname.endsWith('/events/stream')) {
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId || !recovery.enabled || !pathname.includes('/device-a/')) return json(response, { error: { code: 'not_found', message: 'Not found' } }, 404)
    if (recovery.unauthorized) {
      recovery.unauthorized = false
      calls.push({ method: 'device.stream.unauthorized' })
      return json(response, { error: { code: 'unauthorized', message: '刷新登录' } }, 401)
    }
    if (recovery.failures > 0) {
      recovery.failures--
      calls.push({ method: 'device.stream.failure' })
      return json(response, { error: { code: 'temporarily_unavailable', message: '暂时不可用' } }, 503)
    }
    sessions['device-a'][1].title = '恢复后的权威标题'
    settings['device-a'] = { provider: { default: 'recovered', recovered: { type: 'openai', default_model: 'recovered-model' } } }
    calls.push({ method: 'device.stream.connected' })
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    response.write('event: connected\ndata: {"type":"connected","schemaVersion":"1","deviceId":"device-a","online":true,"active":[]}\n\n')
    streams.add(response)
    response.on('close', () => streams.delete(response))
    return
  }
  if (pathname.endsWith('/rpc')) {
    let body = ''
    for await (const chunk of request) body += chunk
    const { method, params = {} } = JSON.parse(body)
    const deviceId = devices.find(device => pathname === `/api/v1/devices/${device.id}/rpc`)?.id || 'device-a'
    const deviceSessions = sessions[deviceId]
    calls.push({ deviceId, method, params })
    const reply = result => json(response, { result })
    if (method === 'status') return reply({ device: { name: devices.find(device => device.id === deviceId).name }, roots: [roots[deviceId]] })
    if (method === 'sessions.list') {
      if (listGate.armed && deviceId === 'device-a') {
        listGate.armed = false; listGate.started = true
        await listGate.promise
      }
      return reply(deviceSessions)
    }
    if (method === 'sessions.get') {
      const session = deviceSessions.find(item => item.id === params.sessionId)
      if (!session) return json(response, { error: { code: 'not_found', message: '会话不存在' } }, 404)
      if (params.view === 'subagents') return reply({ sessionId: session.id, subagents: [] })
      return reply({ ...session, messages: [], parts: [], running: false, eventCursor: 0 })
    }
    if (method === 'events.list') {
      if (heldEvents.has(params.sessionId)) await eventsGate.promise
      if (slowBatch.armed && params.sessionId === 'alpha-one') {
        slowBatch.armed = false
        return reply({
          events: [
            { id: 'slow-result', seq: 1, type: 'turn.result', sessionId: 'alpha-one', payload: { executionId: 'slow-a' } },
            { id: 'slow-config', seq: 2, type: 'session.configured', sessionId: 'alpha-one', payload: { modeId: 'auto', model: 'stale-model', providerType: 'stale-provider' } },
          ],
          cursor: 2,
          running: true,
          control: { yours: false },
          approvals: [{ id: 'slow-approval', sessionId: 'alpha-one', kind: 'question', request: { questions: [{ id: 'choice', text: 'A 的审批', options: [{ label: '继续', value: 'continue' }] }] } }],
        })
      }
      return reply({ events: [], cursor: 0, running: false, approvals: [], control: null })
    }
    if (method === 'sessions.configure') {
      const session = deviceSessions.find(item => item.id === params.sessionId)
      if (configureGate.armed && params.sessionId === 'alpha-one') {
        configureGate.armed = false; configureGate.started = true
        await configureGate.promise
        return reply({ ...session, modeId: 'auto', model: 'stale-model', providerType: 'stale-provider' })
      }
      return reply({ ...session, ...(params.mode ? { modeId: params.mode } : {}), ...(params.model ? { model: params.model } : {}), ...(params.provider ? { providerType: params.provider } : {}) })
    }
    if (method === 'control.acquire') return reply({ yours: true, leaseId: `lease-${++lease}` })
    if (method === 'control.release') return reply({ released: true })
    if (method === 'commands.list') return reply([])
    if (method === 'settings.get') return reply(settings[deviceId])
    if (method === 'todos.list') return reply({ revision: 0, items: [] })
    return json(response, { error: { code: 'unexpected', message: `Unexpected RPC: ${method}` } }, 400)
  }
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) return json(response, { error: { code: 'not_found', message: 'Not found' } }, 404)
  const file = path.resolve(assets, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (!file.startsWith(assets + path.sep)) return json(response, { error: 'Not found' }, 404)
  try {
    const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html'
    response.writeHead(200, { 'Content-Type': type })
    response.end(await readFile(file))
  } catch {
    response.writeHead(404); response.end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = []
page.on('pageerror', error => errors.push(error.message))
const sessionButton = title => page.locator('.sidebar nav').getByRole('button', { name: new RegExp(title) }).first()
const input = page.getByRole('textbox', { name: '消息', exact: true })
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await expect(input).toBeVisible()
  await sessionButton('Alpha 一').click()
  await expect(page.locator('.mode-chip')).toHaveAttribute('aria-label', '执行模式，当前 Agent')
  await expect(page.locator('.model-chip')).toContainText('model-a')

  configureGate.armed = true
  await page.locator('.mode-chip').click()
  await page.getByRole('menuitemradio', { name: /^Auto / }).click()
  await expect.poll(() => configureGate.started).toBe(true)
  await sessionButton('Alpha 二').click()
  await expect(page.locator('.mode-chip')).toHaveAttribute('aria-label', '执行模式，当前 Agent')
  await expect(page.locator('.model-chip')).toContainText('model-b')
  configureGate.resolve()
  await expect.poll(() => calls.some(call => call.method === 'control.release')).toBe(true)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.locator('.mode-chip')).toHaveAttribute('aria-label', '执行模式，当前 Agent')
  await expect(page.locator('.model-chip')).toContainText('model-b')
  await expect(page.locator('.model-chip')).not.toContainText('stale-model')
  await expect(page.locator('.toast')).toHaveCount(0)

  await sessionButton('Alpha 一').click()
  await expect(page.locator('.model-chip')).toContainText('model-a')
  heldEvents.add('alpha-two')
  slowBatch.armed = true; listGate.armed = true
  await expect.poll(() => listGate.started).toBe(true)
  await sessionButton('Alpha 二').click()
  await expect(page.locator('.mode-chip')).toHaveAttribute('aria-label', '执行模式，当前 Agent')
  await expect(page.locator('.model-chip')).toContainText('model-b')
  listGate.resolve()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.locator('.mode-chip')).toHaveAttribute('aria-label', '执行模式，当前 Agent')
  await expect(page.locator('.model-chip')).toContainText('model-b')
  await expect(page.locator('.model-chip')).not.toContainText('stale-model')
  await expect(page.locator('.run-banner')).toHaveCount(0)
  await expect(page.locator('.control-notice')).toHaveCount(0)
  await expect(page.locator('.approval')).toHaveCount(0)
  heldEvents.clear(); eventsGate.resolve()

  await page.getByRole('combobox', { name: '设备', exact: true }).selectOption('device-b')
  await expect(sessionButton('Device B 会话')).toBeVisible()
  recovery.enabled = true; recovery.failures = 6; recovery.unauthorized = true
  await page.getByRole('combobox', { name: '设备', exact: true }).selectOption('device-a')
  await expect.poll(() => calls.filter(call => call.method === 'device.stream.connected').length, { timeout: 50000 }).toBe(1)
  await expect(sessionButton('恢复后的权威标题')).toBeVisible()
  const connectedAt = calls.findIndex(call => call.method === 'device.stream.connected')
  assert.equal(calls.filter(call => call.method === 'auth.refresh').length, 1)
  assert.equal(calls.filter(call => call.method === 'device.stream.failure').length, 6)
  assert.equal(calls.slice(connectedAt + 1).some(call => call.method === 'settings.get'), true)
  assert.equal(calls.slice(connectedAt + 1).some(call => call.method === 'sessions.list'), true)
  assert.deepEqual(errors, [])
  console.log('Web state recovery: slow configure/list identity fences, six transient device-stream failures, SDK 401 refresh, bounded reconnect and authoritative snapshot refresh passed.')
} finally {
  configureGate.resolve(); listGate.resolve(); eventsGate.resolve()
  recovery.enabled = false
  for (const stream of streams) stream.end()
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
