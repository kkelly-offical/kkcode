import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile, lstat, unlink, link, symlink, access, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { prepareBrandedFirstRun, initializeBrandedFirstRun } from '../scripts/browser-bridge-first-run.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-first-run-unit-')), cleanup = createFixtureCleanup(t)
  cleanup.remove(root)
  const temp = path.join(root, 'runner-temp'), parent = path.join(temp, 'fixture')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  // Synthetic environment for filesystem-only tests; no browser/OS UI is run.
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: temp, KKCODE_BRIDGE_ALLOW_FIRST_RUN_SETUP: '1' }
  return { root, temp, parent, env }
}

test('first-run setup requires every explicit GitHub-hosted gate before creating any file', async t => {
  const f = await fixture(t)
  for (const override of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: undefined }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_ENVIRONMENT: undefined }, { KKCODE_BRIDGE_ALLOW_FIRST_RUN_SETUP: undefined }, { KKCODE_BRIDGE_ALLOW_FIRST_RUN_SETUP: 'true' }]) {
    await assert.rejects(prepareBrandedFirstRun({ env: { ...f.env, ...override }, channel: 'chrome', parent: f.parent }), { code: 'first_run_consent_required' })
    assert.deepEqual(await readdir(f.parent), [])
  }
  await assert.rejects(prepareBrandedFirstRun({ env: f.env, channel: 'chromium', parent: f.parent }), { code: 'first_run_channel_invalid' })
  await assert.rejects(prepareBrandedFirstRun({ env: { ...f.env, RUNNER_TEMP: 'relative-temp' }, channel: 'chrome', parent: f.parent }), { code: 'first_run_scope_invalid' })
  assert.deepEqual(await readdir(f.parent), [])
})

for (const channel of ['chrome', 'msedge']) test(`new ${channel} CI profile records explicit opt-outs without claiming native UI consent`, async t => {
  const f = await fixture(t), prepared = await prepareBrandedFirstRun({ ...f, channel })
  assert.match(path.basename(prepared.profile), /^kkcode-first-run-/)
  assert.equal(path.dirname(prepared.profile), await realpath(f.parent))
  assert.equal(await readFile(path.join(prepared.profile, 'First Run'), 'utf8'), '')
  const local = JSON.parse(await readFile(path.join(prepared.profile, 'Local State'), 'utf8'))
  const preferences = JSON.parse(await readFile(path.join(prepared.profile, 'Default', 'Preferences'), 'utf8'))
  assert.equal(local.user_experience_metrics.reporting_enabled, false)
  assert.equal(preferences.signin.allowed, false)
  assert.equal(preferences.signin.allowed_on_next_startup, false)
  for (const key of ['import_autofill_form_data', 'import_bookmarks', 'import_history', 'import_home_page', 'import_saved_passwords', 'import_search_engine']) assert.equal(preferences[key], false)
  assert.deepEqual(prepared.args, ['--no-first-run', '--no-default-browser-check', '--disable-sync'])
  assert.equal(prepared.args.some(value => /metrics-recording|sandbox|force-first|default-browser=|policy|remote-debugging/.test(value)), false)
  assert.equal(prepared.receipt.method, 'explicit-new-private-profile-initialization')
  assert.equal(prepared.receipt.explicitUserConsent, true)
  for (const key of ['nativeFirstRunUiTested', 'nativeTermsUiClicked', 'browserDefaultChanged', 'accountLoginPerformed', 'accountSyncEnabled', 'userDataImported', 'optionalDiagnosticConsentGranted', 'metricsRecordingFlagEnabled', 'vendorSpecificDiagnosticUiObserved', 'existingUserProfilesTouched', 'osPolicyModified', 'installationDirectoryModified', 'sandboxDisabled']) assert.equal(prepared.receipt[key], false, key)
  if (process.platform !== 'win32') {
    assert.equal((await lstat(prepared.profile)).mode & 0o777, 0o700)
    for (const relative of ['First Run', 'Local State', 'Default/Preferences']) assert.equal((await lstat(path.join(prepared.profile, relative))).mode & 0o777, 0o600)
  }
  const checked = await initializeBrandedFirstRun({ env: f.env, channel, profile: prepared.profile })
  assert.equal(checked.phase, 'postlaunch')
  assert.equal(checked.nativeFirstRunUiTested, false, 'configuration readback is not evidence of a UI interaction')
  const next = await prepareBrandedFirstRun({ ...f, channel })
  assert.notEqual(next.profile, prepared.profile)
})

