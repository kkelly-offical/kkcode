// CI-only acceptance, not a product launcher. Official extension installation
// debugging is explicitly enabled only for a fresh GitHub-hosted runner profile.
// OS sandbox remains enabled; no remote-debugging TCP listener is opened.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, lstat, rm, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import sharp from 'sharp'
import { chromium } from 'playwright-core'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { browserBridgeStatus, bridgeProcessEnvironment } from '../src/kernel/browser/bridge-runtime.mjs'
import { authorizeBrowserBridge, createBrowserBridgeController, revokeBrowserBridge } from '../src/kernel/browser/bridge.mjs'

export const BRANDED_EXTENSION_REVISION = '1b025d7e20a026371cd5f98ba0cdce48892737c8'
export const BRANDED_EXTENSION_VERSION = '0.4.0'
export const BRANDED_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm'
const exec = promisify(execFile)
const blocked = (code, message) => Object.assign(new Error(message), { code, blocked: true })
const digest = value => createHash('sha256').update(value).digest('hex')
const privateChild = (parent, child) => { const relative = path.relative(parent, child); return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) }
const sourceAllowed = (temp, source, workspace) => privateChild(temp, source) || Boolean(workspace && source === path.resolve(workspace, 'test-results/bridge-extension-source'))
const unsafeFlag = /^(?:--no-sandbox|--disable-(?:setuid-sandbox|seccomp-filter-sandbox|namespace-sandbox|gpu-sandbox|web-security)|--single-process|--remote-debugging-port|--remote-allow-origins|--ignore-certificate-errors|--disable-features|--load-extension|--disable-extensions-except)(?:=|$)/

