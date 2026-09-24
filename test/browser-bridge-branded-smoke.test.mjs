import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { brandedBridgePreflight, brandedLaunchOptions, verifyBrandedIdentity, parseBrandedVersionEvidence, readBrandedVersionEvidence, runBrandedBridgeSmoke, waitForBrandedApproval, createBrandedConnectionDiagnostics, probeBrandedProfileReuse, BRANDED_EXTENSION_ID } from '../scripts/browser-bridge-branded-smoke.mjs'

const runnerOs = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }
function environment(platform = process.platform) {
  const temp = path.join(os.tmpdir(), 'kk-branded-preflight-only')
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: runnerOs[platform],
    KKCODE_BRIDGE_ALLOW_EXTENSION_DEBUGGING: '1', KKCODE_BRIDGE_TEST_CHANNEL: 'chrome', RUNNER_TEMP: temp,
    KKCODE_BRIDGE_EXTENSION_SOURCE: path.join(temp, 'extension-source'), KKCODE_BRIDGE_TEST_RUNTIME: path.join(temp, 'runtime'),
    KKCODE_BRIDGE_REPORT: path.join(temp, 'receipt.json') }
}
const denied = code => error => error.blocked === true && error.code === code
const preflight = env => brandedBridgePreflight({ env, platform: process.platform, uid: 1000 })

test('approval waiting observes a later extension navigation and cleans every listener', async () => {
  const context = new EventEmitter(), unrelated = new EventEmitter(), page = new EventEmitter()
  context.pages = () => [unrelated]
  unrelated.url = () => 'chrome://welcome/'
  let url = 'about:blank'; page.url = () => url
  const pending = waitForBrandedApproval(context, BRANDED_EXTENSION_ID, 1000)
  context.emit('page', page)
  assert.equal(context.listenerCount('page'), 1)
  url = `chrome-extension://${BRANDED_EXTENSION_ID}/connect.html?fixture=1`; page.emit('framenavigated')
  assert.equal(await pending, page)
  assert.equal(context.listenerCount('page'), 0)
  assert.equal(page.listenerCount('framenavigated'), 0)
  assert.equal(unrelated.listenerCount('framenavigated'), 0)
})

test('approval waiting never accepts a different extension or a welcome page', async () => {
  const context = new EventEmitter(), page = new EventEmitter()
  context.pages = () => [page]; page.url = () => 'chrome-extension://other/connect.html'
  await assert.rejects(waitForBrandedApproval(context, BRANDED_EXTENSION_ID, 10), denied('extension_approval_unavailable'))
  assert.equal(context.listenerCount('page'), 0); assert.equal(page.listenerCount('framenavigated'), 0)
})

test('MCP failure aborts approval waiting immediately and releases listeners rather than becoming a page timeout', async () => {
  const context = new EventEmitter(), page = new EventEmitter(), controller = new AbortController()
  context.pages = () => [page]; page.url = () => 'about:blank'
  const waiting = waitForBrandedApproval(context, BRANDED_EXTENSION_ID, 30000, controller.signal)
  const failure = Object.assign(new Error('controlled fixture failure'), { code: 'mcp_initialization_failed' })
  controller.abort(failure)
  await assert.rejects(waiting, error => error === failure)
  assert.equal(context.listenerCount('page'), 0); assert.equal(page.listenerCount('framenavigated'), 0)
})

