import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import { DeviceService } from '../src/device/service.mjs'

let bundle
async function panelBundle() {
  bundle ||= build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { SubagentPanel } from './apps/web/src/Subagents.tsx';
    window.panelCalls = [];
    const rpc = async (method, params) => {
      if (method === 'subagents.interrupt') { window.panelCalls.push({ method, params, result: { items: [] } }); return { items: [] }; }
      const result = await window.deviceRpc(method, params);
      window.panelCalls.push({ method, params, result });
      return result;
    };
    const item = { session_id: 'child-one', description: '回归子代理', subagent: 'worker', status: 'running', started_at: Date.now(), runtime: {} };
    createRoot(document.getElementById('root')).render(React.createElement(SubagentPanel, { items: [item], sessionId: 'parent-session', canManage: true, rpc, onTasks: () => {} }));`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  return (await bundle).outputFiles[0].text
}

test('stopping a subagent releases its original lease so a second client can immediately acquire control', async t => {
  if (!await access(chromium.executablePath()).then(() => true, () => false)) { if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Browser required'); t.skip('Dedicated Chromium unavailable'); return }
  const home = await mkdtemp(path.join(os.tmpdir(), 'kkcode-web-subagent-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  const service = await new DeviceService({ cwd: home, roots: [home] }).initialize()
  const first = { id: 'local', client: 'first-client' }, second = { id: 'local', client: 'second-client' }
  const browser = await chromium.launch({ headless: true, ...(process.env.KKCODE_CHROMIUM ? { executablePath: process.env.KKCODE_CHROMIUM } : {}) })
  try {
    const page = await browser.newPage()
    await page.exposeFunction('deviceRpc', (method, params) => service.request({ id: randomUUID(), method, params }, first))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: await panelBundle() })
    await page.getByRole('button', { name: '停止此子代理', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.panelCalls.length)).toBe(3)
    assert.equal(service.leases.has('parent-session'), false)
    const acquired = await service.request({ id: randomUUID(), method: 'control.acquire', params: { sessionId: 'parent-session' } }, second)
    assert.equal(typeof acquired.leaseId, 'string')
    const calls = await page.evaluate(() => window.panelCalls)
    assert.deepEqual(calls.map(call => call.method), ['control.acquire', 'subagents.interrupt', 'control.release'])
    assert.equal(calls[2].params.leaseId, calls[0].result.leaseId)
    assert.equal(calls[2].params.sessionId, 'parent-session')
  } finally {
    await browser.close(); await service.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
