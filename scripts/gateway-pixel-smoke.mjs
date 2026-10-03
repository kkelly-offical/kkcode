import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { identityHash } from '../src/remote/identity.mjs'

// Isolated gateway and synthetic account. No IdP login, remote deployment, or model calls.
const store = new MemoryStore(), account = { id: 'pixel-owner', name: 'Pixel fixture', organization: 'Pixel Studio <fixture>' }
await store.put('account:pixel-owner', account)
await store.put('identity-session:pixel-browser', { id: 'pixel-browser', accountId: account.id, kind: 'client', expires: Date.now() + 60000 })
await store.put(`token:${identityHash('pixel-fixture-token')}`, { sessionId: 'pixel-browser', account, kind: 'client', expires: Date.now() + 60000 })
const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', clientId: 'pixel-fixture', dev: true, oidcConfig: {}, store, organization: 'Pixel Studio <fixture>' })
const headers = { host: 'localhost' }
const login = await app.inject({ url: '/login?code=12345678', headers })
const flow = (await app.inject({ method: 'POST', url: '/auth/device', headers, payload: { name: 'Browser fixture', kind: 'client' } })).json()
const key = `login-code:${identityHash(flow.device_code)}`
await store.put(key, { ...await store.get(key), account, confirmation: identityHash('pixel-confirm') })
const completed = await app.inject({ method: 'POST', url: '/auth/confirm', headers: { ...headers, authorization: 'Bearer pixel-fixture-token' }, payload: { code: flow.user_code, confirmation: 'pixel-confirm' } })
assert.equal(login.statusCode, 200); assert.equal(completed.statusCode, 200, completed.body)
assert.equal(login.headers['cache-control'], 'no-store')
assert.equal(completed.headers['referrer-policy'], 'no-referrer')
assert.doesNotMatch(completed.body, new RegExp(flow.device_code))
const browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
try {
  await mkdir('test-results', { recursive: true })
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const external = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => external.push(request.url()))
  for(const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme })
    for(const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 900 })
      await page.setContent(login.body)
      await expect(page.getByRole('heading', { name: '连接你的工作台', exact: true })).toBeVisible()
      await expect(page.getByLabel('设备登录码')).toHaveValue('12345678')
      await expect(page.getByText('Pixel Studio <fixture> · 组织登录', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: /Continue with organization SSO/ })).toBeInViewport()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: `test-results/gateway-login-${width}-${theme}.png` })
      await page.setContent(completed.body)
      await expect(page.getByRole('heading', { name: '连接已获批准', exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: /Open WebUI/ })).toHaveAttribute('href', '/')
      await page.screenshot({ path: `test-results/gateway-complete-${width}-${theme}.png` })
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, [], 'gateway artwork and fonts are self-contained')
  console.log('Gateway Pixel Studio: actual login/confirmation HTML, escaped labels, unchanged return action, dark/light 1440/390/320px and no external resources passed')
} finally { await browser.close(); await app.close() }