test('MCP diagnostics record bounded phases and error categories without raw credentials, URL queries or profile paths', () => {
  const diagnostics = createBrandedConnectionDiagnostics()
  diagnostics.phase('mcp_start')
  diagnostics.stderr(Buffer.from('CDP relay ser'))
  diagnostics.stderr(Buffer.from('ver started, extension endpoint: ws://127.0.0.1:4567/extension/FIXTURE_RELAY_SECRET?token=FIXTURE_TOKEN\nEstablishing extension connection\nWaiting for incoming extension connection'))
  assert.equal(diagnostics.failure('mcp_initialize', new Error('unknown option --private-option=FIXTURE_PASSWORD /private/profile')).reason, 'unsupported_cli_option')
  const receipt = diagnostics.snapshot()
  assert.equal(receipt.phase, 'mcp_start'); assert.equal(receipt.relayStarted, true)
  assert.equal(receipt.connectPageRequested, true); assert.equal(receipt.waitingForExtension, true)
  assert.match(receipt.failures[0].fingerprint, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(receipt), /FIXTURE|private-option|\/private|ws:\/\//)
  diagnostics.stderr(Buffer.alloc(128 * 1024 + 1, 65))
  assert.equal(diagnostics.snapshot().stderrTruncated, true)
})

test('profile reuse probe uses the same exact Default profile and closes only its synthetic tab', async () => {
  const context = new EventEmitter(), existing = new EventEmitter()
  context.pages = () => [existing]; existing.url = () => 'http://127.0.0.1:1234/unshared'
  let closed = false, called = 0
  const result = await probeBrandedProfileReuse({ context, executable: '/fixture/branded-browser', profile: '/fixture/profile', origin: 'http://127.0.0.1:1234', env: {},
    launch: async (binary, args, options) => {
      called++; assert.equal(binary, '/fixture/branded-browser')
      assert.deepEqual(args.slice(0, 2), ['--user-data-dir=/fixture/profile', '--profile-directory=Default'])
      assert.match(args[2], /^http:\/\/127\.0\.0\.1:1234\/launch-probe-/)
      assert.equal(options.windowsHide, true)
      assert.equal(options.detached, true, 'match the pinned upstream MCP browser launch process semantics')
      const page = new EventEmitter(); let url = 'about:blank'
      page.url = () => url; page.close = async () => { closed = true }; page.isClosed = () => closed
      context.emit('page', page); url = args[2]; page.emit('framenavigated')
      return { stdout: '', stderr: '' }
    } })
  assert.equal(called, 1); assert.equal(closed, true); assert.equal(result.verified, true)
  assert.equal(context.listenerCount('page'), 0); assert.equal(existing.listenerCount('framenavigated'), 0)
})

test('profile reuse failure is surfaced without stderr data and cancels its pending page observer', async () => {
  const context = new EventEmitter(); context.pages = () => []
  await assert.rejects(probeBrandedProfileReuse({ context, executable: '/fixture/browser', profile: '/fixture/profile', origin: 'http://127.0.0.1:1234', env: {},
    launch: async () => { throw new Error('EACCES token=FIXTURE_PRIVATE_TOKEN /private/secret-profile') } }), error => {
    assert.equal(error.code, 'browser_profile_reuse_failed')
    assert.equal(error.diagnosticFailure.reason, 'permission_denied')
    assert.doesNotMatch(JSON.stringify(error), /FIXTURE_PRIVATE|secret-profile/)
    return true
  })
  assert.equal(context.listenerCount('page'), 0)
})

test('branded harness refuses non-CI and self-hosted runs, missing opt-in and Linux root', () => {
  for (const change of [{ GITHUB_ACTIONS: undefined }, { GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }]) assert.throws(() => preflight({ ...environment(), ...change }), denied('github_hosted_required'))
  for (const consent of [undefined, '0', 'true']) assert.throws(() => preflight({ ...environment(), KKCODE_BRIDGE_ALLOW_EXTENSION_DEBUGGING: consent }), denied('extension_debug_opt_in_required'))
  assert.throws(() => brandedBridgePreflight({ env: environment('linux'), platform: 'linux', uid: 0 }), denied('non_root_required'))
  assert.throws(() => brandedBridgePreflight({ env: environment('linux'), platform: 'darwin', uid: 501 }), denied('runner_os_mismatch'))
  assert.throws(() => brandedBridgePreflight({ env: environment('linux'), platform: 'freebsd', uid: 1000 }), denied('runner_os_mismatch'))
})

test('branded harness only admits bounded absolute runner fixtures, not a personal profile or sibling path', () => {
  const env = environment(), outside = path.join(path.dirname(env.RUNNER_TEMP), `${path.basename(env.RUNNER_TEMP)}-outside`)
  const valid = preflight(env)
  assert.equal(valid.runtimeRoot, env.KKCODE_BRIDGE_TEST_RUNTIME)
  for (const key of ['RUNNER_TEMP', 'KKCODE_BRIDGE_EXTENSION_SOURCE', 'KKCODE_BRIDGE_TEST_RUNTIME']) {
    assert.throws(() => preflight({ ...env, [key]: 'relative/path' }), denied('fixture_paths_required'))
  }
  for (const key of ['KKCODE_BRIDGE_EXTENSION_SOURCE', 'KKCODE_BRIDGE_TEST_RUNTIME', 'KKCODE_BRIDGE_REPORT']) {
    for (const target of [env.RUNNER_TEMP, outside, path.join(env.RUNNER_TEMP, '..', 'outside')]) {
      assert.throws(() => preflight({ ...env, [key]: target }), denied('fixture_scope_required'))
    }
  }
  const workspace = path.join(os.tmpdir(), 'kk-branded-workspace')
  assert.doesNotThrow(() => preflight({ ...env, GITHUB_WORKSPACE: workspace, KKCODE_BRIDGE_EXTENSION_SOURCE: path.join(workspace, 'test-results/bridge-extension-source') }))
  assert.throws(() => preflight({ ...env, GITHUB_WORKSPACE: workspace, KKCODE_BRIDGE_EXTENSION_SOURCE: path.join(workspace, 'other-source') }), denied('fixture_scope_required'))
})

test('branded harness cannot substitute Chromium, CfT or an unknown channel in preflight', () => {
  for (const channel of ['chromium', 'chrome-for-testing', 'chrome-beta', 'firefox', '', undefined]) assert.throws(() => preflight({ ...environment(), KKCODE_BRIDGE_TEST_CHANNEL: channel }), denied('branded_channel_required'))
  assert.equal(preflight({ ...environment(), KKCODE_BRIDGE_TEST_CHANNEL: 'msedge' }).channel, 'msedge')
})

const identities = [
  { platform: 'linux', channel: 'chrome', binary: '/opt/google/chrome/chrome', profile: '/tmp/runner/profile' },
  { platform: 'linux', channel: 'msedge', binary: '/opt/microsoft/msedge/msedge', profile: '/tmp/runner/profile' },
  { platform: 'darwin', channel: 'chrome', binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', profile: '/private/tmp/runner/profile' },
  { platform: 'darwin', channel: 'msedge', binary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', profile: '/private/tmp/runner/profile' },
  { platform: 'win32', channel: 'chrome', binary: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile: 'C:\\runner\\temp\\profile' },
  { platform: 'win32', channel: 'msedge', binary: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', profile: 'C:\\runner\\temp\\profile' },
]
function identity(fixture) {
  const launch = brandedLaunchOptions({ channel: fixture.channel, profile: fixture.profile, env: { PATH: '/fixture/bin' } })
  return { channel: fixture.channel, platform: fixture.platform, profile: fixture.profile, commandLine: [fixture.binary, ...launch.args],
    version: { product: 'Chrome/140.0.0.0', revision: 'synthetic-version-revision', jsVersion: 'synthetic-js-version' },
    userAgent: `Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36${fixture.channel === 'msedge' ? ' Edg/140.0.0.0' : ''}` }
}

for (const fixture of identities) test(`branded identity accepts compliant ${fixture.channel}/${fixture.platform} argv and UA without claiming real platform execution`, () => {
  const options = brandedLaunchOptions({ channel: fixture.channel, profile: fixture.profile, env: {} })
  assert.equal(options.headless, false); assert.equal(options.chromiumSandbox, true); assert.equal(options.ignoreDefaultArgs, true)
  assert.equal(options.args.includes('--enable-automation'), false, 'this flag makes Chromium drop second-launch URLs, including the MCP connect page')
  const result = verifyBrandedIdentity(identity(fixture))
  assert.equal(result.channel, fixture.channel); assert.equal(result.freshProfile, true); assert.equal(result.pipeOnly, true)
  assert.match(result.sandboxEvidence, /not a separate kernel-level sandbox certification/)
})

for (const fixture of identities) test(`native version-page argv parsing preserves ${fixture.channel}/${fixture.platform} binary and profile identity`, () => {
  const input = identity(fixture)
  const commandLine = fixture.platform === 'win32'
    ? `"${fixture.binary}" ${input.commandLine.slice(1).join(' ')}` : ` ${input.commandLine.join(' ')}`
  const parsed = parseBrandedVersionEvidence({ ...fixture, executable: fixture.binary, commandLine, url: fixture.channel === 'msedge' ? 'edge://version/' : 'chrome://version/',
    profilePath: (fixture.platform === 'win32' ? path.win32 : path.posix).join(fixture.profile, 'Default') })
  assert.deepEqual(parsed, input.commandLine)
  assert.equal(verifyBrandedIdentity({ ...input, commandLine: parsed }).pipeOnly, true)
})

test('native version parsing handles Windows quoted values/backslashes and POSIX executable/profile spaces without shell guessing', () => {
  const windows = { channel: 'chrome', platform: 'win32', url: 'chrome://version/', executable: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    profile: String.raw`C:\runner temp\profile`, profilePath: String.raw`C:\runner temp\profile\Default` }
  const parsed = parseBrandedVersionEvidence({ ...windows,
    commandLine: String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\runner temp\profile" --profile-directory=Default --remote-debugging-pipe --enable-unsafe-extension-debugging --fixture="a\\\"b" about:blank` })
  assert.equal(parsed[0], windows.executable)
  assert.equal(parsed[1], `--user-data-dir=${windows.profile}`)
  assert.ok(parsed.includes(String.raw`--fixture=a\"b`))
  const doubled = parseBrandedVersionEvidence({ ...windows,
    commandLine: String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\runner temp\profile" --fixture="a""b"` })
  assert.ok(doubled.includes('--fixture=a"b'), 'a doubled quote inside a quoted Windows argument is literal')
  const mac = { ...identities[2], profile: '/private/tmp/runner temp/profile' }, input = identity(mac)
  assert.deepEqual(parseBrandedVersionEvidence({ ...mac, executable: mac.binary, profilePath: mac.profile + '/Default', commandLine: ' ' + input.commandLine.join(' '), url: 'chrome://version/' }), input.commandLine)
})

test('native version evidence refuses web-page lookalikes, changed profiles, unbalanced quotes and ambiguous POSIX input', () => {
  const fixture = identities[2], input = identity(fixture)
  const fields = { ...fixture, executable: fixture.binary, profilePath: fixture.profile + '/Default', commandLine: input.commandLine.join(' '), url: 'chrome://version/' }
  for (const url of ['https://example.invalid/chrome://version/', 'chrome://version/?fake=1', 'chrome://version/#fake', 'edge://version/', 'chrome://settings/']) {
    assert.throws(() => parseBrandedVersionEvidence({ ...fields, url }), denied('browser_version_source_invalid'))
  }
  assert.throws(() => parseBrandedVersionEvidence({ ...fields, profilePath: '/private/tmp/other/Default' }), denied('profile_scope_mismatch'))
  assert.throws(() => parseBrandedVersionEvidence({ ...fields, commandLine: fields.commandLine + ' --unknown="two words"' }), denied('browser_argv_ambiguous'))
  assert.throws(() => parseBrandedVersionEvidence({ ...fields, commandLine: fields.commandLine.replace(fixture.binary, '/Applications/Unverified.app/Browser') }), denied('browser_argv_ambiguous'))
  const win = identities[4]
  assert.throws(() => parseBrandedVersionEvidence({ ...win, executable: win.binary, url: 'chrome://version/', profilePath: path.win32.join(win.profile, 'Default'), commandLine: `"${win.binary} --user-data-dir=${win.profile}` }), denied('browser_argv_ambiguous'))
})

test('the version reader rejects a redirect before evaluating page content and only navigates the owned native page', async () => {
  let evaluated = false
  const redirected = { goto: async () => {}, url: () => 'https://fixture.invalid/version', evaluate: async () => { evaluated = true } }
  await assert.rejects(readBrandedVersionEvidence(redirected, { channel: 'chrome', profile: '/fixture' }), denied('browser_version_source_invalid'))
  assert.equal(evaluated, false)
  const fixture = identities[2], input = identity(fixture), navigations = []
  let url = 'about:blank'
  const page = { goto: async next => { navigations.push(next); url = next }, url: () => url, waitForFunction: async () => {},
    evaluate: async () => ({ url, executable: fixture.binary, commandLine: input.commandLine.join(' '), profilePath: fixture.profile + '/Default' }) }
  assert.deepEqual(await readBrandedVersionEvidence(page, { channel: 'chrome', platform: 'darwin', profile: fixture.profile }), input.commandLine)
  assert.deepEqual(navigations, ['chrome://version/', 'about:blank'])
})

test('branded identity rejects disabled sandbox/security, debugging TCP, extension flags and a replaced profile', () => {
  const input = identity(identities[0])
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox', '--disable-gpu-sandbox', '--single-process', '--disable-web-security', '--remote-debugging-port=9222', '--remote-allow-origins=*', '--ignore-certificate-errors', '--disable-features=SafeBrowsing', '--load-extension=/other', '--disable-extensions-except=/other']) {
    assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: [...input.commandLine, flag] }), denied('unsafe_browser_launch'))
  }
  for (const flag of ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging']) assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: input.commandLine.filter(arg => arg !== flag) }), denied('installation_debugging_unavailable'))
  assert.throws(() => verifyBrandedIdentity({ ...input, profile: '/tmp/unrelated/profile' }), denied('profile_scope_mismatch'))
  assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: [...input.commandLine, '--user-data-dir=/tmp/another'] }), denied('profile_scope_mismatch'))
  assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: input.commandLine.filter(arg => arg !== '--profile-directory=Default') }), denied('profile_scope_mismatch'))
  assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: [...input.commandLine, '--profile-directory=Profile 1'] }), denied('profile_scope_mismatch'))
  assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: [...input.commandLine, '--enable-automation'] }), denied('browser_automation_reuse_incompatible'))
})

