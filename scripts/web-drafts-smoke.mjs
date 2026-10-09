import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

// Synthetic gateway transport, real DOM/input. No model inference or live gateway.
const assets = path.resolve('src/web')
const devices = [
  { id: 'device-a', name: '工作站 A', online: true },
  { id: 'device-b', name: '工作站 B', online: true },
]
const sessions = {
  'device-a': [
    { id: 'alpha-one', title: 'Alpha 一', cwd: '/workspace/alpha', modeId: 'agent' },
    { id: 'alpha-two', title: 'Alpha 二', cwd: '/workspace/alpha', modeId: 'agent' },
    { id: 'beta-one', title: 'Beta 项目', cwd: '/workspace/beta', modeId: 'agent' },
  ],
  'device-b': [
    { id: 'device-b-one', title: 'Device B 会话', cwd: '/workspace/device-b', modeId: 'agent' },
  ],
}
const roots = { 'device-a': '/workspace/alpha', 'device-b': '/workspace/device-b' }
const attachments = new Map(), calls = []
let created = 0, attachment = 0, logoutCalls = 0, commandStarted = false, successStarted = false, releaseCommand, releaseSuccess
const commandGate = new Promise(resolve => { releaseCommand = resolve })
const successGate = new Promise(resolve => { releaseSuccess = resolve })
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  if (pathname === '/api/v1/discovery') return json(response, { protocolVersion: '1' })
  if (pathname === '/api/v1/profile') return json(response, { id: 'fixture', name: '草稿回归', organization: '隔离网关' })
  if (pathname === '/api/v1/devices') return json(response, devices)
  if (pathname === '/auth/logout') { logoutCalls++; return json(response, { ok: true }) }
  if (pathname.endsWith('/rpc')) {
    let body = ''
    for await (const chunk of request) body += chunk
    const { method, params = {} } = JSON.parse(body)
    const deviceId = devices.find(device => pathname === `/api/v1/devices/${device.id}/rpc`)?.id || 'device-a'
    const deviceSessions = sessions[deviceId]
    calls.push({ deviceId, method, params })
    const reply = result => json(response, { result })
    if (method === 'status') return reply({ device: { name: devices.find(device => device.id === deviceId).name }, roots: [roots[deviceId]] })
    if (method === 'sessions.list') return reply(deviceSessions)
    if (method === 'sessions.get') {
      const session = deviceSessions.find(item => item.id === params.sessionId)
      if (!session) return json(response, { error: { code: 'not_found', message: '会话不存在' } }, 404)
      if (params.view === 'subagents') return reply({ sessionId: session.id, subagents: [] })
      return reply({ ...session, messages: [], parts: [], running: false, eventCursor: 0 })
    }
    if (method === 'sessions.create') {
      const session = { id: `created-${++created}`, title: `恢复会话 ${created}`, cwd: params.cwd || roots[deviceId], modeId: 'agent' }
      deviceSessions.push(session)
      return reply(session)
    }
    if (method === 'events.list') return reply({ events: [], cursor: 0, running: false, approvals: [] })
    if (method === 'commands.list') return reply([])
    if (method === 'settings.get') return reply({ provider: {} })
    if (method === 'todos.list') return reply({ revision: 0, items: [] })
    if (method === 'control.acquire') return reply({ yours: true, leaseId: 'fixture-lease' })
    if (method === 'control.release') return reply({ ok: true })
    if (method === 'attachments.upload') {
      const item = { id: `attachment-${++attachment}`, name: params.name, mediaType: params.mediaType, size: params.data.length }
      attachments.set(item.id, { deviceId, sessionId: params.sessionId })
      return reply(item)
    }
    if (method === 'attachments.remove') { attachments.delete(params.id); return reply({ ok: true }) }
    if (method === 'turns.start') {
      if (params.prompt === '新建会话失败草稿') return json(response, { error: { code: 'fixture_send', message: '模拟发送失败' } }, 409)
      if (params.prompt === '延迟成功正文') { successStarted = true; await successGate }
      return reply({ accepted: true, executionId: params.executionId })
    }
    if (method === 'commands.run' && params.command === '/fail') {
      commandStarted = true
      await commandGate
      return json(response, { error: { code: 'fixture_command', message: '模拟命令失败' } }, 409)
    }
    return json(response, { error: { code: 'unexpected', message: `Unexpected RPC: ${method}` } }, 400)
  }
  if (pathname.startsWith('/api/')) return json(response, { error: { code: 'not_found', message: 'Not found' } }, 404)
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
let abortReload = false
await page.route('**/*', route => {
  if (abortReload && route.request().resourceType() === 'document') return route.abort('aborted')
  return route.continue()
})
const sessionButton = title => page.locator('.sidebar nav').getByRole('button', { name: new RegExp(title) }).first()
const input = page.getByRole('textbox', { name: '消息', exact: true })
const chooseProject = async project => {
  await page.getByRole('button', { name: '选择项目与工作区', exact: true }).click()
  await page.locator('.project-option').filter({ hasText: project }).click()
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await expect(input).toBeVisible()
  await chooseProject('/workspace/alpha')
  await input.fill('项目 A 空白草稿')
  await chooseProject('/workspace/beta')
  await expect(input).toHaveValue('')
  await input.fill('项目 B 空白草稿')
  await chooseProject('/workspace/alpha')
  await expect(input).toHaveValue('项目 A 空白草稿')
  await input.fill('')
  await chooseProject('/workspace/beta')
  await expect(input).toHaveValue('项目 B 空白草稿')
  await input.fill('')
  await chooseProject('/workspace/alpha')
  await expect(input).toHaveValue('')

  await sessionButton('Alpha 一').click()
  await input.fill('A1 私密正文')
  await page.locator('input[aria-label="添加图片或文件"]').setInputFiles({ name: 'a-one.txt', mimeType: 'text/plain', buffer: Buffer.from('A1 attachment') })
  await expect(page.getByRole('button', { name: '移除附件 a-one.txt', exact: true })).toBeEnabled()

  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.composer-attachment')).toHaveCount(0)
  await input.fill('A2 私密正文')
  await sessionButton('Alpha 一').click()
  await expect(input).toHaveValue('A1 私密正文')
  await expect(page.getByRole('button', { name: '移除附件 a-one.txt', exact: true })).toBeEnabled()
  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('A2 私密正文')

  await sessionButton('Alpha 一').click()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.composer-attachment')).toHaveCount(0)
  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('A2 私密正文')

  await sessionButton('Alpha 一').click()
  await input.fill('延迟成功正文')
  await page.locator('input[aria-label="添加图片或文件"]').setInputFiles({ name: 'delayed.txt', mimeType: 'text/plain', buffer: Buffer.from('Delayed attachment') })
  await expect(page.getByRole('button', { name: '移除附件 delayed.txt', exact: true })).toBeEnabled()
  const delayedResponse = page.waitForResponse(response => response.request().postData()?.includes('"method":"turns.start"') && response.request().postData()?.includes('延迟成功正文'))
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => successStarted).toBe(true)
  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('A2 私密正文')
  releaseSuccess()
  await delayedResponse
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(input).toHaveValue('A2 私密正文')
  await sessionButton('Alpha 一').click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.composer-attachment')).toHaveCount(0)
  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('A2 私密正文')

  await chooseProject('/workspace/beta')
  await expect(input).toHaveValue('')
  await sessionButton('Beta 项目').click()
  await input.fill('Beta 私密正文')
  await chooseProject('/workspace/alpha')
  await expect(input).toHaveValue('')
  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('A2 私密正文')

  await page.getByRole('combobox', { name: '设备', exact: true }).selectOption('device-b')
  await expect(input).toHaveValue('')
  await sessionButton('Device B 会话').click()
  await input.fill('B 私密正文')
  await page.locator('input[aria-label="添加图片或文件"]').setInputFiles({ name: 'b-one.txt', mimeType: 'text/plain', buffer: Buffer.from('B attachment') })
  await expect(page.getByRole('button', { name: '移除附件 b-one.txt', exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: '设备', exact: true }).selectOption('device-a')
  await expect(input).toHaveValue('')
  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('A2 私密正文')
  await page.getByRole('combobox', { name: '设备', exact: true }).selectOption('device-b')
  await sessionButton('Device B 会话').click()
  await expect(input).toHaveValue('B 私密正文')
  await expect(page.getByRole('button', { name: '移除附件 b-one.txt', exact: true })).toBeEnabled()

  await page.getByRole('combobox', { name: '设备', exact: true }).selectOption('device-a')
  await expect(input).toHaveValue('')
  await input.fill('新建会话失败草稿')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.chat-title strong')).toHaveText('恢复会话 1')
  await expect(input).toHaveValue('新建会话失败草稿')
  await expect(page.getByRole('status')).toContainText('模拟发送失败')
  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('A2 私密正文')
  await sessionButton('恢复会话 1').click()
  await expect(input).toHaveValue('新建会话失败草稿')

  await input.fill('/fail')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect.poll(() => commandStarted).toBe(true)
  await sessionButton('Alpha 二').click()
  await expect(input).toHaveValue('A2 私密正文')
  releaseCommand()
  await expect.poll(() => calls.filter(call => call.method === 'control.release').length).toBeGreaterThan(0)
  await sessionButton('恢复会话 1').click()
  await expect(input).toHaveValue('/fail')

  abortReload = true
  await page.locator('.studio-nav').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: /草稿回归/ }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect.poll(() => logoutCalls).toBe(1)
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('')
  await page.getByRole('combobox', { name: '设备', exact: true }).selectOption('device-b')
  await sessionButton('Device B 会话').click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.composer-attachment')).toHaveCount(0)
  assert.deepEqual(errors, [])
  console.log('Web scoped drafts: blank-project and cross-session/device isolation, delayed success/failure recovery, attachment alignment, and logout cleanup passed.')
} finally {
  releaseCommand()
  releaseSuccess()
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
