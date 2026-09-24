import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { createBrowserController, browserStatus } from '../src/kernel/browser/controller.mjs'
import { ArtifactStore } from '../src/storage/artifact-store.mjs'
import { createTaskArtifactAccess, archiveBrowserFile, readBrowserUpload } from '../src/kernel/tool/artifacts.mjs'

test('real isolated Browser owns tabs, frames and stale refs; scoped uploads/downloads never expose host paths', { timeout: 60000 }, async t => {
  if (!(await browserStatus()).installed) { if (process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('Browser engine required'); t.skip('Install dedicated Browser engine'); return }
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-browser-flow-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  let downloadHits = 0, uploaded = ''
  const payload = Buffer.from('fixture-download\0binary'), compressed = gzipSync(payload)
  const app = http.createServer((req, res) => {
    if (req.url === '/file?token=fixture-hidden') { downloadHits++; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Disposition': 'attachment; filename="fixture.bin"' }); res.end(compressed); return }
    if (req.url === '/oversized') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' }); res.end(gzipSync(Buffer.alloc(17 * 1024 * 1024))); return }
    if (req.url === '/upload') { req.on('data', data => { uploaded += data.toString() }); req.on('end', () => res.end('received')); return }
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/frame') { res.end('<button onclick="this.textContent=\'Frame clicked\'">Frame action</button>'); return }
    if (req.url === '/popup') { res.end('<title>Owned popup</title><p>Popup content</p>'); return }
    res.end(`<title>Workflow fixture</title><iframe name="child" src="/frame"></iframe>
      <button onclick="window.open('/popup')">Open popup</button>
      <button onclick="document.querySelector('output').textContent=confirm('Proceed?')?'Confirmed':'Cancelled'">Confirm action</button><output></output>
      <form action="/upload" method="post" enctype="multipart/form-data"><input type="file" aria-label="Upload file" name="file"><button>Send file</button></form>
      <a href="/file?token=fixture-hidden" download>Download file</a>`)
  })
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.address().port}`
  const browser = createBrowserController(), store = new ArtifactStore({ root: path.join(root, 'artifacts') })
  const actor = { accountId: 'fixture', projectId: 'p', sessionId: 's', runId: 'r' }
  const access = createTaskArtifactAccess({ store, resolveActor: async () => actor })
  const ctx = { sessionId: 'workflow', config: { tool: { browser: { chromium_sandbox: false } } }, artifactAccess: access, toolCallId: 'file-download' }
  try {
    const first = await browser.execute({ action: 'open', url }, ctx)
    await assert.rejects(browser.execute({ action: 'click', role: 'button', name: 'Confirm action' }, { ...ctx, recipeGuard: { origin: url, fingerprint: '0'.repeat(64), authorize: async () => true } }), error => error.operationNotStarted === true)
    await assert.rejects(browser.execute({ action: 'click', role: 'button', name: 'Confirm action' }, { ...ctx, recipeGuard: { ...await browser.observe({ sessionId: ctx.sessionId }), authorize: async () => false } }), error => error.operationNotStarted === true)
    assert.equal((await browser.execute({ action: 'dialogs' }, ctx)).dialogs.length, 0, 'stale recipe guard stops dispatch before a page effect')
    const snapshot_id = /Snapshot: ([^\n]+)/.exec(first)[1]
    const ref = /button "Open popup" \[ref=(e\d+)\]/.exec(first)[1]
    const mainId = (await browser.execute({ action: 'tabs' }, ctx)).tabs[0].id
    await browser.execute({ action: 'click', snapshot_id, ref }, ctx)
    let tabs
    for (let i = 0; i < 30; i++) { tabs = (await browser.execute({ action: 'tabs' }, ctx)).tabs; if (tabs.length === 2) break; await new Promise(resolve => setTimeout(resolve, 25)) }
    assert.equal(tabs.length, 2)
    const popup = tabs.find(tab => tab.id !== mainId)
    assert.match(await browser.execute({ action: 'select_tab', tab_id: popup.id }, ctx), /Popup content/)
    await assert.rejects(browser.execute({ action: 'click', snapshot_id, ref }, ctx), /已失效/)
    await browser.execute({ action: 'close_tab' }, ctx)
    const frames = (await browser.execute({ action: 'frames' }, ctx)).frames
    const child = frames.find(frame => !frame.main)
    assert.ok(child)
    assert.match(await browser.execute({ action: 'click', frame_id: child.id, role: 'button', name: 'Frame action' }, ctx), /Frame clicked/)
    await browser.execute({ action: 'click', role: 'button', name: 'Confirm action' }, ctx)
    assert.match(await browser.execute({ action: 'snapshot' }, ctx), /Cancelled/)
    await browser.execute({ action: 'click', role: 'button', name: 'Confirm action', dialog_response: { accept: true } }, ctx)
    assert.match(await browser.execute({ action: 'snapshot' }, ctx), /Confirmed/)
    assert.equal((await browser.execute({ action: 'dialogs' }, ctx)).dialogs.length, 2)
    const input = await archiveBrowserFile({ access, content: Buffer.from('uploaded-artifact'), mime: 'text/plain' })
    const other = createTaskArtifactAccess({ store, resolveActor: async () => ({ ...actor, sessionId: 'other' }) })
    await assert.rejects(browser.execute({ action: 'upload', selector: 'input[type=file]', artifact_id: input.id }, { ...ctx, artifactAccess: other }), error => error.code === 'artifact_not_found')
    await assert.rejects(browser.execute({ action: 'upload', selector: 'input[type=file]', artifact_id: '/etc/passwd' }, ctx))
    await browser.execute({ action: 'upload', selector: 'input[type=file]', artifact_id: input.id }, ctx)
    await browser.execute({ action: 'click', role: 'button', name: 'Send file' }, ctx)
    assert.match(uploaded, /uploaded-artifact/)
    await browser.execute({ action: 'open', url }, ctx)
    const result = await browser.execute({ action: 'download', role: 'link', name: 'Download file' }, ctx).catch(async error => { t.diagnostic(JSON.stringify({ downloadHits, diagnostics: await browser.execute({ action: 'diagnostics' }, ctx) })); throw error })
    assert.equal(downloadHits, 1, 'one-use downloads are captured, never fetched twice')
    assert.equal(result.metadata.artifactComplete, true)
    assert.deepEqual((await readBrowserUpload({ access, id: result.metadata.artifactRef.id })).buffer, payload)
    assert.doesNotMatch(JSON.stringify(result), /token|fixture-hidden|\/tmp\//)
    const beforeCount = (await access.list()).items.length
    await assert.rejects(browser.execute({ action: 'download', url: url + '/file?token=fixture-hidden' }, { ...ctx, artifactAccess: { ...access } }), error => error.code === 'artifact_host_required')
    assert.equal(downloadHits, 1, 'forged storage authority is rejected before any network request')
    await assert.rejects(browser.execute({ action: 'download', url: url + '/oversized' }, ctx), /limit|large|MiB|exceed/i)
    assert.equal((await access.list()).items.length, beforeCount, 'no partial oversized artifact is published')
    const diagnostics = await browser.execute({ action: 'diagnostics' }, ctx)
    assert.doesNotMatch(diagnostics.output, /fixture-hidden/)
  } finally {
    await browser.shutdown(); await new Promise(resolve => app.close(resolve))
    if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old
    await rm(root, { recursive: true, force: true })
  }
})

test('untrusted project cannot choose Browser executable; explicit user engine settings are preserved', { timeout: 20000 }, async t => {
  if (!(await browserStatus()).installed) { t.skip('Browser engine unavailable'); return }
  if (process.platform === 'win32') { t.skip('POSIX malicious executable fixture'); return }
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-browser-provenance-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  const marker = path.join(root, 'project-program-started'), executable = path.join(root, 'project-program')
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started')\n`, { mode: 0o700 })
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<h1>User engine</h1>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const launchOptions = [], browser = createBrowserController({ launch: (profile, options) => { launchOptions.push(options); return chromium.launchPersistentContext(profile, options) } })
  const user = { tool: { browser: { executable_path: chromium.executablePath(), chromium_sandbox: false } } }
  const ctx = { sessionId: 'untrusted', config: { tool: { browser: { executable_path: executable, chromium_sandbox: true } } }, configState: { workspaceTrust: { trusted: false }, userConfig: user } }
  try {
    await assert.rejects(browser.execute({ action: 'open', url: 'http://127.0.0.1' }, { sessionId: 'strict-before-launch', config: ctx.config, strictManagedBrowser: true }), /启动前拒绝/)
    assert.equal(launchOptions.length, 0)
    await assert.rejects(access(marker))
    assert.match(await browser.execute({ action: 'open', url: `http://127.0.0.1:${server.address().port}` }, ctx), /User engine/)
    assert.equal(launchOptions[0].executablePath, chromium.executablePath())
    assert.equal(launchOptions[0].chromiumSandbox, false, 'only explicit user fixture setting is honored')
    await assert.rejects(access(marker))
    await assert.rejects(browser.execute({ action: 'snapshot' }, { ...ctx, configState: { workspaceTrust: { trusted: false }, userConfig: {} } }), /信任已变化/)
    await assert.rejects(access(marker))
  } finally {
    await browser.shutdown(); await new Promise(resolve => server.close(resolve))
    if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old
    await rm(root, { recursive: true, force: true })
  }
})

