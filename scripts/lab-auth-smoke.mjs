import assert from 'node:assert/strict'
import { labBrowser, loadLab, loginLabAccount, labPost } from './lab-browser.mjs'
import { DeviceClient } from '../src/sdk/client.mjs'

const lab = await loadLab(), browser = await labBrowser()
try {
  const a = await loginLabAccount(browser, lab), b = await loginLabAccount(browser, lab)
  const sdk = new DeviceClient({ url: lab.gateway, token: a.credentials.access_token, refreshToken: a.credentials.refresh_token })
  assert.equal((await sdk.profile()).organization, 'KK Code Enterprise Lab')
  const rotations = await Promise.all([labPost(lab, '/auth/refresh', { refresh_token: a.credentials.refresh_token }), labPost(lab, '/auth/refresh', { refresh_token: a.credentials.refresh_token })])
  assert.deepEqual(rotations.map(response => response.status).sort(), [200, 401])
  const rotated = await rotations.find(response => response.ok).json()
  sdk.token = rotated.access_token
  assert.equal((await labPost(lab, '/auth/logout', {}, b.credentials.access_token)).status, 200)
  assert.equal((await sdk.profile()).email, 'owner@kkcode.test')
  const administrator = await loginLabAccount(browser, lab, { account: 'administrator' })
  assert.equal(administrator.credentials.profile.admin, true)
  console.log('Real Keycloak + PostgreSQL over WireGuard HTTPS: PKCE login, roles, atomic refresh and isolated logout passed')
} finally { await browser.close() }
