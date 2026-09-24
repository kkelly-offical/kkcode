import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

let bundle
async function fixture(t) {
  if (!await access(chromium.executablePath()).then(() => true, () => false)) { if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Browser required'); t.skip('Dedicated Chromium unavailable'); return null }
  bundle ||= build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryPanel} from './apps/web/src/Memory.tsx';
    const root=createRoot(document.getElementById('root'));
    window.requests=[];
    const rpc=(method,params,options)=>new Promise((resolve,reject)=>window.requests.push({method,params,signal:options.signal,resolve,reject}));
    window.renderMemory=(sessionId)=>root.render(React.createElement(MemoryPanel,{rpc,sessionId}));`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: (await bundle).outputFiles[0].text })
  return page
}
const entry = text => ({ id: text, text, status: 'candidate', version: 1 })

test('memory scope is busy on first visible commit, before deferred effects can load the scope', async t => {
  const page = await fixture(t); if (!page) return
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const input = document.querySelector('textarea'); if (!input) return
      window.firstMemoryCommit = { disabled: input.disabled }; observer.disconnect()
    }); observer.observe(document.body, { subtree: true, childList: true })
    window.renderMemory('first')
  })
  await expect.poll(() => page.evaluate(() => window.firstMemoryCommit)).toEqual({ disabled: true })
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(1)
  await page.evaluate(() => window.requests[0].resolve({ entries: [] }))
  await expect(page.getByLabel('新增待确认的记忆')).toBeEnabled()
})

test('a click queued at the first visible commit cannot switch scope before its initial load owns the controls', async t => {
  const page = await fixture(t); if (!page) return
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const personal = [...document.querySelectorAll('button')].find(button => button.textContent === '个人偏好')
      if (!personal) return
      observer.disconnect(); personal.click()
    }); observer.observe(document.body, { subtree: true, childList: true })
    window.renderMemory('first')
  })
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(1)
  await expect(page.getByRole('button', { name: '个人偏好', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await page.evaluate(() => window.requests[0].resolve({ entries: [] }))
  await page.getByRole('button', { name: '个人偏好', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.requests.map(request => request.params.scope))).toEqual(['project', 'personal'])
  await page.evaluate(() => window.requests[1].resolve({ entries: [] }))
  await expect(page.getByLabel('新增待确认的记忆')).toBeEnabled()
})

test('replacing a pending memory scope starts its own load and ignores late prior-scope success', async t => {
  const page = await fixture(t); if (!page) return
  await page.evaluate(() => window.renderMemory('old-session'))
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(1)
  await page.evaluate(() => window.renderMemory('new-session'))
  await expect.poll(() => page.evaluate(() => window.requests.map(request => request.params.sessionId))).toEqual(['old-session', 'new-session'])
  assert.equal(await page.evaluate(() => window.requests[0].signal.aborted), true)
  await page.evaluate(value => window.requests[1].resolve({ entries: [value] }), entry('CURRENT_SCOPE'))
  await expect(page.getByText('CURRENT_SCOPE', { exact: true })).toBeVisible()
  await page.evaluate(value => window.requests[0].resolve({ entries: [value] }), entry('STALE_SCOPE'))
  await expect(page.getByText('STALE_SCOPE', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('新增待确认的记忆')).toBeEnabled()
})

test('a late prior-scope failure cannot clear the new load lock or show an error in the new scope', async t => {
  const page = await fixture(t); if (!page) return
  await page.evaluate(() => window.renderMemory('old-session'))
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(1)
  await page.evaluate(() => window.renderMemory('new-session'))
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(2)
  await page.evaluate(() => window.requests[0].reject(new Error('STALE_SCOPE_FAILURE')))
  await expect(page.getByLabel('新增待确认的记忆')).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(value => window.requests[1].resolve({ entries: [value] }), entry('CURRENT_SCOPE'))
  await expect(page.getByText('CURRENT_SCOPE', { exact: true })).toBeVisible()
  await expect(page.getByLabel('新增待确认的记忆')).toBeEnabled()
})

test('late saved memory cannot refresh a replacement scope; its own save and refresh stay serial', async t => {
  const page = await fixture(t); if (!page) return
  await page.evaluate(() => window.renderMemory('old-session'))
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(1)
  await page.evaluate(() => window.requests[0].resolve({ entries: [] }))
  await page.getByRole('button', { name: '个人偏好', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(2)
  await page.evaluate(() => window.requests[1].resolve({ entries: [] }))
  await page.getByLabel('新增待确认的记忆').fill('Preserve the current scope')
  await page.getByRole('button', { name: '提出记忆', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(3)
  await expect(page.getByRole('button', { name: '项目记忆', exact: true })).toBeDisabled()
  await page.evaluate(() => window.renderMemory('new-session'))
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(4)
  await page.evaluate(() => window.requests[3].resolve({ entries: [] }))
  await expect(page.getByLabel('新增待确认的记忆')).toBeEnabled()
  await page.evaluate(() => window.requests[2].resolve({ id: 'old-save', version: 1 }))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.evaluate(() => window.requests.length), 4, 'late old save must not request an old-scope refresh with a new signal')
  await page.getByLabel('新增待确认的记忆').fill('CURRENT_SAVE')
  await page.getByRole('button', { name: '提出记忆', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(5)
  await page.evaluate(() => window.requests[4].resolve({ id: 'current', version: 1 }))
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(6)
  await expect(page.getByLabel('新增待确认的记忆')).toBeDisabled()
  await page.evaluate(value => window.requests[5].resolve({ entries: [value] }), entry('CURRENT_SAVE'))
  await expect(page.getByText('CURRENT_SAVE', { exact: true })).toBeVisible()
  await expect(page.getByText(/待确认 · v1/)).toBeVisible()
  await expect(page.getByLabel('新增待确认的记忆')).toBeEnabled()
})
