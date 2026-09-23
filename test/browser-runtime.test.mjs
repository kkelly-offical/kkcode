import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { WebSocketServer } from 'ws'
import { BrowserNetwork } from '../src/kernel/browser/network.mjs'
import { createBrowserController, browserStatus } from '../src/kernel/browser/controller.mjs'
import { toolResultContent } from '../src/kernel/tool/result-content.mjs'
import { planModeAllows } from '../src/kernel/session/loop.mjs'

test('browser URL policy blocks credentials, metadata/mapped-IP aliases and private redirect hops', async () => {
  const network = new BrowserNetwork()
  for (const url of ['file:///etc/passwd', 'http://user:pass@example.com', 'http://169.254.169.254/', 'http://[::ffff:a9fe:a9fe]/', 'http://100.100.100.200/', 'http://metadata.google.internal/']) await assert.rejects(network.target(url, true))
  await network.target('http://127.0.0.1:12345', true)
  await assert.doesNotReject(network.target('http://127.0.0.1:12345/app'))
  await assert.rejects(network.target('http://127.0.0.1:12346/secret'), /Private/)
  await assert.rejects(network.websocket('ws://127.0.0.1:12346/', { origin: 'http://127.0.0.1:12345' }), /origin/)
  await assert.rejects(network.websocket('ws://169.254.169.254/', { origin: 'http://169.254.169.254' }), /metadata/)
  network.close()
})

test('public DNS cannot rebind into a private origin; approved private origins pin their addresses', async () => {
  let address = '93.184.216.34'
  const network = new BrowserNetwork({ lookup: async () => [{ address, family: 4 }] })
  await network.target('https://public.example', true)
  address = '127.0.0.1'
  await assert.rejects(network.target('https://public.example'), /Private/)
  await network.target('http://dev.example:5173', true)
  address = '10.0.0.9'
  await assert.rejects(network.target('http://dev.example:5173'), /Private/)
  network.close()
})

test('plan-mode browser surface is inspection-only', () => {
  for (const action of ['status', 'snapshot', 'screenshot', 'close']) assert.equal(planModeAllows('browser', { action }), true)
  for (const action of ['open', 'click', 'fill', 'press']) assert.equal(planModeAllows('browser', { action }), false)
})

test('real Browser opens a dev page, fills/clicks, produces model-visible pixels and isolates cookies/network', { timeout: 45000 }, async t => {
  if (!(await browserStatus()).installed) {
    if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Install the browser engine before acceptance')
    t.skip('Run kkcode browser install, then npm run test:browser for mandatory acceptance'); return
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-browser-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  let blockedHits = 0
  const blocked = http.createServer((_req, res) => { blockedHits++; res.end('private') })
  await new Promise(resolve => blocked.listen(0, '127.0.0.1', resolve))
  const blockedPort = blocked.address().port
  const app = http.createServer((req, res) => {
    if (req.url.startsWith('/socket')) { res.setHeader('Content-Type', 'text/html'); res.end('<title>HMR fixture</title><output>connecting</output><script>console.info("development connected");const s=new WebSocket(location.origin.replace("http", "ws")+"/hmr");s.onmessage=e=>document.querySelector("output").textContent=e.data;s.onopen=()=>s.send("hot reload ready");s.onclose=()=>document.querySelector("output").textContent="socket closed";</script>'); return }
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${blockedPort}/secret` }); res.end(); return }
    if (req.url === '/cookies') { res.end(req.headers.cookie || 'empty'); return }
    res.setHeader('Content-Type', 'text/html'); res.setHeader('Set-Cookie', 'fixture=one; Path=/; HttpOnly')
    res.end(`<title>Browser fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('output').textContent='Hello '+document.querySelector('input').value">Greet</button><output></output><img src="http://127.0.0.1:${blockedPort}/secret">`)
  })
  const sockets = new WebSocketServer({ server: app }); sockets.on('connection', socket => socket.on('message', data => socket.send(data.toString())))
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.address().port}`
  const browser = createBrowserController()
  // Explicitly isolated fixture only: root CI containers cannot use Chromium's
  // Linux user namespace sandbox. The product default remains enabled.
  const ctx = { sessionId: 'one', config: { tool: { browser: { chromium_sandbox: false } } } }
  try {
    assert.match(await browser.execute({ action: 'open', url }, ctx), /Browser fixture/)
    await browser.execute({ action: 'fill', role: 'textbox', name: 'Name', value: 'KK Code' }, ctx)
    await browser.execute({ action: 'click', role: 'button', name: 'Greet' }, ctx)
    assert.match(await browser.execute({ action: 'snapshot' }, ctx), /Hello KK Code/)
    const screenshot = await browser.execute({ action: 'screenshot' }, ctx)
    const result = await toolResultContent(screenshot, screenshot.output)
    assert.equal(result.contentBlocks.length, 1)
    assert.equal((await sharp(Buffer.from(result.contentBlocks[0].data, 'base64')).metadata()).width, 1280)
    assert.equal(blockedHits, 0)
    assert.match(await browser.execute({ action: 'open', url: url + '/cookies' }, ctx), /fixture=one/)
    assert.match(await browser.execute({ action: 'open', url: url + '/cookies' }, { ...ctx, sessionId: 'two' }), /empty/)
    await assert.rejects(browser.execute({ action: 'open', url: url + '/redirect' }, ctx))
    assert.equal(blockedHits, 0)
    await browser.execute({ action: 'open', url: url + '/socket?private_fixture=hidden' }, ctx)
    let snapshot = ''
    for (let attempt = 0; attempt < 30; attempt++) { snapshot = await browser.execute({ action: 'snapshot' }, ctx); if (snapshot.includes('socket closed')) break; await new Promise(resolve => setTimeout(resolve, 50)) }
    assert.match(snapshot, /socket closed/, 'ordinary browsing keeps sockets disabled')
    await browser.execute({ action: 'open', url: url + '/socket?private_fixture=hidden', development: true }, ctx)
    for (let attempt = 0; attempt < 50; attempt++) { snapshot = await browser.execute({ action: 'snapshot' }, ctx); if (snapshot.includes('hot reload ready')) break; await new Promise(resolve => setTimeout(resolve, 50)) }
    assert.match(snapshot, /hot reload ready/, 'same-origin development socket uses the guarded bridge')
    const diagnostics = (await browser.execute({ action: 'diagnostics' }, ctx)).output
    assert.match(diagnostics, /development connected/)
    assert.equal(diagnostics.includes('private_fixture'), false)
    await browser.execute({ action: 'viewport', width: 390, height: 844 }, ctx)
    const mobile = await browser.execute({ action: 'screenshot' }, ctx)
    assert.equal((await sharp(Buffer.from(mobile.content[0].data, 'base64')).metadata()).width, 390)
    await assert.rejects(browser.execute({ action: 'open', url: 'file:///etc/passwd' }, ctx), /HTTP/)
    await browser.execute({ action: 'close' }, ctx)
  } finally {
    await browser.shutdown()
    for (const socket of sockets.clients) socket.terminate(); await new Promise(resolve => sockets.close(resolve))
    assert.deepEqual(await readdir(path.join(root, 'browser')), [])
    await new Promise(resolve => app.close(resolve)); await new Promise(resolve => blocked.close(resolve))
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