test('branded identity rejects Chromium/CfT paths, headless UA and a mismatched browser brand', () => {
  const input = identity(identities[0])
  for (const binary of ['/opt/chromium/chrome', '/tmp/chrome-for-testing/chrome', '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', '/tmp/chromium-123/chrome-linux/chrome', '/opt/microsoft/msedge/msedge']) {
    assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: [binary, ...input.commandLine.slice(1)] }), denied('browser_brand_mismatch'))
  }
  for (const userAgent of ['Mozilla/5.0 HeadlessChrome/140.0.0.0', 'Mozilla/5.0 Firefox/140.0', `${input.userAgent} Edg/140.0.0.0`]) assert.throws(() => verifyBrandedIdentity({ ...input, userAgent }), denied('browser_brand_mismatch'))
  assert.throws(() => verifyBrandedIdentity({ ...identity(identities[1]), userAgent: input.userAgent }), denied('browser_brand_mismatch'))
})

test('calling the real harness outside CI stops before browser launch', async () => {
  const original = chromium.launchPersistentContext
  let launches = 0
  chromium.launchPersistentContext = async () => { launches++; throw new Error('the preflight must prevent reaching browser launch') }
  try { await assert.rejects(runBrandedBridgeSmoke({ env: {} }), denied('github_hosted_required')) }
  finally { chromium.launchPersistentContext = original }
  assert.equal(launches, 0)
})

test('non-CI script entry reports blocked with exit 2 and never reports a passed receipt', async () => {
  const env = { ...process.env, GITHUB_ACTIONS: 'false' }
  delete env.KKCODE_BRIDGE_REPORT
  try {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/browser-bridge-branded-smoke.mjs', import.meta.url))], { env, timeout: 15000 })
    assert.fail('non-CI invocation must not succeed')
  } catch (error) {
    assert.equal(error.code, 2)
    const receipt = JSON.parse(error.stdout)
    assert.equal(receipt.status, 'blocked'); assert.equal(receipt.code, 'github_hosted_required')
    assert.equal(receipt.additionalEulaAccepted, false); assert.equal(receipt.assertions, undefined)
  }
})
