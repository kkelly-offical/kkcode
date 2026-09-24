import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { BrowserNetwork } from '../src/kernel/browser/network.mjs'
import { browserStatus, createBrowserController } from '../src/kernel/browser/controller.mjs'
import { createBrowserActionAuthorization, consumeBrowserActionAuthorization, browserActionNeedsAuthorization } from '../src/kernel/browser/action-authorization.mjs'

async function server(handler) {
  const app = http.createServer(handler)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  return { server: app, url: `http://127.0.0.1:${app.address().port}`, close: async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)) } }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixtureLaunch(profile, options) {
  const root = process.platform === 'linux' && process.getuid?.() === 0
  if (process.env.KKCODE_REQUIRE_STRICT_BROWSER === '1') assert.equal(root, false, 'strict acceptance requires the native sandbox, not a root component override')
  // Root-only local component evidence is never OS sandbox acceptance. Real
  // non-root strict CI keeps every production launch option unchanged.
  return chromium.launchPersistentContext(profile, root ? { ...options, chromiumSandbox: false } : options)
}

test('strict Browser network admits writes only in the current window and drains dispatched writes', async () => {
  let hits = 0, current = true
  const received = deferred(), respond = deferred()
  const app = await server(async (req, res) => { if (req.method === 'POST') { hits++; received.resolve(); await respond.promise } res.end('ok') })
  const network = new BrowserNetwork()
  try {
    network.setStrictEffects(); await network.target(app.url, true)
    network.beginAction()
    await assert.rejects(network.fetch(app.url, { method: 'POST', body: Buffer.from('x') }), { code: 'browser_write_blocked' })
    await assert.rejects(network.websocket(app.url.replace('http:', 'ws:'), { origin: app.url }), { code: 'browser_websocket_blocked' })
    const readScope = network.captureRequestScope()
    assert.equal(hits, 0); await network.finishAction()
    network.beginAction({ origin: app.url, assertCurrent: async () => { assert.ok(current) } })
    await assert.rejects(network.fetch(app.url, { method: 'POST', actionScope: readScope }), { code: 'browser_write_blocked' })
    const write = network.fetch(app.url, { method: 'POST', body: Buffer.from('x') })
    await received.promise
    let finished = false
    const finish = network.finishAction().then(() => { finished = true })
    await assert.rejects(network.fetch(app.url, { method: 'POST' }), { code: 'browser_write_blocked' })
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(finished, false)
    respond.resolve(); await write; await finish; assert.equal(hits, 1)
    network.beginAction({ origin: app.url, assertCurrent: async () => { assert.ok(current) } }); current = false
    await assert.rejects(network.fetch(app.url, { method: 'POST' }), { code: 'browser_effect_rejected' })
    await assert.rejects(network.finishAction(), { code: 'browser_effect_rejected' }); assert.equal(hits, 1)
  } finally { respond.resolve(); network.close(); await app.close() }
})

test('strict Browser freezes write grant before DNS and preserves uncertain transport outcomes', async () => {
  let hits = 0
  const app = await server((req, res) => { if (req.method === 'POST') { hits++; req.socket.destroy(); return } res.end('ok') })
  const lookupStarted = deferred(), lookupRelease = deferred()
  const network = new BrowserNetwork({ lookup: async () => { lookupStarted.resolve(); await lookupRelease.promise; return [{ address: '127.0.0.1', family: 4 }] } })
  try {
    network.setStrictEffects(); await network.target(app.url, true)
    const alias = app.url.replace('127.0.0.1', 'fixture.test')
    network.privateOrigins.set(alias, new Set(['127.0.0.1']))
    network.beginAction({ origin: alias, assertCurrent: async () => {} })
    const write = assert.rejects(network.fetch(alias, { method: 'POST' }), { code: 'browser_effect_rejected' })
    await lookupStarted.promise
    const finish = assert.rejects(network.finishAction(), { code: 'browser_effect_rejected' })
    lookupRelease.resolve(); await write; await finish; assert.equal(hits, 0)
    const separate = new BrowserNetwork()
    try {
      separate.setStrictEffects(); await separate.target(app.url, true)
      separate.beginAction({ origin: app.url, assertCurrent: async () => {} })
      await assert.rejects(separate.fetch(app.url, { method: 'POST' }), { code: 'browser_effect_unknown' })
      await assert.rejects(separate.finishAction(), { code: 'browser_effect_unknown' })
      assert.throws(() => separate.beginAction(), { code: 'browser_effect_unknown' }); assert.equal(hits, 1)
    } finally { separate.close() }
  } finally { lookupRelease.resolve(); network.close(); await app.close() }
})

