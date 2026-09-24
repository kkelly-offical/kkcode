import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { brandedBridgePreflight, brandedLaunchOptions, verifyBrandedIdentity, runBrandedBridgeSmoke } from '../scripts/browser-bridge-branded-smoke.mjs'

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
  const result = verifyBrandedIdentity(identity(fixture))
  assert.equal(result.channel, fixture.channel); assert.equal(result.freshProfile, true); assert.equal(result.pipeOnly, true)
  assert.match(result.sandboxEvidence, /not a separate kernel-level sandbox certification/)
})

test('branded identity rejects disabled sandbox/security, debugging TCP, extension flags and a replaced profile', () => {
  const input = identity(identities[0])
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox', '--disable-gpu-sandbox', '--single-process', '--disable-web-security', '--remote-debugging-port=9222', '--remote-allow-origins=*', '--ignore-certificate-errors', '--disable-features=SafeBrowsing', '--load-extension=/other', '--disable-extensions-except=/other']) {
    assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: [...input.commandLine, flag] }), denied('unsafe_browser_launch'))
  }
  for (const flag of ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging']) assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: input.commandLine.filter(arg => arg !== flag) }), denied('installation_debugging_unavailable'))
  assert.throws(() => verifyBrandedIdentity({ ...input, profile: '/tmp/unrelated/profile' }), denied('profile_scope_mismatch'))
  assert.throws(() => verifyBrandedIdentity({ ...input, commandLine: [...input.commandLine, '--user-data-dir=/tmp/another'] }), denied('profile_scope_mismatch'))
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
