import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadLab, labBrowser } from './lab-browser.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { createDeviceServer } from '../src/device/server.mjs'
import { parseWebOptions } from '../src/commands/web.mjs'
import { DeviceClient } from '../src/sdk/client.mjs'
import { expect } from '@playwright/test'
import { writePrivateFile } from '../src/storage/private-file.mjs'

const lab = await loadLab(), runs = path.join(path.dirname(lab.directory), 'kkcode-enterprise-runs')
await mkdir(runs, { recursive: true, mode: 0o700 })
const directory = await mkdtemp(path.join(runs, 'host-check-'))
const workspace = path.join(directory, 'workspace')
await mkdir(workspace, { mode: 0o700 })
process.env.KKCODE_HOME = path.join(directory, '.kkcode')
await writePrivateFile(path.join(workspace, 'README.txt'), 'KK Code HTTPS Host read acceptance\n')
const service = await new DeviceService({ cwd: workspace, roots: [workspace] }).initialize()
const server = await createDeviceServer({ service, host: lab.credentials.address, port: 0, https: { key: await readFile(path.join(lab.directory, 'tls.key')), cert: await readFile(path.join(lab.directory, 'tls.crt')) } })
const browser = await labBrowser()
try {
  assert.equal(parseWebOptions(['-web', '-host-18271', '--no-open']).host, '0.0.0.0')
  assert.equal(parseWebOptions(['-web', '-host-18271']).port, 18271)
  const { address, url, pairingCode } = await server.listen()
  const response = await fetch(`${address}/api/v1/auth/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairingCode, native: true }) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie'), /Secure/)
  const { token } = await response.json()
  const client = new DeviceClient({ url: address, token })
  assert.equal((await client.request('status')).device.id, service.metadata.id)
  assert.ok((await client.request('folders.list', { path: workspace })).entries.some(entry => entry.name === 'README.txt'))
  assert.equal((await client.request('files.read', { path: path.join(workspace, 'README.txt') })).content, 'KK Code HTTPS Host read acceptance\n')
  assert.ok((await client.request('sessions.create', { cwd: workspace })).id)
  assert.equal((await fetch(`${address}/api/v1/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' }, body: JSON.stringify({ id: 'foreign-origin', method: 'status' }) })).status, 403)
  await mkdir(path.join(workspace, '.ssh'))
  await assert.rejects(client.request('folders.list', { path: path.join(workspace, '.ssh') }), error => error.status === 403)
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(url)
  await expect(page.getByRole('button', { name: '更多', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  assert.equal(new URL(page.url()).hash, '')
  await client.http('/api/v1/auth/logout', { method: 'POST', body: {} })
  await assert.rejects(client.request('status'), error => error.status === 401)
  console.log('PASS: WireGuard HTTPS Host, one-time pairing, secure cookie, origin rejection, protected folders, compact WebUI and logout')
} finally { await browser.close(); await server.close() }
