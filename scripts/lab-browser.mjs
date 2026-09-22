import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'

export async function loadLab() {
  const directory = process.env.KKCODE_LAB_STATE || path.join(os.homedir(), '.local/share/kkcode-enterprise-lab')
  return { directory, ...JSON.parse(await readFile(path.join(directory, 'public.json'), 'utf8')), credentials: JSON.parse(await readFile(path.join(directory, 'credentials.json'), 'utf8')) }
}
export async function labBrowser() {
  const lab = await loadLab()
  const bypass = [...new Set([new URL(lab.gateway).hostname, new URL(lab.sso).hostname, '127.0.0.1', 'localhost'])].join(',')
  // Playwright's explicit proxy option takes precedence over desktop proxy
  // discovery; --no-proxy-server alone did not on the acceptance host. Only
  // these owned lab hosts are direct. Other traffic fails closed, and neither
  // the system proxy nor production TLS configuration is changed.
  return chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:9', bypass }, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
}
export async function labPost(lab, route, body, token) {
  return fetch(lab.gateway + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) })
}
export async function approveLabLogin(browser, lab, { url, account = 'owner', context } = {}) {
  context ||= await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await page.goto(url)
  if (await page.getByRole('button', { name: 'Continue with organization SSO' }).count()) await page.getByRole('button', { name: 'Continue with organization SSO' }).click()
  const user = lab.credentials.accounts[account]
  try {
    await page.locator('#username').waitFor({ timeout: 20000 })
    await page.locator('#username').fill(user.username)
    await page.locator('#password').fill(user.password)
    await page.locator('#kc-login').click()
  } catch {
    if (!await page.getByRole('button', { name: 'Allow this device' }).count()) throw new Error('The lab identity provider did not complete the login form')
  }
  await page.getByRole('button', { name: 'Allow this device' }).click({ timeout: 20000 })
  await page.getByRole('heading', { name: 'Device approved' }).waitFor()
  return { context, page }
}
export async function loginLabAccount(browser, lab, { account = 'owner', kind = 'client', name = 'KK Code integration client' } = {}) {
  const response = await labPost(lab, '/auth/device', { kind, name })
  if (!response.ok) throw new Error(`Login initialization failed: HTTP ${response.status}`)
  const flow = await response.json()
  const result = await approveLabLogin(browser, lab, { url: flow.verification_uri_complete, account })
  const tokens = await labPost(lab, '/auth/token', { device_code: flow.device_code })
  if (!tokens.ok) throw new Error(`Login exchange failed: HTTP ${tokens.status}`)
  return { ...result, credentials: await tokens.json() }
}
