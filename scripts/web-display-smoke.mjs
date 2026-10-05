import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

// Synthetic gateway RPC and history, real browser layout/input. No model calls.
const assets = path.resolve(process.env.KKCODE_LAYOUT_ASSETS || 'src/web')
const baseline = process.env.KKCODE_LAYOUT_BASELINE === '1'
const output = path.resolve(process.env.KKCODE_LAYOUT_OUTPUT || 'test-results/web-display')
const devices = [{ id: 'workstation', name: '日常工作站', online: true }, { id: 'compute', name: 'h100 · 算力设备', online: true }, { id: 'offline', name: '离线笔记本', online: false }]
const session = { id: 'reading', title: '项目说明与运维记录', cwd: '/workspace/project', model: 'fixture-model', providerType: 'fixture', modeId: 'agent', context: { tokens: 42000, limit: 1048576, source: 'provider-usage' } }
const messages = Array.from({ length: 12 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', createdAt: i + 1,
  content: i % 2 ? Array.from({ length: 32 }, (_, n) => `段落 ${i}-${n}：这里记录项目的结构、部署步骤与运行状态。阅读历史消息时，可以自由滚动，新的输出应保持在末尾，不打断正在查看的位置。`).join('\n\n') : `请说明第 ${i / 2 + 1} 部分的工作。` }))
const events = [], calls = []
let sequence = 0
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), pathname = url.pathname
  const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
  if (pathname === '/api/v1/discovery') return json({ protocolVersion: '1' })
  if (pathname === '/api/v1/profile') return json({ id: 'fixture', name: '显示检查', organization: '本地模拟网关' })
  if (pathname === '/api/v1/devices') return json(devices)
  if (pathname.endsWith('/rpc')) {
    let body = ''; for await (const chunk of req) body += chunk
    const { method, params = {} } = JSON.parse(body); calls.push(method)
    const device = devices.find(item => pathname.includes(`/${item.id}/`)) || devices[0]
    const reply = result => json({ result })
    if (method === 'status') return reply({ device: { name: device.name }, roots: ['/workspace/project'] })
    if (method === 'sessions.list') return reply([session])
    if (method === 'sessions.get') return reply(params.view === 'subagents' ? { sessionId: session.id, subagents: [] } : { ...session, messages, parts: [], eventCursor: sequence, running: false })
    if (method === 'commands.list') return reply([{ name: 'theme', description: '外观' }])
    if (method === 'settings.get') return reply({ provider: { default: 'fixture', fixture: { type: 'openai-compatible', default_model: 'fixture-model' } } })
    if (method === 'events.list') return reply({ events: events.filter(event => event.seq > (params.after || 0)), cursor: sequence, running: false, approvals: [] })
    if (method === 'todos.list') return reply({ revision: 0, items: [] })
    if (method.startsWith('control.')) return reply({ yours: true })
    res.writeHead(400); return res.end(JSON.stringify({ error: { message: `Unexpected fixture RPC: ${method}` } }))
  }
  if (pathname.startsWith('/api/')) { res.writeHead(404); return res.end() }
  const file = path.resolve(assets, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (!file.startsWith(assets + path.sep)) { res.writeHead(404); return res.end() }
  try { res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)) }
  catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = [], metrics = []
