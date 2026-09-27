import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/index.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'
import { awaitAbortable } from '../src/abort.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const temp = await mkdtemp(path.join(os.tmpdir(), 'kkcode-web-cancel-')), previous = process.env.KKCODE_HOME
const cwd = path.join(temp, 'workspace'), textGate = deferred(), releaseGate = deferred(), ackGate = deferred(), finishGate = deferred()
await mkdir(cwd)
process.env.KKCODE_HOME = path.join(temp, 'state')
await mkdir(process.env.KKCODE_HOME)
await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ provider: { default: 'openai', openai: { default_model: 'fixture', stream: true } }, skills: { auto_seed: false }, mcp: { auto_discover: false } }))
let calls = 0, releasing = false, heldAck = false, rejectFirstStop = true
const service = await new DeviceService({ cwd, roots: [cwd], createKernelImpl: async options => {
  const kernel = await createKernel({ ...options, trustState: { trusted: true } })
  const config = kernel.configState.config
  config.agent.verify_completion = false; config.session.title_generation = false
  config.tool.sources = { builtin: false, local: false, plugin: false, mcp: false }
  kernel.providers.registerProvider('openai', {
    async request() { throw new Error('Streaming fixture required') },
    async *requestStream({ signal }) {
      calls++
      if(calls > 1) { yield { type: 'text', content: '明确继续后的结果，未重放旧操作。' }; return }
      yield { type: 'thinking', content: '可实时展开的第一段思考' }
      await awaitAbortable(textGate.promise, signal)
      yield { type: 'text', content: '已经收到的部分正文' }
      await awaitAbortable(new Promise(() => {}), signal)
    },
  })
  return kernel
} }).initialize()
const resolveAttachments = service.attachments.resolve.bind(service.attachments)
service.attachments.resolve = async options => {
  const input = await resolveAttachments(options), release = input.release
  return { ...input, release: async () => { if(calls === 1) { releasing = true; await releaseGate.promise } else await finishGate.promise; await release() } }
}
const server = await createDeviceServer({ service, port: 0 }), info = await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/api/v1/rpc', async route => {
  const { method } = route.request().postDataJSON()
  if(method === 'turns.cancel' && rejectFirstStop) {
    rejectFirstStop = false
    return route.fulfill({ status: 409, json: { error: { code: 'control_busy', message: 'Fixture stop temporarily rejected' } } })
  }
  if(method === 'turns.start' && !heldAck) {
    heldAck = true
    const response = await route.fetch()
    await ackGate.promise
    return route.fulfill({ response })
  }
  return route.continue()
})
try {
  await page.goto(info.url)
  await page.getByRole('button', { name: '聊天', exact: true }).click()
  await page.getByRole('button', { name: '开始对话', exact: true }).click()
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('停止和恢复验收')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const dots = page.getByTestId('thinking-dots')
  await expect(dots).toHaveCount(1)
  await expect(dots.locator('span')).toHaveCount(9)
  await expect.poll(() => dots.locator('span').first().evaluate(node => getComputedStyle(node).animationName)).toBe('kk-thinking-dot')
  await page.locator('.thinking-row summary').click()
  await expect(page.getByText('可实时展开的第一段思考', { exact: true })).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => dots.locator('span').first().evaluate(node => getComputedStyle(node).animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/web-thinking-matrix.png' })
  textGate.resolve()
  await expect(page.getByText('已经收到的部分正文', { exact: true })).toBeVisible()
  await input.fill('不要被旧请求清掉的草稿')
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByText(/停止尚未确认，任务可能仍在运行/)).toBeVisible()
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled()
  assert.equal(service.turns.size, 1, 'a rejected stop cannot advertise completion')
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect.poll(() => releasing).toBe(true)
  await expect(page.getByRole('button', { name: '正在停止', exact: true })).toBeDisabled()
  await expect(dots).toHaveCount(0)
  assert.equal(service.turns.size, 1, 'attachments settle before the running slot is released')
  releaseGate.resolve()
  await expect(page.locator('.turn-cancelled')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  assert.equal(service.turns.size, 0)
  await expect(input).toHaveValue('不要被旧请求清掉的草稿')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(input).toHaveValue('不要被旧请求清掉的草稿')
  assert.equal(calls, 1, 'Continue never sends or replays a turn by itself')
  await input.fill('')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await expect(input).toHaveValue(/先核查已有结果/)
  await expect(input).toBeFocused()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('明确继续后的结果，未重放旧操作。', { exact: true })).toBeVisible()
  await expect(page.getByText('正在保存本轮结果…', { exact: true })).toBeVisible()
  await expect(dots).toHaveCount(0)
  await expect(page.locator('.thinking-row')).toHaveCount(1) // only the old, completed thinking row
  finishGate.resolve()
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await input.fill('新的草稿')
  ackGate.resolve()
  await expect(input).toHaveValue('新的草稿')
  assert.equal(calls, 2)
  await page.reload()
  await page.locator('.remote-session').filter({ hasText: '停止和恢复验收' }).click()
  await expect(page.locator('.turn-cancelled')).toHaveCount(1)
  await expect(page.getByText('已经收到的部分正文', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await expect(page.getByText(/provider error:/)).toHaveCount(0)
  await page.screenshot({ path: 'test-results/web-stop-recovery.png' })
  assert.deepEqual(errors, [])
  console.log('Web cancellation: real kernel/SSE, dot matrix/reduced motion, live expansion, stop retry/cleanup, delayed acknowledgement, preserved draft/history and explicit continuation passed')
} catch(error) {
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/web-cancel-failure.png' }).catch(() => {})
  throw error
} finally {
  textGate.resolve(); releaseGate.resolve(); ackGate.resolve(); finishGate.resolve()
  await browser.close(); await server.close(); await service.close()
  if(previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
  await rm(temp, { recursive: true, force: true })
}
