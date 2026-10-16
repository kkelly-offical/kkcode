import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

// Synthetic transport, real DOM/input. No model inference or live gateway.
const assets = path.resolve('src/web')
const session = { id: 'history', cwd: '/workspace/one/app', title: '历史定位验收', modeId: 'agent', status: 'running', model: 'fixture-model' }
const messages = Array.from({ length: 20 }, (_, index) => ({ id: `msg-${index}`, role: index % 2 ? 'assistant' : 'user', createdAt: index + 1, content: index % 2 ? `第 ${index} 次分析：保持原有接口。\n\n` + '这里是可以自由阅读的历史记录。'.repeat(28) : `请检查并发刷新 ${index / 2 + 1}` }))
let sequence = 0
const events = []
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
  if (pathname === '/api/v1/discovery') return json({ protocolVersion: '1' })
  if (pathname === '/api/v1/profile') return json({ name: 'fixture', organization: '隔离界面验证' })
  if (pathname === '/api/v1/devices') return json([{ id: 'test-device', name: 'fixture', online: true }])
  if (pathname.endsWith('/rpc')) {
    let text = ''; for await (const chunk of req) text += chunk
    const { method, params = {} } = JSON.parse(text), reply = result => json({ result })
    if (method === 'status') return reply({ device: { name: 'fixture' }, roots: [session.cwd], active: [session.id] })
    if (method === 'sessions.list') return reply([session])
    if (method === 'sessions.get') {
      if (params.view === 'subagents') return reply({ sessionId: params.sessionId, subagents: [] })
      return reply({ ...session, running: true, turnState: { executionId: 'fixture-turn', phase: 'running' }, messages, parts: [], eventCursor: sequence })
    }
    if (method === 'events.list') return reply({ events: events.filter(event => event.seq > (params.after || 0)), cursor: sequence, running: true, approvals: [] })
    if (method === 'todos.list') return reply({ revision: 0, items: [] })
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, reducedMotion: 'reduce' })
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: session.title, exact: true }).first().click()
  const viewport = page.getByRole('region', { name: '对话内容' })
  await expect.poll(() => viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(5)
  await viewport.evaluate(node => { node.scrollTop = 450 })
  await expect(page.getByRole('button', { name: '↓ 回到最新', exact: true })).toBeVisible()
  const before = await viewport.evaluate(node => node.scrollTop)
  await page.getByRole('button', { name: '对话记录', exact: true }).click()
  await page.getByRole('textbox', { name: '查找对话记录', exact: true }).fill('并发刷新 10')
  await page.getByRole('button').filter({ hasText: '请检查并发刷新 10' }).first().click()
  await expect(page.locator('.history-highlight')).toBeVisible()
  const targetPosition = await viewport.evaluate(node => node.scrollTop)
  events.push({ id: `event-${++sequence}`, seq: sequence, type: 'stream.text.delta', sessionId: session.id, turnId: 'fixture-turn', timestamp: Date.now(), payload: { text: '新的内容仍保存在末尾。'.repeat(100) } })
  await expect(page.locator('.message.assistant').last()).toContainText('新的内容仍保存在末尾')
  const after = await viewport.evaluate(node => node.scrollTop)
  assert.ok(Math.abs(after - targetPosition) < 20, `history anchor must survive streaming (${targetPosition} -> ${after})`)
  await page.getByRole('button', { name: '返回刚才的位置', exact: true }).click()
  const returned = await viewport.evaluate(node => node.scrollTop)
  assert.ok(Math.abs(returned - before) < 20, `history return must restore the reading position (${before} -> ${returned})`)
  assert.deepEqual(errors, [])
  console.log('Web history navigation: anchored streaming and return to the previous reading position passed.')
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
