import { chromium, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// UI contract fixtures are deliberately separate from web-smoke's real device API acceptance.
const assets = path.resolve('src/web')
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const file = path.resolve(assets, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (!file.startsWith(`${assets}${path.sep}`)) { response.writeHead(404); response.end(); return }
  try { response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(file)) }
  catch { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []; page.on('pageerror', error => errors.push(error.message))
const externalRequests = []; page.on('request', request => { if (!request.url().startsWith(address)) externalRequests.push(request.url()) })
const calls = [], history = [{ id: 'hello', role: 'assistant', content: 'Contract test conversation.\n\n![Manual image link](https://external.invalid/manual)\n\n- [x] Checked Markdown item\n\n<img src="https://external.invalid/tracker"><span style="background:url(https://external.invalid/style)">Untrusted markup</span><svg><image href="https://external.invalid/svg" /></svg><style>@import "https://external.invalid/css";</style>', createdAt: 1 }], events = []
let seq = 1, gap = false, snapshots = 0, attachments = [], approvals = [], branch = 'main', clean = true, stale = false, liveEvents = [], liveTruncated = false
const session = { id: 'session-a', title: 'UI contract fixture', cwd: '/workspace', providerType: 'fixture', model: 'model-a', modeId: 'agent' }
const config = { provider: { default: 'fixture', fixture: { type: 'openai', default_model: 'model-a', base_url: 'https://fixture.invalid/v1', api_key: '[REDACTED]' } } }
const branchSnapshot = () => ({ cwd: '/workspace', current: branch, head: 'head', clean, stateToken: 'state-token', branches: [...new Set(['main', 'feature', 'occupied', branch])].map(name => ({ name, current: name === branch, checkedOut: name === 'occupied' })) })
const commands = ['keys', 'theme', 'like', 'profile', 'paste', 'history', 'resume', 'new', 'rewind', 'model', 'provider', 'mode', 'permission', 'status', 'help', 'clear', 'dash', 'exit'].map(name => ({ name, description: `${name} command` }))
await page.route('**/api/v1/discovery', route => route.fulfill({ status: 404, body: '' }))
await page.route('**/api/v1/rpc', async route => {
  const { method, params: p = {} } = route.request().postDataJSON(); calls.push({ method, params: p })
  let result
  try {
    if (method === 'status') result = { device: { name: 'UI test device' }, roots: ['/workspace'] }
    else if (method === 'sessions.list') result = [session]
    else if (method === 'sessions.get') { snapshots++; result = { ...session, eventCursor: seq, messages: p.before ? [{ id: 'earlier', role: 'user', content: 'Earlier paginated history.', createdAt: 0 }, history[0]] : history, parts: [], historyHasMore: !p.before, nextBefore: p.before ? null : 'hello', liveEvents: p.before ? [] : liveEvents, liveTruncated, running: liveEvents.length > 0 } }
    else if (method === 'sessions.create') result = { id: session.id, cwd: session.cwd }
    else if (method === 'commands.list') result = commands
    else if (method === 'settings.get') result = config
    else if (method === 'settings.update') { Object.assign(config.provider, p.config.provider); result = { saved: true } }
    else if (method === 'events.list') { result = { events: events.filter(event => event.seq > p.after), running: liveEvents.length > 0, approvals, gap, cursor: seq, earliest: gap ? seq + 1 : 1 }; gap = false }
    else if (method.startsWith('control.')) result = { yours: true }
    else if (method === 'models.discover') result = { models: [{ id: 'model-a' }, { id: 'model-b' }] }
    else if (method === 'sessions.configure') { Object.assign(session, { ...(p.model ? { model: p.model } : {}), ...(p.mode ? { modeId: p.mode } : {}) }); result = session }
    else if (method === 'attachments.upload') {
      if (p.name === '.env') throw Object.assign(new Error('Credential files cannot be uploaded'), { status: 403 })
      result = { id: `attachment-${attachments.length}`, name: p.name, mediaType: p.mediaType, size: Buffer.from(p.data, 'base64').length }; attachments.push(result)
    } else if (method === 'attachments.remove') { attachments = attachments.filter(item => item.id !== p.id); result = { removed: true } }
    else if (method === 'turns.start') {
      const turnId = `turn-${seq}`, start = { id: `event-${++seq}`, seq, type: 'turn.start', turnId, payload: { prompt: p.prompt } }, finish = { id: `event-${++seq}`, seq, type: 'turn.result', turnId, payload: { reply: 'Attachment received.' } }
      events.push(start, finish); history.push({ id: turnId, role: 'assistant', content: 'Attachment received.', createdAt: Date.now() }); result = { accepted: true }
    } else if (method === 'branches.list') result = branchSnapshot()
    else if (['branches.create', 'branches.switch'].includes(method)) { if (stale) { stale = false; throw new Error('Branch state changed') } branch = p.name; result = branchSnapshot() }
    else if (method === 'profile.get') result = { beginner: false, languages: ['中文'], tech_stack: [], design_style: '', extra_notes: '' }
    else if (method === 'profile.update') result = { saved: true }
    else if (method === 'approvals.resolve') { approvals = approvals.filter(item => item.id !== p.id); result = { resolved: true } }
    else if (method === 'commands.run') {
      const [name, ...args] = p.command.slice(1).trim().split(/\s+/), text = args.join(' ')
      const action = { history: 'sessions', resume: text ? 'session' : 'sessions', new: 'session', rewind: 'session', model: 'models', like: 'like', dash: 'home' }[name] || name
      result = { clientAction: action, args: text }
      if (action === 'sessions') result.items = [{ id: session.id, label: session.title, desc: session.cwd }]
      if (action === 'session') Object.assign(result, { sessionId: session.id, cwd: session.cwd, ...(name === 'rewind' ? { draft: 'Restored draft' } : {}) })
      if (name === 'permission' && text) result = { output: [{ text: `Permission: ${text}` }] }
      if (name === 'status' || name === 'help') result = { output: [{ text: 'Output remains readable until dismissed.' }], panels: [{ title: 'Diagnostic detail', text: 'No terminal-only picker is required.' }] }
    } else throw new Error(`Unhandled UI fixture RPC: ${method}`)
    await route.fulfill({ json: { result } })
  } catch (error) { await route.fulfill({ status: error.status || 400, json: { error: { code: 'fixture_error', message: error.message } } }) }
})
try {
  await page.goto(address)
  await page.locator('.remote-session').filter({ hasText: 'UI contract fixture' }).click()
  await expect(page.locator('.markdown img')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Manual image link ↗' })).toBeVisible()
  const input = page.getByRole('textbox', { name: '消息' }), dialog = page.getByRole('dialog')
  const command = async text => { await input.fill(text); await page.getByRole('button', { name: '发送', exact: true }).click() }
  const tools = async name => { await page.getByRole('button', { name: '添加与工具', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click(); await expect(page.getByText('Earlier paginated history.', { exact: true })).toBeVisible(); await expect(page.getByText('Contract test conversation.', { exact: true })).toHaveCount(1)
  assert.deepEqual(calls.find(call => call.method === 'sessions.get' && call.params.before).params, { sessionId: session.id, before: 'hello', limit: 100 })
  await command('/keys'); await expect(page.getByRole('status')).toContainText('终端快捷键只在 CLI 中提供'); await expect(dialog).toHaveCount(0)
  await expect(input).toBeEditable()
  // A visible modal must already own focus and Escape handling, even before
  // React's deferred passive effects get a turn on a loaded/slow browser.
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const sheet = document.querySelector('[role="dialog"]')
      if (!sheet) return
      observer.disconnect()
      document.documentElement.dataset.sheetFocusReady = String(document.activeElement === sheet)
      sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    observer.observe(document.body, { childList: true, subtree: true })
  })
  await command('/theme')
  await expect(page.locator('html')).toHaveAttribute('data-sheet-focus-ready', 'true')
  await expect(dialog).toHaveCount(0)
  await expect(input).toBeFocused()
  await command('/theme light'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await command('/theme'); await dialog.getByRole('button', { name: '深色', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await page.keyboard.press('Escape')
  await command('/status'); await expect(dialog.getByText('Output remains readable until dismissed.', { exact: true })).toBeVisible(); await expect(dialog.getByText('No terminal-only picker is required.')).toBeVisible(); await page.keyboard.press('Escape')
  await command('/profile edit'); await dialog.getByLabel('常用语言（逗号分隔）').fill('中文, English'); await dialog.getByLabel('技术栈（逗号分隔）').fill('TypeScript, Kotlin'); await dialog.getByRole('button', { name: '保存偏好' }).click(); await expect(dialog).toHaveCount(0)
  assert.deepEqual(calls.find(call => call.method === 'profile.update').params.profile.languages, ['中文', 'English'])
  await command('/provider edit fixture'); await expect(dialog.getByLabel('渠道名称')).toHaveValue('fixture'); await expect(dialog.getByLabel('Base URL')).toHaveValue('https://fixture.invalid/v1'); await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue(''); await dialog.getByRole('button', { name: '保存渠道' }).click()
  assert.equal(Object.hasOwn(calls.find(call => call.method === 'settings.update').params.config.provider.fixture, 'api_key'), false)
  await page.keyboard.press('Escape')
  await command('/history'); await dialog.getByRole('button', { name: /UI contract fixture/ }).click(); await expect(dialog).toHaveCount(0)
  await command('/rewind'); await expect(input).toHaveValue('Restored draft'); await input.fill('')
  await command('/permission'); await dialog.getByRole('button', { name: /^Auto / }).click(); await expect(dialog).toHaveCount(0); assert.equal(calls.filter(call => call.method === 'sessions.configure').at(-1).params.mode, 'auto')
  await command('/paste context for the file'); await expect(input).toHaveValue('context for the file')
  await dialog.getByLabel('选择附件').setInputFiles({ name: 'source.ts', mimeType: 'video/mp2t', buffer: Buffer.from('export const uploaded = true') })
  await expect(dialog.getByText('source.ts', { exact: true })).toBeVisible()
  assert.equal(calls.find(call => call.method === 'attachments.upload').params.mediaType, 'text/plain')
  await dialog.getByLabel('选择附件').setInputFiles({ name: '.env', mimeType: 'text/plain', buffer: Buffer.from('never-upload-secrets') })
  await expect(dialog.getByRole('alert')).toHaveText('Credential files cannot be uploaded')
  await dialog.getByRole('button', { name: '移除附件 source.ts', exact: true }).click(); await expect(dialog.getByText('source.ts', { exact: true })).toHaveCount(0)
  await dialog.getByLabel('选择附件').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Attached context') }); await expect(dialog.getByText('notes.txt', { exact: true })).toBeVisible(); await page.keyboard.press('Escape')
  await expect(page.locator('.attachment-summary')).toContainText('notes.txt')
  await page.getByRole('button', { name: '发送', exact: true }).click(); await expect(page.getByText('Attachment received.', { exact: true })).toBeVisible()
  assert.equal(calls.find(call => call.method === 'turns.start').params.attachmentIds.length, 1)
  await expect(page.locator('.attachment-summary')).toHaveCount(0)
  await tools('Git 分支'); await dialog.getByRole('button', { name: 'feature', exact: true }).click()
  assert.equal(calls.some(call => call.method === 'branches.switch'), false)
  await dialog.getByRole('button', { name: '确认操作', exact: true }).click(); await expect(dialog.getByText(/当前：feature/)).toBeVisible()
  assert.deepEqual(calls.find(call => call.method === 'branches.switch').params, { sessionId: session.id, name: 'feature', confirmed: true, stateToken: 'state-token' })
  await expect(dialog.getByRole('button', { name: /occupied/ })).toBeDisabled()
  stale = true; await dialog.getByLabel('新分支名称').fill('feature/new'); await dialog.getByRole('button', { name: '创建并切换分支' }).click(); await dialog.getByRole('button', { name: '确认操作' }).click(); await expect(dialog.getByRole('alert')).toContainText('Branch state changed')
  await dialog.getByRole('button', { name: '刷新 Git 状态' }).click(); await dialog.getByRole('button', { name: '创建并切换分支' }).click(); await dialog.getByRole('button', { name: '确认操作' }).click(); await expect(dialog.getByText(/当前：feature\/new/)).toBeVisible()
  clean = false; await dialog.getByRole('button', { name: '刷新 Git 状态' }).click(); await expect(dialog.getByRole('button', { name: 'main', exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 320, height: 568 }); assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true)
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/web-branch-contract.png' }); await page.keyboard.press('Escape')
  approvals = [{ id: 'child-approval', sessionId: session.id, sourceSessionId: 'child-session', sourceLabel: 'Review worker', kind: 'question', request: { questions: [{ id: 'choice', text: 'Continue child work?', options: [{ label: 'Continue', value: 'continue' }] }] } }]
  await expect(page.getByText(/子代理 · Review worker/)).toBeVisible(); await page.getByRole('radio', { name: 'Continue', exact: true }).check(); await page.getByRole('button', { name: '提交回答' }).click(); await expect(page.locator('.approval')).toHaveCount(0)
  assert.deepEqual(calls.find(call => call.method === 'approvals.resolve').params, { id: 'child-approval', sessionId: session.id, answer: { choice: 'continue' } })
  const before = snapshots; gap = true; await expect.poll(() => snapshots).toBeGreaterThan(before); await expect(page.getByText('Contract test conversation.', { exact: true })).toHaveCount(1)
  const liveBefore = snapshots
  liveEvents = [{ id: 'live-prefix', seq, type: 'stream.text.delta', turnId: 'live-turn', payload: { text: 'Live prefix ', step: 1 } }]
  liveTruncated = true
  gap = true; await expect.poll(() => snapshots).toBeGreaterThan(liveBefore); await expect(page.getByText('Live prefix', { exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('受容量限制的部分预览')
  await page.reload(); await page.locator('.remote-session').filter({ hasText: 'UI contract fixture' }).click(); await expect(page.getByText('Live prefix', { exact: true })).toBeVisible()
  events.push({ id: 'live-tail', seq: ++seq, type: 'stream.text.delta', turnId: 'live-turn', payload: { text: 'plus future tail.', step: 1 } })
  await expect(page.getByText('Live prefix plus future tail.', { exact: true })).toHaveCount(1)
  history.push({ id: 'live-canonical', role: 'assistant', turnId: 'live-turn', step: 1, content: 'Live prefix plus future tail.', createdAt: Date.now() })
  liveEvents = []; liveTruncated = false; const completedBefore = snapshots
  events.push({ id: 'live-finish', seq: ++seq, type: 'turn.finish', turnId: 'live-turn', payload: { reply: 'Live prefix plus future tail.' } })
  await expect.poll(() => snapshots).toBeGreaterThan(completedBefore); await expect(page.getByText('Live prefix plus future tail.', { exact: true })).toHaveCount(1)
  await command('/profile'); await dialog.getByRole('button', { name: '设备绑定与转移', exact: true }).click(); await expect(dialog.locator('pre').filter({ hasText: 'remote unbind' })).toBeVisible(); await expect(dialog.getByText(/必须在被控电脑的终端完成/)).toBeVisible(); await page.keyboard.press('Escape')
  await command('/dash'); await expect(page.getByRole('textbox', { name: '搜索聊天' })).toBeVisible()
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await expect(dialog).toHaveCount(0)
  const loginPage = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await loginPage.addInitScript(() => { window.__loginTargets = []; window.open = url => { window.__loginTargets.push(String(url)); return null } })
  let browserExchange = false
  await loginPage.route('**/api/v1/discovery', route => route.fulfill({ json: { gateway: address } }))
  await loginPage.route('**/api/v1/profile', route => route.fulfill({ status: 401, json: { error: 'login_required' } }))
  await loginPage.route('**/auth/refresh', route => route.fulfill({ status: 401, json: { error: 'login_required' } }))
  await loginPage.route('**/auth/device', route => route.fulfill({ json: { device_code: 'fixture-grant', user_code: '12345678', interval: 5, expires_in: 600, verification_uri_complete: 'javascript:window.__unsafeLogin=true' } }))
  await loginPage.route('**/auth/token', route => { browserExchange = route.request().postDataJSON().browser === true; return route.fulfill({ json: { authenticated: true, profile: { name: 'Browser identity', organization: 'Fixture organization' } } }) })
  await loginPage.route('**/api/v1/devices', route => route.fulfill({ json: [] }))
  await loginPage.goto(address); await loginPage.getByRole('button', { name: '添加连接', exact: true }).click(); await loginPage.getByRole('button', { name: '继续组织登录', exact: true }).click()
  await expect(loginPage.getByText(/登录码：12345678/)).toBeVisible()
  await expect(loginPage.getByRole('link', { name: '若登录页未打开，点击此处继续' })).toHaveAttribute('href', '/login?code=12345678')
  assert.deepEqual(await loginPage.evaluate(() => window.__loginTargets), ['/login?code=12345678'])
  assert.equal(await loginPage.evaluate(() => Boolean(window.__unsafeLogin)), false)
  await expect(loginPage.getByRole('dialog')).toHaveCount(0, { timeout: 10000 }); assert.equal(browserExchange, true)
  await loginPage.close()
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  console.log('Web UI contract fixtures passed: attachment draft/upload/remove/send, branch confirmation/stale/dirty/worktree guards, command panels/theme/preferences/history/rewind, child approval routing, paginated history/replay-gap/live-stream prefix recovery, automatic browser SSO exchange, lifecycle guidance and 320px layout')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