export function brandedBridgePreflight({ env = process.env, platform = process.platform, uid = process.getuid?.() } = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') throw blocked('github_hosted_required', 'This harness is restricted to ephemeral GitHub-hosted runners.')
  if (!['linux', 'darwin', 'win32'].includes(platform) || env.RUNNER_OS !== { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[platform]) throw blocked('runner_os_mismatch', 'Runner OS does not match the actual operating system.')
  if (platform === 'linux' && uid === 0) throw blocked('non_root_required', 'Linux branded acceptance must run without root and with the browser sandbox enabled.')
  if (env.KKCODE_BRIDGE_ALLOW_EXTENSION_DEBUGGING !== '1') throw blocked('extension_debug_opt_in_required', 'Explicit CI-only extension installation debugging consent is required.')
  const channel = env.KKCODE_BRIDGE_TEST_CHANNEL
  if (!['chrome', 'msedge'].includes(channel)) throw blocked('branded_channel_required', 'Choose the installed chrome or msedge channel; Chromium/CfT are not branded acceptance substitutes.')
  for (const key of ['RUNNER_TEMP', 'KKCODE_BRIDGE_EXTENSION_SOURCE', 'KKCODE_BRIDGE_TEST_RUNTIME']) if (!env[key] || !path.isAbsolute(env[key])) throw blocked('fixture_paths_required', `${key} must be an explicit absolute CI fixture path.`)
  const temp = path.resolve(env.RUNNER_TEMP)
  if (!sourceAllowed(temp, path.resolve(env.KKCODE_BRIDGE_EXTENSION_SOURCE), env.GITHUB_WORKSPACE)) throw blocked('fixture_scope_required', 'Extension source must be the explicit CI checkout or a RUNNER_TEMP child.')
  for (const key of ['KKCODE_BRIDGE_TEST_RUNTIME', 'KKCODE_BRIDGE_REPORT']) if (env[key] && !privateChild(temp, path.resolve(env[key]))) throw blocked('fixture_scope_required', `${key} must be inside RUNNER_TEMP, never a personal browser profile.`)
  return { channel, temp, source: path.resolve(env.KKCODE_BRIDGE_EXTENSION_SOURCE), runtimeRoot: path.resolve(env.KKCODE_BRIDGE_TEST_RUNTIME), report: env.KKCODE_BRIDGE_REPORT ? path.resolve(env.KKCODE_BRIDGE_REPORT) : null }
}

export function brandedLaunchOptions({ channel, profile, env }) {
  return { channel, headless: false, chromiumSandbox: true, ignoreDefaultArgs: true, timeout: 90000,
    // No hidden Playwright defaults that disable phishing checks, sandbox,
    // storage partitioning or first-run/licensing/permission screens.
    args: [`--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-automation', '--enable-unsafe-extension-debugging', '--no-default-browser-check', '--force-color-profile=srgb', 'about:blank'], env }
}

/** Page creation can precede its extension navigation on branded browsers. */
export function waitForBrandedApproval(context, extensionId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const observed = new Map()
    let settled = false
    const matches = page => {
      try { const url = new URL(page.url()); return url.protocol === 'chrome-extension:' && url.hostname === extensionId && url.pathname === '/connect.html' }
      catch { return false }
    }
    const cleanup = () => {
      clearTimeout(timer); context.off('page', observe)
      for (const [page, callback] of observed) page.off('framenavigated', callback)
    }
    const check = page => { if (!settled && matches(page)) { settled = true; cleanup(); resolve(page) } }
    const observe = page => {
      if (settled || observed.has(page)) return
      const callback = () => check(page)
      observed.set(page, callback); page.on('framenavigated', callback); check(page)
    }
    const timer = setTimeout(() => { settled = true; cleanup(); reject(blocked('extension_approval_unavailable', 'The exact official extension approval page did not become available; no unrelated first-run, sign-in or permission page was accepted.')) }, timeoutMs)
    context.on('page', observe)
    for (const page of context.pages()) observe(page)
  })
}

export function verifyBrandedIdentity({ channel, platform, commandLine, version, userAgent, profile }) {
  if (!Array.isArray(commandLine) || !commandLine.length || commandLine.some(arg => unsafeFlag.test(arg))) throw blocked('unsafe_browser_launch', 'Browser launch contains a forbidden sandbox/security/network-debugging override.')
  if (!commandLine.includes('--remote-debugging-pipe') || !commandLine.includes('--enable-unsafe-extension-debugging')) throw blocked('installation_debugging_unavailable', 'The requested official pipe-only extension installation setup is absent.')
  const normalize = value => platform === 'win32' ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value)
  const dataArgs = commandLine.filter(arg => arg.startsWith('--user-data-dir='))
  if (dataArgs.length !== 1 || normalize(dataArgs[0].slice('--user-data-dir='.length)) !== normalize(profile)) throw blocked('profile_scope_mismatch', 'Browser is not using the fresh fixture profile.')
  const binary = commandLine[0].replaceAll('\\', '/')
  const expected = channel === 'chrome'
    ? platform === 'darwin' ? /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/ : platform === 'win32' ? /\/Google\/Chrome\/Application\/chrome\.exe$/i : /\/google\/chrome\/chrome$/
    : platform === 'darwin' ? /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge$/ : platform === 'win32' ? /\/Microsoft\/Edge\/Application\/msedge\.exe$/i : /\/microsoft\/msedge\/msedge$/
  if (!expected.test(binary) || /(?:Chromium|Chrome for Testing)/i.test(binary)) throw blocked('browser_brand_mismatch', 'The actual executable is not the requested installed branded browser.')
  if (!/Chrome\/\d+/.test(userAgent) || /HeadlessChrome/.test(userAgent) || (channel === 'msedge') !== /Edg\/\d+/.test(userAgent) || typeof version?.product !== 'string') throw blocked('browser_brand_mismatch', 'Actual browser version/user agent does not match the requested headed branded channel.')
  return { channel, executable: commandLine[0], product: version.product, revision: version.revision, userAgent, jsVersion: version.jsVersion,
    pipeOnly: true, freshProfile: true, osSandboxRequested: true, sandboxDisableFlagsAbsent: true,
    sandboxEvidence: 'launch configuration and actual browser argv; not a separate kernel-level sandbox certification' }
}

async function treeHash(directory) {
  const items = []
  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      const filename = path.join(current, name), info = await lstat(filename)
      if (info.isDirectory() && !info.isSymbolicLink()) await walk(filename)
      else if (info.isFile() && info.nlink === 1 && info.size <= 4 * 1024 * 1024) items.push([path.relative(directory, filename).split(path.sep).join('/'), digest(await readFile(filename))])
      else throw blocked('extension_fixture_invalid', 'Extension output contains an unexpected link or oversized file.')
    }
  }
  await walk(directory)
  return digest(JSON.stringify(items))
}

/** Copy only raw blobs from the exact official Git commit. A modified checkout,
 * untracked file or repository build script cannot become an extension input. */
export async function buildPinnedBrandedExtension({ source, destination }) {
  const emptyConfig = process.platform === 'win32' ? 'NUL' : os.devNull
  const env = { ...bridgeProcessEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = async (args, maxBuffer = 8 * 1024 * 1024) => (await exec('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${path.join(destination, 'disabled-hooks')}`, ...args], { cwd: source, env, timeout: 15000, maxBuffer, encoding: 'buffer' })).stdout
  assert.equal((await git(['rev-parse', '--verify', `${BRANDED_EXTENSION_REVISION}^{commit}`])).toString().trim(), BRANDED_EXTENSION_REVISION)
  const entries = (await git(['ls-tree', '-rz', BRANDED_EXTENSION_REVISION, '--', 'packages/extension'])).toString().split('\0').filter(Boolean)
  const raw = path.join(destination, 'source'), dist = path.join(destination, 'dist'), hashes = []
  if (!entries.length || entries.length > 300) throw blocked('extension_fixture_invalid', 'Official extension source tree is missing or unexpectedly large.')
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\tpackages\/extension\/(.+)$/.exec(entry)
    if (!match || match[3].includes('\\') || match[3].split('/').some(part => !part || part === '.' || part === '..')) throw blocked('extension_fixture_invalid', 'Official extension fixture contains unsupported file entries.')
    const bytes = await git(['cat-file', 'blob', match[2]], 4 * 1024 * 1024)
    const target = path.join(raw, match[3]); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' })
    hashes.push([match[3], digest(bytes)])
  }
  const manifest = JSON.parse(await readFile(path.join(raw, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, BRANDED_EXTENSION_VERSION)
  await mkdir(path.join(dist, 'lib/ui'), { recursive: true })
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest))
  await mkdir(path.join(dist, 'icons'))
  for (const file of await readdir(path.join(raw, 'icons'))) await writeFile(path.join(dist, 'icons', file), await readFile(path.join(raw, 'icons', file)))
  const nodePaths = [fileURLToPath(new URL('../node_modules', import.meta.url))]
  await build({ entryPoints: [path.join(raw, 'src/background.ts')], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(dist, 'lib/background.mjs'), nodePaths, logLevel: 'silent' })
  for (const name of ['connect', 'status']) {
    await build({ entryPoints: [path.join(raw, `src/ui/${name}.tsx`)], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(dist, `lib/ui/${name}.js`), nodePaths, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } })
    const styles = await readFile(path.join(dist, `lib/ui/${name}.css`), 'utf8').catch(() => '')
    await writeFile(path.join(dist, `lib/ui/${name}.css`), `${styles}\n${await readFile(path.join(raw, 'src/ui/connect.css'), 'utf8')}`)
    const html = (await readFile(path.join(raw, `src/ui/${name}.html`), 'utf8')).replaceAll('../../icons/', 'icons/').replace(/href="(?:connect|status)\.css"/, `href="lib/ui/${name}.css"`).replace(`src="${name}.tsx"`, `src="lib/ui/${name}.js"`)
    await writeFile(path.join(dist, `${name}.html`), html)
  }
  return { directory: dist, version: manifest.version, sourceRevision: BRANDED_EXTENSION_REVISION, sourceHash: digest(JSON.stringify(hashes.sort())), buildHash: await treeHash(dist) }
}

