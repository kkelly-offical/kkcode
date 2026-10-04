import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/index.mjs'
import { appendUserMessage, appendAssistantMessage, updateSession } from '../src/kernel/session/store.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'
import { awaitAbortable } from '../src/abort.mjs'

const temporary = await mkdtemp(path.join(os.tmpdir(), 'kkcode-conversation-ui-')), previous = process.env.KKCODE_HOME
process.env.KKCODE_HOME = path.join(temporary, 'state')
let catalogCalls = 0, summaryCalls = 0, unexpectedCalls = 0
const catalog = createServer((request, response) => {
  if(request.url !== '/v1/models') { unexpectedCalls++; response.writeHead(500).end(); return }
  catalogCalls++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({data: [{id: 'fixture-model', context_length: 262144, max_output_tokens: 65536, reasoning_effort_levels: ['low','medium','high','xhigh','max']}, {id: `fresh-model-${catalogCalls}`}]}))
})
await new Promise(resolve => catalog.listen(0, '127.0.0.1', resolve))
await mkdir(process.env.KKCODE_HOME)
await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ skills: {auto_seed: false}, mcp: {auto_discover: false}, session: {title_generation: false}, provider: {default: 'openai', openai: {type: 'openai', base_url: `http://127.0.0.1:${catalog.address().port}/v1`, api_key_env: '', default_model: 'fixture-model'}} }))
const service = await new DeviceService({cwd: temporary, roots: [temporary], createKernelImpl: async options => {
  const kernel = await createKernel({...options, trustState: {trusted: true}})
  kernel.providers.registerProvider('openai', {
    async request({signal}) { summaryCalls++; if(summaryCalls === 1) await awaitAbortable(new Promise(() => {}), signal); return {text: 'Preserved the user questions and the main context.', usage: {input: 10, output: 5}} },
    async *requestStream() { assert.fail('manual compact must never submit a conversation prompt') }
  })
  return kernel
} }).initialize()
const {id: sessionId} = await service.request({id: 'conversation-fixture', method: 'sessions.create', params: {cwd: temporary, title: '会话体验验收'}})
for(let i = 0; i < 9; i++) {
  await appendUserMessage(sessionId, `Question ${i}`, {turnId: `old-${i}`})
  await appendAssistantMessage(sessionId, Array.from({length: 100}, (_, line) => `Paragraph ${i}-${line}: historical conversation context for scrolling.`).join('\n\n'), {turnId: `old-${i}`})
}
await updateSession(sessionId, {context: {tokens: 100000, limit: 200000, source: 'provider-usage', provider: 'openai', model: 'fixture-model', components: {system: 200, tools: 400}}})
const server = await createDeviceServer({service, port: 0}), info = await server.listen()
const browser = await chromium.launch({headless: true, ...(process.env.KKCODE_CHROMIUM ? {executablePath: process.env.KKCODE_CHROMIUM} : {})})
const page = await browser.newPage({viewport: {width: 1100, height: 850}}), errors = []
page.on('pageerror', error => errors.push(error.message))
const bottomDistance = () => page.locator('.transcript').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
try {
  await page.goto(info.url)
  await page.getByRole('button', {name: /会话体验验收/}).first().click()
  const input = page.getByRole('textbox', {name: '消息'})
  await expect(input).toBeVisible()
  await expect.poll(bottomDistance).toBeLessThan(5)
  const view = await page.locator('.transcript').boundingBox()
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  await page.mouse.wheel(0, -1000)
  await expect(page.getByRole('button', {name: '↓ 回到最新'})).toBeVisible()
  const position = await page.locator('.transcript').evaluate(element => element.scrollTop)
  await service.record({type: 'stream.text.delta', sessionId, turnId: 'stream-fixture', payload: {text: 'A newly streamed line.\n\n'.repeat(80)}})
  await expect(page.locator('.message.assistant').last()).toContainText('A newly streamed line.')
  assert.ok(Math.abs(await page.locator('.transcript').evaluate(element => element.scrollTop) - position) < 20, 'reading older text must not jump on a new chunk')
  await page.getByRole('button', {name: '↓ 回到最新'}).click()
  await expect.poll(bottomDistance).toBeLessThan(5)
  await service.record({type: 'stream.text.delta', sessionId, turnId: 'stream-fixture', payload: {text: 'Followed to the end.\n\n'.repeat(80)}})
  await expect(page.locator('.message.assistant').last()).toContainText('Followed to the end.')
  await expect.poll(bottomDistance).toBeLessThan(5)
  await service.record({type: 'turn.result', sessionId, turnId: 'stream-fixture', payload: {settled: true}})

  const picker = page.getByRole('button', {name: /选择模型，当前/})
  await picker.click()
  await expect(page.getByRole('menuitemradio', {name: /fresh-model-1/})).toBeVisible()
  await page.keyboard.press('Escape')
  await picker.click()
  await expect.poll(() => catalogCalls).toBe(2)
  await expect(page.getByRole('menuitemradio', {name: /fresh-model-2/})).toBeVisible()
  await page.keyboard.press('Escape')

  await picker.click()
  const thinking = page.getByRole('combobox', {name:'思考强度'})
  await expect(thinking.locator('option')).toHaveText(['自动 · 使用服务端默认设置','略思 · 较轻思考','审思 · 仔细推敲','深思 · 深入推演','精思 · 更缜密推演','穷理 · 更充分推究'])
  await thinking.selectOption('xhigh')
  await expect.poll(async () => (await service.request({id:'thinking-saved',method:'settings.get'})).provider.openai.model_options?.['fixture-model']?.thinking_effort).toBe('xhigh')
  await picker.click()
  await expect(thinking).toHaveValue('xhigh')
  await expect(page.getByText(/输出预留 65,536/)).toBeVisible()
  const controlBox = await page.locator('.model-thinking').boundingBox(), selectBox = await thinking.boundingBox()
  assert.ok(selectBox.x >= controlBox.x && selectBox.x + selectBox.width <= controlBox.x + controlBox.width + 1, 'thinking selection must remain inside its card')
  await page.screenshot({path:'test-results/web-110-thinking.png'})
  await page.setViewportSize({width:320,height:800})
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'thinking controls must fit a narrow phone viewport')
  await expect(thinking).toBeVisible()
  await page.setViewportSize({width:1100,height:850})
  await page.keyboard.press('Escape')

  await input.fill('/compact')
  await page.getByRole('button', {name: '发送', exact: true}).click()
  await expect(page.getByText('正在压缩上下文…', {exact: true})).toBeVisible()
  await expect(input).toHaveValue('')
  await page.getByRole('button', {name: '停止', exact: true}).click()
  await expect(page.getByRole('button', {name: '发送', exact: true})).toBeVisible()
  await expect(input).toHaveValue('/compact')
  assert.equal((await service.request({id: 'cancelled-snapshot', method: 'sessions.get', params: {sessionId}})).context.tokens, 100000)
  await page.getByRole('button', {name: '发送', exact: true}).click()
  await expect(page.locator('.context-divider').last()).toContainText(/100k →/)
  await expect(input).toHaveValue('')
  const snapshot = await service.request({id: 'compacted-snapshot', method: 'sessions.get', params: {sessionId}})
  assert.ok(snapshot.context.tokens < 100000)
  await expect(page.locator('.context-meter')).toContainText('估算')
  await expect(page.getByText('Question 0', {exact: true})).toBeHidden()
  await page.locator('.compacted-history > summary').click()
  await expect(page.getByText('Question 0', {exact: true})).toBeVisible()
  await mkdir('test-results', {recursive: true})
  await page.locator('.compacted-history > summary').click()
  await page.screenshot({path: 'test-results/web-109-compacted.png'})
  await page.reload()
  await page.getByRole('button', {name: /会话体验验收/}).first().click()
  await expect(page.locator('.context-divider').last()).toContainText(/100k →/)
  await expect.poll(bottomDistance).toBeLessThan(5)
  assert.equal(summaryCalls, 2)
  assert.equal(unexpectedCalls, 0)
  assert.deepEqual(errors, [])
  console.log('Web conversation: latest entry, free scroll/follow, model auto refresh and five-level thinking persistence, compact cancel/draft/meter/folding/reopen passed.')
} finally {
  await browser.close(); await server.close(); await service.close(); await new Promise(resolve => catalog.close(resolve))
  if(previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
  await rm(temporary, {recursive: true, force: true})
}