test('outside parents and home/root targets are rejected rather than adopting a personal profile', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside')
  await mkdir(outside)
  await assert.rejects(prepareBrandedFirstRun({ env: f.env, channel: 'chrome', parent: outside }), { code: 'first_run_scope_invalid' })
  for (const broad of [os.homedir(), path.parse(f.root).root]) await assert.rejects(prepareBrandedFirstRun({ env: { ...f.env, RUNNER_TEMP: broad }, channel: 'chrome', parent: broad }), { code: 'first_run_scope_invalid' })
  assert.deepEqual(await readdir(outside), [])
  await assert.rejects(initializeBrandedFirstRun({ env: f.env, channel: 'chrome', profile: outside }), { code: 'first_run_profile_invalid' })
})

test('canonical parent aliases remain inside the runner scope and cannot escape it', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'), alias = path.join(f.temp, 'alias')
  await mkdir(outside)
  await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareBrandedFirstRun({ env: f.env, channel: 'msedge', parent: alias }), { code: 'first_run_scope_invalid' })
  assert.deepEqual(await readdir(outside), [])
  await unlink(alias)
  await symlink(f.parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const prepared = await prepareBrandedFirstRun({ env: f.env, channel: 'msedge', parent: alias })
  assert.equal(path.dirname(prepared.profile), await realpath(f.parent))
})

test('postlaunch evidence fails closed if an opt-out changes or a file becomes invalid', async t => {
  const f = await fixture(t), prepared = await prepareBrandedFirstRun({ ...f, channel: 'chrome' })
  const file = path.join(prepared.profile, 'Local State'), original = await readFile(file, 'utf8')
  await writeFile(file, JSON.stringify({ user_experience_metrics: { reporting_enabled: true } }))
  await assert.rejects(initializeBrandedFirstRun({ env: f.env, channel: 'chrome', profile: prepared.profile }), { code: 'first_run_privacy_changed' })
  await writeFile(file, '{synthetic-private-value')
  await assert.rejects(initializeBrandedFirstRun({ env: f.env, channel: 'chrome', profile: prepared.profile }), error => error.code === 'first_run_profile_invalid' && !error.message.includes('synthetic-private-value'))
  await writeFile(file, original)
  await assert.rejects(initializeBrandedFirstRun({ env: f.env, channel: 'msedge', profile: prepared.profile }), { code: 'first_run_profile_invalid' })
  await assert.rejects(initializeBrandedFirstRun({ env: { ...f.env, KKCODE_BRIDGE_ALLOW_FIRST_RUN_SETUP: '0' }, channel: 'chrome', profile: prepared.profile }), { code: 'first_run_consent_required' })
})

test('initialization readback rejects hardlinked files and never modifies their other pathname', async t => {
  const f = await fixture(t), prepared = await prepareBrandedFirstRun({ ...f, channel: 'chrome' })
  const file = path.join(prepared.profile, 'First Run'), outside = path.join(f.root, 'preserved')
  await writeFile(outside, '', { mode: 0o600 }); await unlink(file); await link(outside, file)
  await assert.rejects(initializeBrandedFirstRun({ env: f.env, channel: 'chrome', profile: prepared.profile }), { code: 'first_run_profile_invalid' })
  await access(outside)
  assert.equal(await readFile(outside, 'utf8'), '')
})
