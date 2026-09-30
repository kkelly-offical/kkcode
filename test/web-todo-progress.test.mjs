import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

test('compact Web progress is accessible, scoped, safely expandable and fits mobile without animated progress', async t => {
  if (!await access(chromium.executablePath()).then(() => true, () => false)) { if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Browser required'); t.skip('Dedicated Chromium unavailable'); return }
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {TodoProgress} from './apps/web/src/TodoProgress.tsx';
    const root=createRoot(document.getElementById('root'));
    window.renderTodos=(snapshot,identity='device:s',subagents=[])=>root.render(React.createElement(TodoProgress,{snapshot,key:identity,subagents}));`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, reducedMotion: 'reduce' })
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: await readFile('apps/web/src/style.css', 'utf8') })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const snapshot = { sessionId: 's', revision: 1, items: ['completed', 'in_progress', 'in_progress', 'blocked'].map((status, i) => ({ id: String(i), status, content: i ? `Task ${i} ${'very-long-name-'.repeat(30)}` : '<img src=x onerror=alert(1)>', owner: { agentId: `worker-${i}` }, dependencies: i ? ['0'] : [] })) }
  await page.evaluate(value => window.renderTodos(value), snapshot)
  const toggle = page.getByText('待办 1/4 · 进行中 2 · 受阻 1', { exact: true })
  await expect(toggle).toBeVisible()
  await expect(page.getByText('任务状态由代理更新；已完成不等于已验证。')).toBeHidden()
  assert.ok((await page.locator('.todo-progress').boundingBox()).height <= 45)
  await page.locator('summary').focus(); await page.keyboard.press('Enter')
  await expect(page.getByText('任务状态由代理更新；已完成不等于已验证。')).toBeVisible()
  await expect(page.getByText('负责人：worker-1 · 依赖：0', { exact: true })).toBeVisible()
  await expect(page.locator('.todo-progress img')).toHaveCount(0)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360))
  await page.evaluate(value => window.renderTodos(value, 'other-device:s'), snapshot)
  await expect(page.getByText('任务状态由代理更新；已完成不等于已验证。')).toBeHidden()
  await page.evaluate(() => window.renderTodos({ sessionId: 's', revision: 2, items: [] }, 'other-device:s'))
  await expect(page.locator('.todo-progress')).toHaveCount(0)
  await page.setViewportSize({ width: 320, height: 640 })
  const children = ['running', 'completed', 'error', 'cancelled', 'unknown'].map((status, i) => ({ session_id: `child-${i}`, subagent: `worker-${i}`, status }))
  await page.evaluate(value => window.renderTodos(null, 'other-device:s', value), children)
  await expect(page.locator('summary')).toHaveText('子代理 1/5 · 进行中 1 · 需关注 2')
  await page.locator('summary').click()
  for (const text of ['worker-0 · 进行中', 'worker-1 · 已完成', 'worker-2 · 失败', 'worker-3 · 已取消', 'worker-4 · 待核查']) await expect(page.getByText(text, { exact: true })).toBeVisible()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 320))
  await page.evaluate(() => window.renderTodos(null, 'other-device:s', []))
  await expect(page.locator('.todo-progress')).toHaveCount(0)
})

test('Web real device snapshots and live events restore todos after reopening and isolate late session responses', async t => {
  if (!await access(chromium.executablePath()).then(() => true, () => false)) { if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Browser required'); t.skip('Dedicated Chromium unavailable'); return }
  const { DeviceService } = await import('../src/device/service.mjs')
  const { createDeviceServer } = await import('../src/device/server.mjs')
  const { createSessionTodoService } = await import('../src/kernel/session/todo-service.mjs')
  const { touchSession, updateSession } = await import('../src/kernel/session/store.mjs')
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kkcode-todo-ui-')))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(temporary, 'state')
  const workspace = path.join(temporary, 'workspace')
  await mkdir(workspace); await mkdir(process.env.KKCODE_HOME)
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ skills: { auto_seed: false }, mcp: { auto_discover: false } }))
  let service, server, browser, release
  try {
    service = await new DeviceService({ cwd: workspace, roots: [workspace] }).initialize()
    const principal = { id: 'local', client: 'todo-fixture' }
    const one = await service.dispatch('sessions.create', { cwd: workspace, title: 'Todo first' }, principal)
    const two = await service.dispatch('sessions.create', { cwd: workspace, title: 'Todo second' }, principal)
    const kernel = await service.kernel(workspace)
    const writer = await createSessionTodoService({ sessionId: one.id, emit: event => kernel.events.emit(event) })
    const tasks = [{ content: 'FIRST_SESSION_ONLY', status: 'completed' }, { content: 'ACTIVE_ONE', status: 'in_progress' }, { content: 'ACTIVE_TWO', status: 'in_progress' }, { content: 'BLOCKED_TASK', status: 'blocked' }]
    await writer.update({ todos: tasks })
    server = await createDeviceServer({ service, port: 0 }); const info = await server.listen()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    let page = await context.newPage()
    await page.goto(info.url)
    await page.getByRole('button', { name: 'Todo first', exact: true }).click()
    await expect(page.locator('.todo-progress summary')).toContainText('待办 1/4 · 进行中 2 · 受阻 1')
    await writer.update({ todos: tasks.map(item => ({ ...item, status: 'completed' })) })
    await expect(page.locator('.todo-progress summary')).toContainText('待办 4/4 · 进行中 0 · 受阻 0')
    for (const id of ['child_one', 'child_two']) {
      await touchSession({ sessionId: id, parentSessionId: one.id, cwd: workspace, mode: 'agent' })
      await updateSession(id, { childStatus: 'running', childContract: { schema: 1, parentSessionId: one.id, runSpec: { role: { name: 'fixture-worker' } } } })
      await kernel.events.emit({ type: 'subagent.delegated', sessionId: one.id, payload: { subSessionId: id, subagent: 'fixture-worker' } })
    }
    await expect(page.locator('.todo-progress summary')).toContainText('子代理 0/2 · 进行中 2 · 需关注 0')
    await updateSession('child_one', { childStatus: 'error' })
    await kernel.events.emit({ type: 'subagent.settled', sessionId: one.id, payload: { subSessionId: 'child_one', subagent: 'fixture-worker', status: 'error' } })
    await updateSession('child_two', { childStatus: 'blocked' })
    await kernel.events.emit({ type: 'task.settled', sessionId: one.id, payload: { subSessionId: 'child_two', status: 'completed' } })
    await expect(page.locator('.todo-progress summary')).toContainText('子代理 0/2 · 进行中 0 · 需关注 2')
    await page.close(); page = await context.newPage()
    await page.goto(info.address)
    await page.getByRole('button', { name: 'Todo first', exact: true }).click()
    await expect(page.locator('.todo-progress summary')).toContainText('待办 4/4')
    await expect(page.locator('.todo-progress summary')).toContainText('子代理 0/2 · 进行中 0 · 需关注 2')
    await page.getByRole('button', { name: 'Todo second', exact: true }).click()
    await expect(page.locator('.todo-progress')).toHaveCount(0)

    let arrive
    const arrived = new Promise(resolve => { arrive = resolve }), gate = new Promise(resolve => { release = resolve })
    await page.route('**/api/v1/rpc', async route => {
      const request = route.request().postDataJSON()
      if (request?.method !== 'sessions.get' || request.params?.sessionId !== one.id) return route.fallback()
      const response = await route.fetch(); arrive(); await gate; await route.fulfill({ response }).catch(() => {})
    })
    await page.getByRole('button', { name: 'Todo first', exact: true }).click(); await arrived
    await page.getByRole('button', { name: 'Todo second', exact: true }).click()
    release(); await page.unroute('**/api/v1/rpc')
    await expect(page.locator('.todo-progress')).toHaveCount(0)
    assert.equal((await service.dispatch('todos.list', { sessionId: two.id }, principal)).items.length, 0)
    await page.getByRole('button', { name: 'Todo first', exact: true }).click()
    await expect(page.locator('.todo-progress summary')).toContainText('待办 4/4')
    await writer.update({ todos: [] })
    // Removing authored input cannot erase the durable completed task history.
    await expect(page.locator('.todo-progress summary')).toContainText('待办 4/4')

    // Exercise the real App's five mode-selected sessions, not only a standalone
    // progress helper. Progress is capability-neutral and must remain visible.
    for (const [mode, label] of [['agent', 'Agent'], ['auto', 'Auto'], ['yolo', 'Yolo'], ['plan', 'Plan'], ['ultra', 'Ultra']]) {
      const title = `Mode ${label}`
      const session = await service.dispatch('sessions.create', { cwd: workspace, title, mode }, principal)
      const modeWriter = await createSessionTodoService({ sessionId: session.id, emit: event => kernel.events.emit(event) })
      await modeWriter.update({ todos: [{ content: `${label} 工作项`, status: 'in_progress' }] })
      const childId = `mode_child_${mode}`
      await touchSession({ sessionId: childId, parentSessionId: session.id, cwd: workspace, mode })
      await updateSession(childId, { childStatus: 'running', childContract: { schema: 1, parentSessionId: session.id, runSpec: { role: { name: `${label} worker` } } } })
      await page.reload()
      await page.getByRole('button', { name: title, exact: true }).click()
      await expect(page.getByRole('button', { name: `执行模式，当前 ${label}`, exact: true })).toBeVisible()
      await expect(page.locator('.todo-progress summary')).toContainText('待办 0/1 · 进行中 1 · 受阻 0 · 子代理 0/1 · 进行中 1 · 需关注 0')
      await page.locator('.todo-progress summary').click()
      await expect(page.getByText(`${label} 工作项`, { exact: true })).toBeVisible()
      await expect(page.getByText(`${label} worker · 进行中`, { exact: true })).toBeVisible()
      await updateSession(childId, { childStatus: 'completed' })
      await kernel.events.emit({ type: 'subagent.settled', sessionId: session.id, payload: { subSessionId: childId, subagent: `${label} worker`, status: 'completed' } })
      await expect(page.locator('.todo-progress summary')).toContainText('子代理 1/1 · 进行中 0 · 需关注 0')
      await expect(page.getByText(`${label} worker · 已完成`, { exact: true })).toBeVisible()
    }
  } finally {
    release?.(); await browser?.close(); await server?.close(); await service?.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})
