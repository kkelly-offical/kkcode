// Explicit acceptance harness only: builds the official extension from a pinned
// source checkout and uses a new disposable profile and synthetic login cookie.
// It never opens or copies a person's existing browser profile.
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import sharp from 'sharp'
import { chromium } from 'playwright-core'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { browserBridgeStatus, bridgeProcessEnvironment } from '../src/kernel/browser/bridge-runtime.mjs'
import { authorizeBrowserBridge, createBrowserBridgeController, revokeBrowserBridge } from '../src/kernel/browser/bridge.mjs'

const source = process.env.KKCODE_BRIDGE_EXTENSION_SOURCE, runtimeRoot = process.env.KKCODE_BRIDGE_TEST_RUNTIME
if (!source || !runtimeRoot) throw new Error('Provide dedicated KKCODE_BRIDGE_EXTENSION_SOURCE and KKCODE_BRIDGE_TEST_RUNTIME acceptance paths')
const exec = promisify(execFile)
const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
assert.equal(revision, '1b025d7e20a026371cd5f98ba0cdce48892737c8', 'official Playwright v1.63.0 source is pinned')
const fixture = await mkdtemp(path.join(os.tmpdir(), 'kkcode-bridge-live-'))
const oldRoot = process.env.KKCODE_HOME
process.env.KKCODE_HOME = path.join(fixture, 'kkcode-state')
let context, controller, server, screenshotResultFormat
try {
  const extensionSource = path.join(source, 'packages/extension'), dist = path.join(fixture, 'extension'), profile = path.join(fixture, 'browser-profile')
  await mkdir(path.join(dist, 'lib/ui'), { recursive: true })
  await cp(path.join(extensionSource, 'icons'), path.join(dist, 'icons'), { recursive: true })
  await cp(path.join(extensionSource, 'manifest.json'), path.join(dist, 'manifest.json'))
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, '0.4.0')
  await build({ entryPoints: [path.join(extensionSource, 'src/background.ts')], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(dist, 'lib/background.mjs'), logLevel: 'silent' })
  for (const name of ['connect', 'status']) {
    await build({ entryPoints: [path.join(extensionSource, `src/ui/${name}.tsx`)], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(dist, `lib/ui/${name}.js`), nodePaths: [path.resolve('node_modules')], logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } })
    const styles = await readFile(path.join(dist, `lib/ui/${name}.css`), 'utf8').catch(() => '')
    const pageStyles = await readFile(path.join(extensionSource, 'src/ui/connect.css'), 'utf8')
    await writeFile(path.join(dist, `lib/ui/${name}.css`), `${styles}\n${pageStyles}`)
    const html = (await readFile(path.join(extensionSource, `src/ui/${name}.html`), 'utf8')).replaceAll('../../icons/', 'icons/').replace(/href="(?:connect|status)\.css"/, `href="lib/ui/${name}.css"`).replace(`src="${name}.tsx"`, `src="lib/ui/${name}.js"`)
    await writeFile(path.join(dist, `${name}.html`), html)
  }
  let clicked = false
  server = http.createServer((request, response) => {
    if (request.url === '/submit') { clicked = true; response.end('ok'); return }
    response.setHeader('content-type', 'text/html')
    response.end(`<title>KK synthetic bridge fixture</title><style>html,body{background:${request.url === '/unshared' ? '#f1111d' : '#113311'}}</style><h1>${request.headers.cookie?.includes('fixture_login=local-only') ? 'Signed in fixture' : 'Not signed in'}</h1><button onclick="fetch('/submit').then(()=>this.textContent='Saved')">Save fixture</button><iframe title="PRIVATE EMBEDDED TITLE" src="data:text/html,${encodeURIComponent('<p>PRIVATE_EMBEDDED_FRAME_CANARY</p>')}"></iframe>`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  context = await chromium.launchPersistentContext(profile, { headless: false, chromiumSandbox: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], env: bridgeProcessEnvironment() })
  await context.addCookies([{ name: 'fixture_login', value: 'local-only', url: origin }])
  const page = context.pages()[0] || await context.newPage()
  await page.goto(origin)
  assert.equal(await page.frameLocator('iframe').locator('p').textContent(), 'PRIVATE_EMBEDDED_FRAME_CANARY', 'the real page has an opaque-origin nested frame')
  const excluded = await context.newPage()
  await excluded.goto(`${origin}/unshared`)
  await page.bringToFront()
  const runtime = await browserBridgeStatus({ rootDir: runtimeRoot })
  controller = createBrowserBridgeController({ connect: async ({ outputDir }) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [runtime.cli, '--extension', '--browser', 'chromium', '--executable-path', chromium.executablePath(), '--user-data-dir', profile, '--profile-dir-name', 'Default', '--codegen', 'none', '--output-dir', outputDir], env: bridgeProcessEnvironment(), cwd: outputDir, stderr: 'pipe' })
    transport.stderr.on('data', () => {})
    const client = new Client({ name: 'KK Code bridge acceptance', version: '1.0.5' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    await client.connect(transport, { timeout: 15000 })
    return { call: async (name, args, signal) => {
      const result = await client.callTool({ name, arguments: args }, { timeout: 60000, signal })
      if (name === 'browser_take_screenshot') {
        const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n')
        screenshotResultFormat = { sections: [...text.matchAll(/^### ([^\n]+)/gm)].map(match => match[1]), pageUrlDeclared: /^- Page URL:/m.test(text), snapshotIncluded: /^### Snapshot$/m.test(text) }
      }
      return result
    }, close: () => client.close() }
  } })
  await authorizeBrowserBridge({ sessionId: 'bridge-live-fixture', origins: [origin], allowInteraction: true, confirmed: true })
  const ctx = { sessionId: 'bridge-live-fixture', config: {} }
  await assert.rejects(controller.execute({ action: 'screenshot' }, ctx), /allow-screenshots/)
  await authorizeBrowserBridge({ sessionId: 'bridge-live-fixture', origins: [origin], allowInteraction: true, allowScreenshots: true, confirmed: true })
  const connecting = controller.execute({ action: 'snapshot' }, ctx)
  connecting.catch(() => {})
  const approval = await context.waitForEvent('page', { predicate: candidate => candidate.url().includes('chrome-extension://'), timeout: 15000 })
  await approval.locator('.tab-item').filter({ has: approval.locator('.tab-url', { hasText: `${origin}/` }) }).filter({ hasNotText: '/unshared' }).getByRole('button', { name: 'Allow & select' }).click({ timeout: 10000 })
  const snapshot = await connecting
  assert.match(snapshot.output, /Signed in fixture/)
  assert.ok(!snapshot.output.includes('/unshared'))
  assert.doesNotMatch(snapshot.output, /PRIVATE EMBEDDED|PRIVATE_EMBEDDED_FRAME_CANARY/)
  assert.match(snapshot.output, /嵌入页面已省略/)
  const snapshot_id = /snapshot_id: ([^\n]+)/.exec(snapshot.output)?.[1]
  const ref = /button "Save fixture" \[ref=((?:f\d+)?e\d+)\]/.exec(snapshot.output)?.[1]
  assert.ok(snapshot_id && ref, 'live snapshot provides a bound reference')
  const tabs = JSON.parse((await controller.execute({ action: 'tabs' }, ctx)).output)
  assert.equal(tabs.tabs.length, 1, 'official selected group excludes the second personal fixture tab')
  assert.ok(!JSON.stringify(tabs).includes('/unshared'))
  const selected = await controller.execute({ action: 'select_tab', tab_list_id: tabs.tab_list_id, tab_id: tabs.tabs[0].id }, ctx)
  const selectedId = /snapshot_id: ([^\n]+)/.exec(selected.output)?.[1]
  const clickResult = await controller.execute({ action: 'click', snapshot_id: selectedId, ref }, ctx)
  assert.equal(clicked, true)
  const nextSnapshotId = /snapshot_id: ([^\n]+)/.exec(clickResult.output)?.[1]
  const screenshot = await controller.execute({ action: 'screenshot', snapshot_id: nextSnapshotId }, ctx)
  assert.ok(screenshot.content?.some(item => item.type === 'image' && item.data), 'real screenshot reaches the normalized tool result')
  const pixels = await sharp(Buffer.from(screenshot.content.find(item => item.type === 'image').data, 'base64')).removeAlpha().raw().toBuffer()
  assert.deepEqual([...pixels.subarray(0, 3)], [17, 51, 17], 'pixels belong to the selected green fixture, not the unapproved red tab')
  assert.equal(screenshot.metadata.bridge.imageOriginVerified, false)
  assert.deepEqual(screenshotResultFormat, { sections: ['Result'], pageUrlDeclared: false, snapshotIncluded: false }, 'the pinned upstream screenshot response does not prove an operation-time page origin')
  await revokeBrowserBridge({ sessionId: 'bridge-live-fixture' })
  await assert.rejects(controller.execute({ action: 'snapshot' }, ctx), /尚未授权/)
  await controller.shutdown()
  assert.equal(page.isClosed(), false)
  assert.equal(excluded.isClosed(), false)
  console.log(JSON.stringify({ passed: true, runtime: runtime.version, extension: manifest.version, sourceRevision: revision, syntheticCookie: true, approvalDialog: true, limitedActions: true, nestedFrameContentOmitted: true, screenshot: true, unapprovedTabPixelsAbsent: true, screenshotResultFormat, revoked: true, existingUserProfilesTouched: false }))
} finally {
  await controller?.shutdown().catch(() => {})
  await context?.close().catch(() => {})
  server?.closeAllConnections(); server?.close()
  if (oldRoot === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = oldRoot
  await rm(fixture, { recursive: true, force: true })
}