test('recipe origin ceiling blocks cross-site POST and redirects, survives snapshots, and fingerprints form destinations', { timeout: 30000 }, async t => {
  if (!(await browserStatus()).installed) { t.skip('Browser engine unavailable'); return }
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-browser-recipe-origin-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  let foreignHits = 0
  const foreign = http.createServer((_request, response) => { foreignHits++; response.setHeader('content-type', 'text/html'); response.end('<h1>Other previously approved site</h1>') })
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve))
  const other = `http://127.0.0.1:${foreign.address().port}`
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: `${other}/moved` }); response.end(); return }
    response.setHeader('content-type', 'text/html')
    response.end(`<button onclick="fetch('${other}/write',{method:'POST',body:'sensitive fixture'}).catch(()=>{})">Cross site</button><form action="/same" method="post"><button>Submit</button></form><button onclick="document.querySelector('form').action='${other}/changed'">Change target</button>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, browser = createBrowserController()
  const ctx = { sessionId: 'recipe-origin', config: { tool: { browser: { chromium_sandbox: false } } } }
  try {
    await browser.execute({ action: 'open', url: other }, ctx)
    await browser.execute({ action: 'open', url: origin }, ctx)
    foreignHits = 0
    const guard = { ...await browser.observe(ctx), authorize: async () => true }
    await browser.execute({ action: 'click', role: 'button', name: 'Cross site' }, { ...ctx, recipeGuard: guard })
    await browser.execute({ action: 'snapshot' }, ctx)
    await browser.execute({ action: 'click', role: 'button', name: 'Cross site' }, ctx)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(foreignHits, 0, 'ordinary snapshot must not widen a recipe-narrowed context')
    await assert.rejects(browser.execute({ action: 'open', url: 'file:///etc/passwd' }, ctx))
    await browser.execute({ action: 'click', role: 'button', name: 'Cross site' }, ctx)
    assert.equal(foreignHits, 0, 'invalid explicit open must not release the origin ceiling')
    await browser.execute({ action: 'click', role: 'button', name: 'Change target' }, ctx)
    assert.notEqual((await browser.observe(ctx)).fingerprint, guard.fingerprint)
    await assert.rejects(browser.execute({ action: 'click', role: 'button', name: 'Submit' }, { ...ctx, recipeGuard: guard }), error => error.operationNotStarted === true)
    await browser.execute({ action: 'open', url: origin }, ctx)
    const fresh = { ...await browser.observe(ctx), authorize: async () => true }
    await assert.rejects(browser.execute({ action: 'open', url: origin + '/redirect' }, { ...ctx, recipeGuard: fresh }))
    assert.equal(foreignHits, 0, 'a final same-origin open cannot redirect to another approved site')
    assert.match(await browser.execute({ action: 'open', url: other }, ctx), /Other previously approved/)
    assert.equal(foreignHits, 1, 'a separately governed valid explicit open may switch sites')
  } finally {
    await browser.shutdown(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => foreign.close(resolve))
    if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old
    await rm(root, { recursive: true, force: true })
  }
})
