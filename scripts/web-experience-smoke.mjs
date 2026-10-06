import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

// Synthetic transport, real DOM/input. No model inference or live gateway.
const output = path.resolve('test-results/web-experience'), assets = path.resolve('src/web')
const session = { id: 'experience', cwd: '/workspace/one/app', title: '重构登录模块', modeId: 'agent', status: 'running', model: 'fixture-model' }
const other = { id: 'other', cwd: '/workspace/two/app', title: '另一个应用', status: 'idle' }
const messages = Array.from({ length: 20 }, (_, index) => ({ id: `msg-${index}`, role: index % 2 ? 'assistant' : 'user', createdAt: index + 1, content: index % 2 ? `第 ${index} 次分析：保持原有接口。\n\n` + '这里是可以自由阅读的历史记录。'.repeat(28) : `请检查并发刷新 ${index / 2 + 1}` }))
const todos = { sessionId: session.id, revision: 1, items: [{ id: 'read', content: '读取项目结构', status: 'completed' }, { id: 'edit', content: '拆分刷新逻辑', activeForm: '正在拆分刷新逻辑', status: 'in_progress', dependencies: ['read'] }, { id: 'check', content: '核对调用方', status: 'pending' }] }
let sequence = 0
const events = []
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
  if (pathname === '/api/v1/discovery') return json({ protocolVersion: '1' })
  if (pathname === '/api/v1/profile') return json({ name: 'h100', organization: '隔离界面验证' })
  if (pathname === '/api/v1/devices') return json([{ id: 'test-device', name: 'h100', online: true }])
  if (pathname.endsWith('/rpc')) {
    let text = ''; for await (const chunk of req) text += chunk
    const { method, params = {} } = JSON.parse(text), reply = result => json({ result })
    if (method === 'status') return reply({ device: { name: 'h100' }, roots: [session.cwd], active: [session.id] })
    if (method === 'sessions.list') return reply([session, other])
    if (method === 'sessions.get') {
      if (params.view === 'subagents') return reply({ sessionId: params.sessionId, subagents: [] })
      return reply(params.sessionId === session.id ? { ...session, running: true, turnState: { executionId: 'fixture-turn', phase: 'running' }, messages, parts: [], todos, eventCursor: sequence } : { ...other, running: false, messages: [], parts: [] })
    }
    if (method === 'events.list') return reply({ events: events.filter(event => event.seq > (params.after || 0)), cursor: sequence, running: params.sessionId === session.id, approvals: [] })
    if (method === 'todos.list') return reply(todos)
    if (method === 'settings.get') return reply({ provider: {} })
    if (method === 'commands.list') return reply([])
    if (method.startsWith('control.')) return reply({ yours: true })
    res.writeHead(400); return res.end(JSON.stringify({ error: { message: `Unexpected RPC: ${method}` } }))
  }
  if (pathname.startsWith('/api/')) { res.writeHead(404); return res.end() }
  const file = path.resolve(assets, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (!file.startsWith(assets + path.sep)) { res.writeHead(404); return res.end() }
  try { res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)) } catch { res.writeHead(404); res.end() }
})
await mkdir(output, { recursive: true })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, reducedMotion: 'reduce' })
const errors = [], metrics = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: '重构登录模块', exact: false }).first().click()
  await expect(page.getByRole('complementary', { name: '会话活动' })).toBeVisible()
  await expect(page.getByRole('region', { name: '当前执行状态' })).toHaveCount(1)
  await expect(page.getByRole('list', { name: '待办任务列表' })).toContainText('拆分刷新逻辑')
  const viewport = page.getByRole('region', { name: '对话内容' })
  await expect.poll(() => viewport.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop)).toBeLessThan(5)
  for (const [width, height] of [[1440,1040],[1366,768],[1024,600]]) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    const box = await viewport.boundingBox()
    assert.ok(box.width > 350 && box.height > 210)
    metrics.push({ width, height, transcript: box })
    await page.screenshot({ path: path.join(output, `desktop-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 1040 })
  await viewport.evaluate(n => { n.scrollTop = 450 })
  await expect(page.getByRole('button', { name: '↓ 回到最新', exact: true })).toBeVisible()
  const before = await viewport.evaluate(n => n.scrollTop)
  await page.getByRole('button', { name: '对话记录', exact: true }).click()
  // The final historical question may initially clamp at the bottom. Explicit
  // navigation must still pause follow when the next streaming output arrives.
  await page.getByRole('textbox', { name: '查找对话记录', exact: true }).fill('并发刷新 10')
  await page.getByRole('button').filter({ hasText: '请检查并发刷新 10' }).first().click()
  await expect(page.locator('.history-highlight')).toBeVisible()
  const targetPosition = await viewport.evaluate(n => n.scrollTop)
  events.push({ id: `event-${++sequence}`, seq: sequence, type: 'stream.text.delta', sessionId: session.id, turnId: 'fixture-turn', timestamp: Date.now(), payload: { text: '新的内容仍保存在末尾。'.repeat(100) } })
  await expect(page.locator('.message.assistant').last()).toContainText('新的内容仍保存在末尾')
  assert.ok(Math.abs(await viewport.evaluate(n => n.scrollTop) - targetPosition) < 20)
  await page.getByRole('button', { name: '返回刚才的位置', exact: true }).click()
  assert.ok(Math.abs(await viewport.evaluate(n => n.scrollTop) - before) < 20)
  await page.setViewportSize({ width: 320, height: 568 })
  await expect(page.getByRole('button', { name: '像素伙伴', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(1)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.screenshot({ path: path.join(output, 'mobile-chat-320.png') })
  await page.setViewportSize({ width: 1440, height: 1040 })
  await page.getByRole('button', { name: '选择项目与工作区', exact: true }).click()
  await expect(page.getByRole('button').filter({ hasText: '/workspace/one/app' })).toBeVisible()
  await page.getByRole('button').filter({ hasText: '/workspace/two/app' }).click()
  await expect(page.locator('.sidebar nav')).toContainText('另一个应用')
  await expect(page.locator('.sidebar nav')).not.toContainText('重构登录模块')
  for (const [width,height] of [[390,844],[320,568]]) {
    await page.setViewportSize({ width,height })
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await page.screenshot({ path: path.join(output, `mobile-${width}.png`) })
  }
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ metrics, errors, modelCalls: 0 }, null, 2))
  console.log('Experience passed: task/activity structure, responsive layout, history anchor, streaming and exact project isolation.')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