page.on('pageerror', error => errors.push(error.message))
const distance = () => page.locator('.transcript').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)
const chooseSession = () => page.getByRole('button', { name: session.title, exact: true }).first().click()
const append = text => { events.push({ id: `event-${++sequence}`, seq: sequence, type: 'stream.text.delta', sessionId: session.id, turnId: 'display-live', payload: { text } }) }
async function measure(name) {
  await page.waitForTimeout(150)
  const value = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    return { viewport: { width: innerWidth, height: innerHeight }, header: rect('main > header'), transcript: rect('.transcript'), composer: rect('.composer-wrap'), message: rect('.message.assistant'), overflow: document.documentElement.scrollWidth > innerWidth + 1 }
  })
  metrics.push({ name, ...value }); await writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n'); await page.screenshot({ path: path.join(output, `${name}.png`) })
  return value
}
try {
  await mkdir(output, { recursive: true }); await page.goto(`http://127.0.0.1:${server.address().port}`)
  await chooseSession(); await expect.poll(distance).toBeLessThan(5)
  for (const [width, height] of [[1440, 900], [1366, 768], [1024, 600], [1920, 1080]]) {
    await page.setViewportSize({ width, height }); await expect.poll(distance).toBeLessThan(5)
    const value = await measure(`desktop-${width}`)
    assert.equal(value.overflow, false)
    if (!baseline) {
      await expect(page.locator('.device-strip')).toHaveCount(0)
      assert.ok(value.header.height <= 56, 'header must fit one compact desktop row')
      assert.ok(value.transcript.height >= height * .64, 'conversation must retain most of the viewport')
      assert.ok(value.transcript.y <= 60, 'no duplicated device row above the conversation')
    }
  }
  if (!baseline) {
    await page.getByRole('combobox', { name: '设备', exact: true }).selectOption('compute')
    await chooseSession(); await expect(page.getByRole('button', { name: '切换设备，当前 h100 · 算力设备' })).toBeVisible()
    await expect.poll(distance).toBeLessThan(5)
    await page.setViewportSize({ width: 1440, height: 900 })
    const view = await page.locator('.transcript').boundingBox()
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
    await page.mouse.wheel(0, -650)
    await expect(page.getByRole('button', { name: '↓ 回到最新' })).toBeVisible()
    const before = await page.locator('.transcript').boundingBox()
    const position = await page.locator('.transcript').evaluate(node => node.scrollTop)
    append('\n\n显示补丁正在接收新输出。\n\n'.repeat(25))
    await expect(page.locator('.message.assistant').last()).toContainText('显示补丁正在接收新输出。')
    assert.ok(Math.abs(await page.locator('.transcript').evaluate(node => node.scrollTop) - position) < 20)
    assert.equal((await page.locator('.transcript').boundingBox()).height, before.height, 'latest button must float without shrinking reading space')
    const anchor = await page.evaluate(() => {
      const v = document.querySelector('.transcript').getBoundingClientRect()
      const p = [...document.querySelectorAll('.markdown p')].find(node => { const r = node.getBoundingClientRect(); return r.top >= v.top + 10 && r.top < v.top + 180 })
      p.setAttribute('data-reading-anchor', 'true'); return p.getBoundingClientRect().top - v.top
    })
    await page.locator('.studio-nav').getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await page.getByLabel('文字大小', { exact: true }).selectOption('125')
    await page.getByLabel('阅读宽度', { exact: true }).selectOption('focused')
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('.message.assistant').first().evaluate(node => getComputedStyle(node).fontSize)).toBe('18.75px')
    const moved = await page.evaluate(() => document.querySelector('[data-reading-anchor]').getBoundingClientRect().top - document.querySelector('.transcript').getBoundingClientRect().top)
    assert.ok(Math.abs(moved - anchor) < 100, `font/width reflow must retain the same reading paragraph (${anchor} -> ${moved})`)
    await page.reload(); await chooseSession()
    await expect.poll(() => page.locator('.message.assistant').first().evaluate(node => getComputedStyle(node).fontSize)).toBe('18.75px')
    await expect.poll(distance).toBeLessThan(5)
    await page.evaluate(() => {
      window.__displayTrace = [];
      const v = document.querySelector('.transcript');
      const log = event => window.__displayTrace.push({event, time:performance.now(), top:v.scrollTop, height:v.scrollHeight, view:v.clientHeight, focus:document.activeElement?.className});
      v.addEventListener('scroll', () => log('scroll'));
      document.addEventListener('click', event => { if(event.target.closest('.back-to-latest')) {log('click-before');queueMicrotask(() => log('click-microtask'));requestAnimationFrame(() => log('click-frame'))} }, true);
      document.addEventListener('keydown', () => log('key'));
    });
    await page.locator('.transcript').focus(); await page.keyboard.press('PageUp')
    await expect(page.getByRole('button', { name: '↓ 回到最新' })).toBeVisible()
    await page.getByRole('button', { name: '↓ 回到最新' }).click(); await expect.poll(distance).toBeLessThan(5)
    // Horizontal scrolling and browser zoom gestures must not change follow intent.
    await page.locator('.transcript').dispatchEvent('wheel', { deltaY: -120, ctrlKey: true })
    await page.locator('.transcript').dispatchEvent('wheel', { deltaX: -150, deltaY: -1 })
    append('\n\n仍然跟随最新文字。\n\n'.repeat(10))
    await expect(page.locator('.message.assistant').last()).toContainText('仍然跟随最新文字。')
    await expect.poll(distance).toBeLessThan(5)
    const columns = Array.from({ length: 18 }, (_, i) => `column_${i}_details`);
    append('\n\n```text\n' + Array.from({ length: 160 }, (_, i) => `Log line ${i}: ` + 'readable-code-without-forced-wrapping '.repeat(6)).join('\n') + '\n```\n\n| ' + columns.join(' | ') + ' |\n| ' + columns.map(() => '---').join(' | ') + ' |\n| ' + columns.join(' | ') + ' |\n\n');
    const code = page.locator('.markdown pre').last(), table = page.locator('.markdown table').last();
    await expect(code).toContainText('Log line 159'); await code.scrollIntoViewIfNeeded();
    await code.evaluate(node => { node.scrollTop = 800; node.scrollLeft = 250; });
    await table.evaluate(node => { node.scrollLeft = 200; });
    const box = await code.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -180);
    await expect.poll(() => code.evaluate(node => node.scrollTop)).toBeLessThan(750);
    const keyboardTop = await code.evaluate(node => node.scrollTop);
    await code.focus(); await page.keyboard.press('ArrowUp');
    await expect.poll(() => code.evaluate(node => node.scrollTop)).toBeLessThan(keyboardTop - 20);
    const nested = await code.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }));
    const outerTop = await page.locator('.transcript').evaluate(node => node.scrollTop);
    append('\n\n代码与表格的位置应保留。\n\n');
    await expect(page.locator('.message.assistant').last()).toContainText('代码与表格的位置应保留。');
    assert.ok(Math.abs(await code.evaluate(node => node.scrollTop) - nested.top) < 3, 'stream rendering must retain the nested code scroll position');
    assert.equal(await code.evaluate(node => node.scrollLeft), nested.left);
    assert.equal(await table.evaluate(node => node.scrollLeft), 200);
    assert.ok(Math.abs(await page.locator('.transcript').evaluate(node => node.scrollTop) - outerTop) < 20);
    assert.equal(calls.includes('settings.update'), false, 'reading preferences must stay local to this browser')
  }
  for (const [width, height] of [[390, 844], [320, 568], [720, 450]]) {
    await page.setViewportSize({ width, height })
    const value = await measure(`compact-${width}`); assert.equal(value.overflow, false)
    if (!baseline) {
      assert.ok(value.header.height <= 60)
      assert.ok(value.transcript.height >= height * .45)
      await expect(page.getByRole('button', { name: /^切换设备，当前/ })).toBeVisible()
    }
  }
  assert.deepEqual(errors, []); await writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n')
  console.log(`Web display ${baseline ? 'baseline measured' : 'passed'}: multi-device layout, wheel and keyboard, streaming/nested scroll, reading reflow, preferences and narrow/short windows.`)
} catch (error) { await writeFile(path.join(output, 'scroll-failure.json'), JSON.stringify(await page.evaluate(() => window.__displayTrace || []), null, 2)); await page.screenshot({path:path.join(output,'failure.png')}); throw error; } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
