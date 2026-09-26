import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-web-config-'))
const previous = process.env.KKCODE_HOME, cwd = path.join(root, 'workspace')
process.env.KKCODE_HOME = path.join(root, 'state')
await mkdir(cwd); await mkdir(process.env.KKCODE_HOME)
const file = path.join(process.env.KKCODE_HOME, 'config.json')
const original = { provider: { default: 'config-fixture', 'config-fixture': { type: 'openai', default_model: 'fixture-model', base_url: 'https://models.example.invalid/v1' } },
  permission: { default_policy: 'allow' }, skills: { auto_seed: false }, mcp: { auto_discover: false } }
await writeFile(file, JSON.stringify(original))
const service = await new DeviceService({ cwd, roots: [cwd] }).initialize()
const server = await createDeviceServer({ service, port: 0 }), info = await server.listen()
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(info.url)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '模型与渠道', exact: true }).click()
  await expect(page.getByTestId('configuration-diagnostics')).toContainText('permission.default_policy')
  await expect(page.getByTestId('configuration-diagnostics')).toContainText('工具执行已暂停')
  await expect(page.getByRole('button', { name: 'config-fixture', exact: false }).first()).toBeVisible()
  const failure = await page.evaluate(async () => {
    const response = await fetch('/api/v1/rpc', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'bad-save', method: 'settings.update', params: { config: { provider: { 'config-fixture': { default_model: 'new-model' } } } } }) })
    return { status: response.status, body: await response.json() }
  })
  assert.equal(failure.status, 400)
  assert.match(JSON.stringify(failure.body), /配置未保存/)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original)
  await writeFile(file, JSON.stringify({ ...original, permission: { level: 'manual' } }))
  await page.reload()
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '模型与渠道', exact: true }).click()
  await expect(page.getByTestId('configuration-diagnostics')).toHaveCount(0)
  assert.deepEqual(errors, [])
  console.log('Web configuration recovery: real device RPC, visible Chinese diagnostics, retained providers, rejected ineffective save and repaired reload passed; no model inference')
} finally {
  await browser?.close(); await server.close()
  if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
  await rm(root, { recursive: true, force: true })
}