test('strict Browser write drain has a deadline even when DNS ignores cancellation', { timeout: 15000 }, async () => {
  const started = deferred(), release = deferred()
  let hits = 0
  const app = await server((_req, res) => { hits++; res.end('unexpected') })
  const alias = app.url.replace('127.0.0.1', 'fixture.test')
  const network = new BrowserNetwork({ lookup: async () => { started.resolve(); await release.promise; return [{ address: '127.0.0.1', family: 4 }] } })
  try {
    network.setStrictEffects(); network.privateOrigins.set(alias, new Set(['127.0.0.1']))
    network.beginAction({ origin: alias, assertCurrent: async () => {} })
    const pending = assert.rejects(network.fetch(alias, { method: 'POST' }), { code: 'browser_effect_unknown' })
    await started.promise
    const time = Date.now()
    await assert.rejects(network.finishAction(), { code: 'browser_effect_unknown' })
    assert.ok(Date.now() - time >= 9900)
    assert.throws(() => network.beginAction(), { code: 'browser_effect_unknown' })
    release.resolve(); await pending; assert.equal(hits, 0)
  } finally { release.resolve(); network.close(); await app.close() }
})

test('Browser action capabilities bind exact args, selected document, owner and single consumption', async () => {
  const observation = { origin: 'https://fixture.example', fingerprint: 'a'.repeat(64), tabId: 't', frameId: 'f', documentEpoch: 1 }
  const args = { action: 'click', role: 'button', name: 'Save' }
  let current = true
  const issue = () => createBrowserActionAuthorization({ sessionId: 's', args, taskId: 'r', actor: { accountId: 'a' }, observation, verify: async () => current })
  const consume = (token, overrides = {}) => consumeBrowserActionAuthorization(token, { sessionId: 's', args, observe: async () => observation, ...overrides })
  assert.equal(browserActionNeedsAuthorization({ action: 'open' }), false)
  assert.equal(browserActionNeedsAuthorization({ action: 'open', development: true }), true)
  assert.equal(browserActionNeedsAuthorization({ action: 'snapshot', dialog_response: { accept: true } }), true)
  await assert.rejects(consume({}), { code: 'browser_action_authorization_invalid' })
  await assert.rejects(consume(issue(), { args: { ...args, name: 'Delete' } }), { code: 'browser_action_authorization_invalid' })
  await assert.rejects(consume(issue(), { observe: async () => ({ ...observation, frameId: 'other' }) }), { code: 'browser_action_authorization_invalid' })
  const token = issue(), results = await Promise.allSettled([consume(token), consume(token)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  current = false; await assert.rejects(consume(issue()), { code: 'browser_action_authorization_invalid' })
})

test('strict network does not let another frame borrow an approved origin or action', async () => {
  let hits = 0
  const app = await server((_req, res) => { hits++; res.end('ok') }), network = new BrowserNetwork()
  const selectedFrame = {}, otherFrame = {}
  try {
    network.setStrictEffects(); await network.target(app.url, true)
    network.beginAction({ origin: app.url, source: selectedFrame, assertCurrent: async () => {} })
    await assert.rejects(network.fetch(app.url, { method: 'POST', source: otherFrame }), { code: 'browser_effect_rejected' })
    await assert.rejects(network.finishAction(), { code: 'browser_effect_rejected' }); assert.equal(hits, 0)
  } finally { network.close(); await app.close() }
})

test('real Browser observation selects the requested tab/frame without switching current page', { timeout: 60000 }, async t => {
  if (!(await browserStatus()).installed) { if (process.env.KKCODE_REQUIRE_BROWSER === '1' || process.env.KKCODE_REQUIRE_STRICT_BROWSER === '1') assert.fail('Browser engine required'); t.skip('Dedicated Chromium unavailable'); return }
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-browser-frame-grant-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  let writes = 0
  const app = await server((req, res) => {
    if (req.method === 'POST') { writes++; res.end('done'); return }
    res.setHeader('content-type', 'text/html')
    res.end(req.url === '/frame' ? '<button onclick="fetch(\'/save\',{method:\'POST\'}).catch(()=>{})">Save</button>' : '<title>Main document</title><iframe src="/frame"></iframe>')
  })
  const browser = createBrowserController({ launch: fixtureLaunch })
  const ctx = { sessionId: 'frame', strictManagedBrowser: true, config: { data_policy: { web_origins: [app.url] } } }
  try {
    await browser.execute({ action: 'open', url: app.url }, ctx)
    const frames = (await browser.execute({ action: 'frames' }, ctx)).frames
    const frame = frames.find(value => !value.main)
    assert.ok(frame)
    // Wait only for the explicit selected frame to finish its local fixture load.
    await browser.execute({ action: 'snapshot', frame_id: frame.id }, ctx)
    const args = { action: 'click', frame_id: frame.id, role: 'button', name: 'Save' }
    const before = await browser.observe({ sessionId: ctx.sessionId }), selected = await browser.observe({ sessionId: ctx.sessionId, args })
    assert.notEqual(selected.frameId, before.frameId)
    assert.deepEqual(await browser.observe({ sessionId: ctx.sessionId }), before)
    const token = createBrowserActionAuthorization({ sessionId: ctx.sessionId, args, taskId: 'run', actor: { accountId: 'fixture' }, observation: selected, verify: async () => true })
    await browser.execute(args, { ...ctx, browserActionAuthorization: token }); assert.equal(writes, 1)
    const firstTab = before.tabId
    await browser.execute({ action: 'new_tab', url: `${app.url}/frame` }, ctx)
    const current = await browser.observe({ sessionId: ctx.sessionId })
    assert.notEqual(current.tabId, firstTab)
    assert.equal((await browser.observe({ sessionId: ctx.sessionId, args: { tab_id: firstTab } })).tabId, firstTab)
    assert.deepEqual(await browser.observe({ sessionId: ctx.sessionId }), current)
  } finally {
    await browser.shutdown(); await app.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('real Browser fixture blocks open-script writes, requires scoped click approval and surfaces failed POST', { timeout: 60000 }, async t => {
  if (!(await browserStatus()).installed) { if (process.env.KKCODE_REQUIRE_BROWSER === '1' || process.env.KKCODE_REQUIRE_STRICT_BROWSER === '1') assert.fail('Browser engine required'); t.skip('Dedicated Chromium unavailable'); return }
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-browser-effects-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  let writes = 0, failedWrites = 0, openedSockets = 0
  const app = await server((req, res) => {
    if (req.method === 'POST') { if (req.url === '/fail') { failedWrites++; req.socket.destroy(); return } writes++; setTimeout(() => res.end('saved'), 100); return }
    res.setHeader('content-type', 'text/html')
    res.end(`<title>Strict effects fixture</title><button onclick="fetch('/save',{method:'POST'}).catch(()=>{})">Save</button><button onclick="fetch('/fail',{method:'POST'}).catch(()=>{})">Fail</button><script>fetch('/startup',{method:'POST'}).catch(()=>{}); const ws=new WebSocket(location.origin.replace('http:','ws:')); ws.onerror=()=>{};</script>`)
  })
  app.server.on('upgrade', (_req, socket) => { openedSockets++; socket.destroy() })
  const browser = createBrowserController({ launch: fixtureLaunch })
  const ctx = { sessionId: 'effects', strictManagedBrowser: true, config: { tool: { browser: { chromium_sandbox: true } }, data_policy: { web_origins: [app.url] } } }
  try {
    await browser.execute({ action: 'open', url: app.url }, ctx)
    assert.equal(writes, 0); assert.equal(openedSockets, 0)
    const click = { action: 'click', role: 'button', name: 'Save' }
    await assert.rejects(browser.execute(click, ctx), { code: 'browser_action_authorization_invalid' }); assert.equal(writes, 0)
    const authorize = async args => createBrowserActionAuthorization({ sessionId: ctx.sessionId, args, taskId: 'run', actor: { accountId: 'fixture' }, observation: await browser.observe({ sessionId: ctx.sessionId, args }), verify: async () => true })
    const cap = await authorize(click)
    await browser.execute(click, { ...ctx, browserActionAuthorization: cap }); assert.equal(writes, 1)
    await assert.rejects(browser.execute(click, { ...ctx, browserActionAuthorization: cap }), { code: 'browser_action_authorization_invalid' }); assert.equal(writes, 1)
    const fail = { ...click, name: 'Fail' }
    await assert.rejects(browser.execute(fail, { ...ctx, browserActionAuthorization: await authorize(fail) }), { code: 'browser_effect_unknown' })
    assert.equal(failedWrites, 1)
    await assert.rejects(browser.execute({ action: 'snapshot' }, ctx), { code: 'browser_effect_unknown' })
  } finally {
    await browser.shutdown(); await app.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('entering strict scope closes an existing ordinary HMR socket even if strict config is rejected', { timeout: 30000 }, async t => {
  if (!(await browserStatus()).installed) { if (process.env.KKCODE_REQUIRE_BROWSER === '1' || process.env.KKCODE_REQUIRE_STRICT_BROWSER === '1') assert.fail('Browser engine required'); t.skip('Dedicated Chromium unavailable'); return }
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-browser-hmr-revoke-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  const app = await server((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>HMR fixture</title><script>new WebSocket(location.origin.replace("http:","ws:"))</script>') })
  const sockets = new WebSocketServer({ server: app.server }), connected = deferred(), disconnected = deferred()
  sockets.on('connection', socket => { connected.resolve(); socket.on('close', () => disconnected.resolve()) })
  const browser = createBrowserController({ launch: fixtureLaunch })
  const ordinary = { sessionId: 'old-hmr', config: { tool: { browser: { chromium_sandbox: process.platform !== 'linux' || process.getuid?.() !== 0 } } } }
  try {
    await browser.execute({ action: 'open', url: app.url, development: true }, ordinary)
    await connected.promise
    await assert.rejects(browser.execute({ action: 'snapshot' }, { ...ordinary, strictManagedBrowser: true, config: { tool: { browser: { chromium_sandbox: false } } } }), /旧页面和连接已关闭/)
    await disconnected.promise
    assert.equal(sockets.clients.size, 0)
    await assert.rejects(browser.execute({ action: 'snapshot' }, ordinary), /Open a page/)
  } finally {
    await browser.shutdown(); for (const socket of sockets.clients) socket.terminate()
    await new Promise(resolve => sockets.close(resolve)); await app.close()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
