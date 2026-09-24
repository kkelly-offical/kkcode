import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { strictBrowserPreflight, verifyChromiumEvidence, runStrictBrowserSmoke } from '../scripts/browser-strict-smoke.mjs'

const image = `sha256:${'a'.repeat(64)}`
const validEvidence = () => ({ launchOptions: { chromiumSandbox: true, env: { PATH: '/usr/bin' } }, commandLine: ['/fixture/chrome', '--headless'], environment: 'PATH=/usr/bin\0HOME=/fixture\0', secret: 'synthetic-private-probe',
  renderers: [{ status: 'Name:\tchrome\nNoNewPrivs:\t1\nSeccomp:\t2\nCapEff:\t0000000000000000\n', commandLine: ['/fixture/chrome', '--type=renderer'] }] })

test('strict Browser acceptance refuses root, unsupported OS and mutable image tags before launch', () => {
  assert.throws(() => strictBrowserPreflight({ platform: 'linux', uid: 0, image }), error => error.blocked && error.code === 'non_root_required')
  assert.throws(() => strictBrowserPreflight({ platform: 'darwin', uid: 501, image }), error => error.blocked && error.code === 'linux_required')
  for (const invalid of ['node:22', 'sha256:bad', '', null]) assert.throws(() => strictBrowserPreflight({ platform: 'linux', uid: 1000, image: invalid }), error => error.blocked && error.code === 'pinned_image_required')
  assert.deepEqual(strictBrowserPreflight({ platform: 'linux', uid: 1000, image }), { uid: 1000, image })
})

test('strict Browser evidence requires live renderer sandbox status, not merely a launch flag', () => {
  assert.equal(verifyChromiumEvidence(validEvidence()).rendererSeccomp, 2)
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox', '--single-process']) {
    const evidence = validEvidence(); evidence.commandLine.push(flag)
    assert.throws(() => verifyChromiumEvidence(evidence))
    const child = validEvidence(); child.renderers[0].commandLine.push(flag)
    assert.throws(() => verifyChromiumEvidence(child))
  }
  for (const replacement of [{ from: 'NoNewPrivs:\t1', to: 'NoNewPrivs:\t0' }, { from: 'Seccomp:\t2', to: 'Seccomp:\t0' }, { from: 'CapEff:\t0000000000000000', to: 'CapEff:\t0000000000000001' }]) {
    const evidence = validEvidence(); evidence.renderers[0].status = evidence.renderers[0].status.replace(replacement.from, replacement.to)
    assert.throws(() => verifyChromiumEvidence(evidence))
  }
  const absent = validEvidence(); absent.renderers = []
  assert.throws(() => verifyChromiumEvidence(absent))
})

test('strict Browser evidence rejects private environment inheritance and disabled launch sandbox', () => {
  const launch = validEvidence(); launch.launchOptions.chromiumSandbox = false
  assert.throws(() => verifyChromiumEvidence(launch))
  const source = validEvidence(); source.launchOptions.env.KKCODE_STRICT_BROWSER_PRIVATE_CANARY = source.secret
  assert.throws(() => verifyChromiumEvidence(source))
  const actual = validEvidence(); actual.environment += `KKCODE_STRICT_BROWSER_PRIVATE_CANARY=${actual.secret}\0`
  assert.throws(() => verifyChromiumEvidence(actual))
})

test('strict Browser root CLI reports blocked as nonzero, never silently skips or passes', { skip: process.platform !== 'linux' || process.getuid?.() !== 0 }, async () => {
  try {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/browser-strict-smoke.mjs', import.meta.url))], { env: { ...process.env, KKCODE_STRICT_TEST_IMAGE: image } })
    assert.fail('root must not pass strict Browser acceptance')
  } catch (error) {
    assert.equal(error.code, 2)
    const result = JSON.parse(error.stdout)
    assert.equal(result.status, 'blocked'); assert.equal(result.code, 'non_root_required')
    assert.equal(result.browser, undefined)
  }
})

test('real non-root sandboxed Browser opens, snapshots, clicks, screenshots and cancels through fixed-image strict backend', {
  skip: process.env.KKCODE_REQUIRE_STRICT_BROWSER !== '1', timeout: 90000,
}, async () => {
  // When enabled, missing Docker/Chromium, root, or a denied sandbox FAILS this
  // test. CI must never reinterpret blocked exit 2 as acceptance success.
  const result = await runStrictBrowserSmoke()
  assert.equal(result.status, 'passed')
  assert.equal(result.browser.chromiumSandbox, true)
  assert.equal(result.cancellation.processesStopped, true)
})