async function fileHash(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export async function runBrandedBridgeSmoke({ env = process.env } = {}) {
  const setup = brandedBridgePreflight({ env })
  const temp = await realpath(setup.temp)
  if (!privateChild(temp, await realpath(setup.runtimeRoot))) throw blocked('fixture_scope_required', 'Runtime path resolves outside RUNNER_TEMP.')
  const workspace = env.GITHUB_WORKSPACE ? await realpath(env.GITHUB_WORKSPACE) : null
  if (!sourceAllowed(temp, await realpath(setup.source), workspace)) throw blocked('fixture_scope_required', 'Extension source resolves outside the explicitly selected CI checkout.')
  const runtime = await browserBridgeStatus({ rootDir: setup.runtimeRoot })
  if (!runtime.installed) throw blocked('runtime_required', 'Install and verify the pinned MCP runtime in the dedicated fixture directory before running acceptance.')
  const fixture = await mkdtemp(path.join(temp, 'kkcode-branded-bridge-')), profile = path.join(fixture, 'profile')
  const priorRoot = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(fixture, 'kkcode-state')
  let context, controller, server, receipt, failure, diagnosticCapture, diagnosticTimer
  try {
    const extension = await buildPinnedBrandedExtension({ source: setup.source, destination: path.join(fixture, 'extension') })
    const childEnv = bridgeProcessEnvironment()
    if (process.platform === 'linux' && setup.report) {
      diagnosticTimer = setTimeout(() => {
        diagnosticCapture = (async () => {
          const raw = path.join(fixture, 'launch.xwd'), png = path.join(temp, `${setup.channel}-launch.png`)
          await exec('xwd', ['-root', '-silent', '-out', raw], { env: childEnv, timeout: 5000, maxBuffer: 65536 })
          await exec('convert', [raw, png], { env: childEnv, timeout: 5000, maxBuffer: 65536 })
        })().catch(() => {})
      }, 20000)
    }
    try { context = await chromium.launchPersistentContext(profile, brandedLaunchOptions({ channel: setup.channel, profile, env: childEnv })) }
    finally { clearTimeout(diagnosticTimer); await diagnosticCapture }
    const browser = context.browser()
    assert.ok(browser, 'persistent context must expose the real browser')
    const cdp = await browser.newBrowserCDPSession()
    const version = await cdp.send('Browser.getVersion'), { arguments: commandLine } = await cdp.send('Browser.getBrowserCommandLine')
    for (const candidate of context.pages()) if (!['about:blank', 'chrome://newtab/', 'edge://newtab/'].includes(candidate.url())) throw blocked('interactive_setup_required', 'Browser opened a first-run, licensing, sign-in or permission page; no setup prompt was accepted.')
    const page = context.pages()[0] || await context.newPage()
    const identity = verifyBrandedIdentity({ channel: setup.channel, platform: process.platform, commandLine, version, userAgent: await page.evaluate(() => navigator.userAgent), profile })
    identity.executable = await realpath(identity.executable)
    identity.executableSha256 = await fileHash(identity.executable)
    let installed
    try { installed = await cdp.send('Extensions.loadUnpacked', { path: extension.directory }) }
    catch { throw blocked('official_install_api_unavailable', 'Installed browser did not permit the official extension installation API; no fallback or security override was attempted.') }
    assert.equal(installed.id, BRANDED_EXTENSION_ID, 'the fixed official extension identity must match')
    const loaded = await cdp.send('Extensions.getExtensions')
    assert.ok(loaded.extensions.some(item => item.id === installed.id && item.version === BRANDED_EXTENSION_VERSION && item.enabled && path.resolve(item.path) === path.resolve(extension.directory)))
    let clicked = false
    server = http.createServer((request, response) => {
      if (request.url === '/submit') { clicked = true; response.end('ok'); return }
      response.setHeader('content-type', 'text/html')
      response.end(`<title>KK synthetic branded bridge fixture</title><style>html,body{background:${request.url === '/unshared' ? '#f1111d' : '#113311'}}</style><h1>${request.headers.cookie?.includes('fixture_login=local-only') ? 'Signed in fixture' : 'Not signed in'}</h1><button onclick="fetch('/submit').then(()=>this.textContent='Saved')">Save fixture</button><iframe title="PRIVATE EMBEDDED TITLE" src="data:text/html,${encodeURIComponent('<p>PRIVATE_EMBEDDED_FRAME_CANARY</p>')}"></iframe>`)
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    await context.route('**/*', route => {
      const target = new URL(route.request().url())
      return target.origin === origin || target.protocol === 'chrome-extension:' && target.hostname === installed.id ? route.continue() : route.abort()
    })
    await context.addCookies([{ name: 'fixture_login', value: 'local-only', url: origin }])
    await page.goto(origin)
    assert.equal(await page.frameLocator('iframe').locator('p').textContent(), 'PRIVATE_EMBEDDED_FRAME_CANARY')
    const excluded = await context.newPage(); await excluded.goto(`${origin}/unshared`); await page.bringToFront()
    let screenshotResultFormat
    controller = createBrowserBridgeController({ connect: async ({ outputDir }) => {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [runtime.cli, '--extension', '--browser', setup.channel, '--executable-path', identity.executable, '--user-data-dir', profile, '--profile-dir-name', 'Default', '--codegen', 'none', '--output-dir', outputDir],
        env: childEnv, cwd: outputDir, stderr: 'pipe' })
      transport.stderr.on('data', () => {})
      const client = new Client({ name: 'KK Code branded bridge acceptance', version: '1.0.5' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
      try { await client.connect(transport, { timeout: 15000 }) }
      catch (error) {
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
        throw error
      }
      return { call: async (name, args, signal) => {
        const result = await client.callTool({ name, arguments: args }, { timeout: 60000, signal })
        if (name === 'browser_take_screenshot') {
          const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n')
          screenshotResultFormat = { sections: [...text.matchAll(/^### ([^\n]+)/gm)].map(match => match[1]), pageUrlDeclared: /^- Page URL:/m.test(text), snapshotIncluded: /^### Snapshot$/m.test(text) }
        }
        return result
      }, close: () => client.close() }
    } })
    const sessionId = 'branded-bridge-fixture', ctx = { sessionId, config: {}, signal: AbortSignal.timeout(150000) }
    await authorizeBrowserBridge({ sessionId, origins: [origin], browser: setup.channel, allowInteraction: true, confirmed: true })
    await assert.rejects(controller.execute({ action: 'screenshot' }, ctx), /allow-screenshots/)
    await authorizeBrowserBridge({ sessionId, origins: [origin], browser: setup.channel, allowInteraction: true, allowScreenshots: true, confirmed: true })
    const approvalPage = waitForBrandedApproval(context, installed.id)
    const connecting = controller.execute({ action: 'snapshot' }, ctx)
    connecting.catch(() => {}); approvalPage.catch(() => {})
    const approval = await approvalPage
    // This is the extension's own permission UI in a synthetic profile. Never
    // click browser EULAs, sign-in dialogs or general OS permission prompts.
    await approval.locator('.tab-item').filter({ has: approval.locator('.tab-url', { hasText: `${origin}/` }) }).filter({ hasNotText: '/unshared' }).getByRole('button', { name: 'Allow & select' }).click({ timeout: 10000 })
    const snapshot = await connecting
    assert.match(snapshot.output, /Signed in fixture/)
    assert.doesNotMatch(snapshot.output, /\/unshared|PRIVATE EMBEDDED|PRIVATE_EMBEDDED_FRAME_CANARY/)
    assert.match(snapshot.output, /嵌入页面已省略/)
    const tabs = JSON.parse((await controller.execute({ action: 'tabs' }, ctx)).output)
    assert.equal(tabs.tabs.length, 1); assert.ok(!JSON.stringify(tabs).includes('/unshared'))
    const selected = await controller.execute({ action: 'select_tab', tab_list_id: tabs.tab_list_id, tab_id: tabs.tabs[0].id }, ctx)
    const selectedId = /snapshot_id: ([^\n]+)/.exec(selected.output)?.[1]
    const ref = /button "Save fixture" \[ref=(e\d+)\]/.exec(selected.output)?.[1]
    assert.ok(selectedId && ref)
    const clickResult = await controller.execute({ action: 'click', snapshot_id: selectedId, ref }, ctx)
    assert.equal(clicked, true)
    const screenshot = await controller.execute({ action: 'screenshot', snapshot_id: /snapshot_id: ([^\n]+)/.exec(clickResult.output)?.[1] }, ctx)
    const pixels = await sharp(Buffer.from(screenshot.content.find(item => item.type === 'image').data, 'base64')).removeAlpha().raw().toBuffer()
    assert.deepEqual([...pixels.subarray(0, 3)], [17, 51, 17])
    assert.equal(screenshot.metadata.bridge.imageOriginVerified, false)
    assert.deepEqual(screenshotResultFormat, { sections: ['Result'], pageUrlDeclared: false, snapshotIncluded: false })
    await revokeBrowserBridge({ sessionId })
    await assert.rejects(controller.execute({ action: 'snapshot' }, ctx), /尚未授权/)
    await controller.shutdown(); controller = null
    assert.equal(page.isClosed(), false); assert.equal(excluded.isClosed(), false)
    await cdp.send('Extensions.uninstall', { id: installed.id })
    assert.ok(!(await cdp.send('Extensions.getExtensions')).extensions.some(item => item.id === installed.id))
    receipt = { status: 'passed', platform: process.platform, architecture: process.arch, browser: identity, runtime: runtime.version,
      extension: { version: extension.version, id: installed.id, sourceRevision: extension.sourceRevision, sourceHash: extension.sourceHash, buildHash: extension.buildHash },
      setup: { officialCdpInstall: true, extraExtensionInstallationDebugging: true, scope: 'test preparation only; ephemeral GitHub-hosted runner and disposable profile', nativeStoreInstallationUiTested: false, additionalEulaAccepted: false, osPolicyModified: false },
      assertions: { approvalDialog: true, selectedTabOnly: true, syntheticCookie: true, nestedFrameContentOmitted: true, screenshotDefaultDenied: true, screenshotOptIn: true, unapprovedTabPixelsAbsent: true, revoked: true, existingTabsSurviveDisconnect: true, extensionUninstalled: true }, screenshotResultFormat,
      runner: { os: env.RUNNER_OS, imageOS: env.ImageOS || null, imageVersion: env.ImageVersion || null, runId: env.GITHUB_RUN_ID || null, runAttempt: env.GITHUB_RUN_ATTEMPT || null }, existingUserProfilesTouched: false }
  } catch (error) {
    failure = error
    if (context && setup.report) {
      const pages = context.pages().slice(0, 4)
      for (let index = 0; index < pages.length; index++) {
        await pages[index].screenshot({ path: path.join(temp, `${setup.channel}-failure-${index}.png`), timeout: 3000 }).catch(() => {})
      }
    }
  }
  finally {
    try { await controller?.shutdown() } catch (error) { failure ||= error }
    try { await context?.close() } catch (error) { failure ||= error }
    server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (priorRoot === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = priorRoot
    try { await rm(fixture, { recursive: true, force: true }); await assert.rejects(access(fixture), { code: 'ENOENT' }) } catch (error) { failure ||= error }
  }
  if (failure) throw failure
  return { ...receipt, cleanup: { browserClosed: true, fixtureProfileRemoved: true, fixtureServerClosed: true } }
}

async function main() {
  let receipt
  try { receipt = await runBrandedBridgeSmoke() }
  catch (error) { receipt = { status: error.blocked ? 'blocked' : 'failed', channel: process.env.KKCODE_BRIDGE_TEST_CHANNEL || null, code: error.code || 'branded_bridge_acceptance_failed', message: String(error.message).slice(0, 8000), additionalEulaAccepted: false }; process.exitCode = error.blocked ? 2 : 1 }
  if (process.env.KKCODE_BRIDGE_REPORT) {
    try {
      const setup = brandedBridgePreflight()
      const temp = await realpath(setup.temp), parent = await realpath(path.dirname(setup.report))
      if (parent !== temp && !privateChild(temp, parent)) throw blocked('report_scope_required', 'Report directory escapes RUNNER_TEMP.')
      await writeFile(setup.report, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 })
    } catch (error) { receipt.reportError = String(error.message).slice(0, 300); process.exitCode ||= 2 }
  }
  console.log(JSON.stringify(receipt))
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main()
