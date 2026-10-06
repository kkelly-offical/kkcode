import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import { DeviceService } from '../src/device/service.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { registerAccountModels } from '../src/remote/account-models.mjs'

// Actual component + account store + device settings; synthetic identity only.
// No identity-provider login, external requests, or model inference.
const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-account-ui-')), previous = process.env.KKCODE_HOME
process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(process.env.KKCODE_HOME)
await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({ skills: { auto_seed: false }, mcp: { auto_discover: false } }))
const service = await new DeviceService({ cwd: root, roots: [root] }).initialize(), app = Fastify(), store = new MemoryStore()
const rpc = (method, params = {}) => service.request({ id: randomUUID(), method, params }, { id: 'local', client: 'template-fixture' })
registerAccountModels({ app, store, origin: 'https://fixture.invalid', encryptionKey: Buffer.alloc(32, 17).toString('base64'), authenticate: async () => ({ account: { id: 'fixture-owner' } }) })
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {AccountModels} from './apps/web/src/AccountModels.tsx';
  const rpc=(method,params)=>window.fixtureSettings({method,params});
  createRoot(document.getElementById('root')).render(<AccountModels rpc={rpc} onSettings={()=>{}}/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' })
app.get('/', (_req, reply) => reply.type('text/html').send('<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script></html>'))
app.get('/fixture.js', (_req, reply) => reply.type('application/javascript').send(bundle.outputFiles[0].text))
const origin = await app.listen({ host: '127.0.0.1', port: 0 })
let browser
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
  const page = await browser.newPage(), errors = []
  // Bind only the settings operations needed by this component to this page;
  // do not expose the device's general RPC interface as an HTTP fixture route.
  await page.exposeFunction('fixtureSettings', ({ method, params }) => {
    if (method === 'settings.get') return rpc('settings.get')
    if (method === 'settings.update' && Object.keys(params?.config || {}).join() === 'provider') return rpc('settings.update', { config: { provider: params.config.provider } })
    throw new Error('Unexpected template fixture operation')
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  await page.getByRole('button', { name: '＋ 添加账号模板', exact: true }).click()
  await page.getByLabel('模板名称', { exact: true }).fill('team')
  await page.getByLabel('Base URL', { exact: true }).fill('https://models.invalid/v1')
  await page.getByLabel('API Key', { exact: true }).fill('fixture-private-template-key')
  await page.getByLabel('默认模型', { exact: true }).fill('original-model')
  await page.getByRole('button', { name: '保存到账号', exact: true }).click()
  await expect(page.locator('.connection-row')).toContainText('original-model')
  await page.getByRole('button', { name: '复制到设备', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('team 已复制到当前设备')
  assert.equal((await rpc('settings.get')).provider.team.default_model, 'original-model')
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
  await page.getByLabel('默认模型', { exact: true }).fill('template-new-model')
  await page.getByRole('button', { name: '保存到账号', exact: true }).click()
  await expect(page.locator('.connection-row')).toContainText('template-new-model')
  assert.equal((await rpc('settings.get')).provider.team.default_model, 'original-model', 'template edits cannot change device copies')
  await rpc('settings.update', { config: { provider: { team: { default_model: 'device-only-model' } } } })
  const template = (await app.inject({ method: 'POST', url: '/api/v1/account/models/resolve', payload: {} })).json().provider.team
  assert.equal(template.default_model, 'template-new-model', 'device edits cannot change account templates')
  assert.equal(template.api_key, 'fixture-private-template-key', 'blank edit retains encrypted credential')
  await page.getByRole('button', { name: '复制到设备', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('team-copy-1 已复制到当前设备')
  const device = (await rpc('settings.get')).provider
  assert.equal(device.team.default_model, 'device-only-model'); assert.equal(device['team-copy-1'].default_model, 'template-new-model')
  assert.ok(!JSON.stringify(await store.list('account-models:')).includes('fixture-private-template-key'))
  assert.deepEqual(errors, [])
  console.log('Account template UI: encrypted save, explicit independent copy, edits in both directions, retained key and collision-safe copy passed; no model inference.')
} finally {
  await browser?.close(); await app.close(); await service.close()
  if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
  await rm(root, { recursive: true, force: true })
}
