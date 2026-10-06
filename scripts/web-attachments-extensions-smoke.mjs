import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { chromium, expect } from '@playwright/test'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'
import { createKernel } from '../src/kernel/index.mjs'
import { zipSync, strToU8 } from 'fflate'

const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-113-ui-')), previous = process.env.KKCODE_HOME
process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(process.env.KKCODE_HOME)
await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ provider: { default: 'openai', openai: { default_model: 'fixture', stream: false }, model_capabilities: { fixture: { image: true } } }, skills: { auto_seed: false }, mcp: { auto_discover: false } }))
const calls = []
const service = await new DeviceService({ cwd: root, roots: [root], createKernelImpl: async options => {
  const kernel = await createKernel({ ...options, trustState: { trusted: true } })
  kernel.providers.registerProvider('openai', { async request(...args) { calls.push(args); return { text: '已收到附件。', toolCalls: [], usage: { input: 1, output: 1 } } }, async *requestStream() { yield { type: 'text', content: '已收到附件。' } } })
  return kernel
} }).initialize()
const server = await createDeviceServer({ service, port: 0 })
server.app.addHook('onError', (req, _reply, error, done) => { console.error('Fixture RPC error', req.body?.method, error.code, error.message); done() })
const info = await server.listen()
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } }), errors = []
page.on('pageerror', error => errors.push(error.message))
await mkdir('test-results/experience-113', { recursive: true })
try {
  if(process.env.KKCODE_DESKTOP_UI === '1') await page.addInitScript(() => { window.kkcodeDesktopLogin = { prepare: async () => true, finish: async () => true } })
  await page.goto(info.url)
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await expect(input).toBeVisible()
  await input.fill('正文仍然保留')
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lGkAAAAASUVORK5CYII='
  await input.evaluate((element, base64) => {
    const transfer = new DataTransfer(), bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    transfer.items.add(new File([bytes], '截图.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, png)
  await expect(page.locator('.composer-attachment img')).toBeVisible()
  await expect(input).toHaveValue('正文仍然保留')
  const doc = Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="word"><w:p><w:r><w:t>真实文档附件内容</w:t></w:r></w:p></w:document>') }))
  await page.locator('input[aria-label="添加图片或文件"]').setInputFiles({ name: '需求.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: doc })
  await expect(page.locator('.composer-attachment')).toHaveCount(2)
  await page.screenshot({ path: 'test-results/experience-113/attachments-desktop.png' })
  await page.getByRole('button', { name: '移除附件 截图.png', exact: true }).click()
  await input.fill('')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.message.assistant')).toContainText('已收到附件')
  assert.ok(JSON.stringify(calls).includes('真实文档附件内容'), 'document content reaches the actual provider interface')
  await expect(page.locator('.composer-attachment')).toHaveCount(0)
  await input.fill('配置期间保留的草稿')
  await page.getByRole('button', { name: process.env.KKCODE_DESKTOP_UI === '1' ? '桌面连接与扩展' : '扩展', exact: true }).first().click()
  await expect(page.getByRole('tab', { name: 'MCP', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '＋ 添加', exact: true }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('design')
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill('https://design.invalid/mcp')
  await page.getByRole('button', { name: '＋ 添加请求头', exact: true }).click()
  await page.getByRole('textbox', { name: '请求头名称 1', exact: true }).fill('Authorization')
  await page.getByLabel('请求头值 1', { exact: true }).fill('fixture-private-value')
  await page.screenshot({ path: 'test-results/experience-113/connection-form-desktop.png' })
  await page.getByRole('button', { name: '保存到当前设备', exact: true }).click()
  await expect(page.locator('.connection-row').filter({ hasText: 'design' })).toBeVisible()
  assert.ok(!(await readFile(path.join(process.env.KKCODE_HOME, 'config.json'), 'utf8')).includes('fixture-private-value'))
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.screenshot({ path: 'test-results/experience-113/connections-mobile.png' })
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('配置期间保留的草稿')
  assert.deepEqual(errors, [])
  console.log('Real UI passed: clipboard image, thumbnail, DOCX upload/extraction, attachment-only send, encrypted connection form, retained draft and mobile layout; no model inference.')
} finally {
  await browser.close(); await server.close(); if(previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
  await rm(root, { recursive: true, force: true })
}
