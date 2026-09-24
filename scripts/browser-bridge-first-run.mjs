// Explicit GitHub-hosted acceptance setup only. Never a product launcher or an
// assertion that a native licensing/consent dialog was actually exercised.
import { constants } from 'node:fs'
import { lstat, realpath, mkdir, mkdtemp, open } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const createdProfiles = new Map()
const FLAGS = Object.freeze(['--no-first-run', '--no-default-browser-check', '--disable-sync'])
const SOURCE = Object.freeze({
  firstRun: 'https://github.com/chromium/chromium/blob/main/chrome/browser/first_run/first_run.cc',
  switches: 'https://github.com/chromium/chromium/blob/main/chrome/common/chrome_switches.h',
  metrics: 'https://github.com/chromium/chromium/blob/main/components/metrics/metrics_pref_names.h',
  signin: 'https://github.com/chromium/chromium/blob/main/components/signin/public/base/signin_pref_names.cc',
  imports: 'https://github.com/chromium/chromium/blob/main/chrome/common/pref_names.h'
})
const LOCAL_STATE = Object.freeze({ user_experience_metrics: { reporting_enabled: false } })
const PREFERENCES = Object.freeze({
  signin: { allowed: false, allowed_on_next_startup: false },
  import_autofill_form_data: false, import_bookmarks: false, import_history: false,
  import_home_page: false, import_saved_passwords: false, import_search_engine: false
})
const fail = (code, message) => { throw Object.assign(new Error(message), { code, blocked: true }) }
const contained = (root, value) => { const relative = path.relative(root, value); return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) }
function gate(env, channel) {
  if (env?.GITHUB_ACTIONS !== 'true' || env?.RUNNER_ENVIRONMENT !== 'github-hosted' || env?.KKCODE_BRIDGE_ALLOW_FIRST_RUN_SETUP !== '1') fail('first_run_consent_required', 'First-run initialization requires explicit consent on a temporary GitHub-hosted runner.')
  if (!['chrome', 'msedge'].includes(channel)) fail('first_run_channel_invalid', 'Only the installed official Chrome and Edge acceptance channels are in scope.')
  if (typeof env.RUNNER_TEMP !== 'string' || !path.isAbsolute(env.RUNNER_TEMP) || !env.RUNNER_TEMP.trim()) fail('first_run_scope_invalid', 'The CI runner must provide an absolute temporary directory.')
}
function ordinary(info, directory = false) {
  return !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1)
    && (!process.getuid || info.uid === process.getuid()) && (process.platform === 'win32' || (info.mode & 0o077) === 0)
}
async function privateDirectory(directory) {
  const info = await lstat(directory)
  if (!ordinary(info, true)) fail('first_run_profile_invalid', 'Initialization only uses an owned private ordinary directory.')
  return info
}
async function writeNew(file, value) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
  try { await handle.writeFile(value); await handle.sync() } finally { await handle.close() }
}
async function readPrivate(file) {
  const before = await lstat(file)
  if (!ordinary(before) || before.size > 1024 * 1024) fail('first_run_profile_invalid', 'The initialization file is not a bounded private ordinary file.')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const opened = await handle.stat()
    if (!ordinary(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('first_run_profile_invalid', 'The initialization file changed before verification.')
    const data = Buffer.alloc(opened.size + 1)
    let size = 0
    for (;;) {
      const read = await handle.read(data, size, data.length - size, size)
      size += read.bytesRead
      if (!read.bytesRead || size === data.length) break
    }
    const after = await handle.stat(), named = await lstat(file)
    if (size !== opened.size || !ordinary(after) || !ordinary(named) || after.ino !== named.ino || after.dev !== named.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail('first_run_profile_invalid', 'The initialization file changed during verification.')
    return data.subarray(0, size).toString('utf8')
  } finally { await handle.close() }
}
async function readJson(file) {
  const text = await readPrivate(file)
  try { return JSON.parse(text) } catch { fail('first_run_profile_invalid', 'The initialization preferences are not valid JSON; contents are not included in diagnostics.') }
}
function receipt(channel, phase) {
  return {
    schema: 'kk.browser-first-run-setup.v1', channel, phase, method: 'explicit-new-private-profile-initialization',
    authorizedScope: 'temporary GitHub-hosted CI profile only',
    explicitUserConsent: true, firstRunSentinelCreated: true, nativeFirstRunUiTested: false, nativeTermsUiClicked: false,
    browserDefaultChanged: false, accountLoginPerformed: false, accountSyncEnabled: false, userDataImported: false,
    optionalDiagnosticConsentGranted: false, metricsRecordingFlagEnabled: false,
    writtenChromiumMetricsConsent: false, vendorSpecificDiagnosticUiObserved: false,
    privacyEvidence: 'Only the listed profile preferences and startup arguments were configured. This is not an audit of vendor-required network telemetry or proof of native UI choices.',
    existingUserProfilesTouched: false, osPolicyModified: false, installationDirectoryModified: false, sandboxDisabled: false,
    configuredFiles: ['First Run', 'Local State', 'Default/Preferences'], startupArguments: [...FLAGS], sources: SOURCE
  }
}

/** Creates, never adopts, a new disposable profile. The caller owns cleanup of
 * its enclosing CI fixture after all browser/MCP processes have terminated.
 * No browser is launched and no global preferences/policies are modified. */
export async function prepareBrandedFirstRun({ env = process.env, channel, parent = env.RUNNER_TEMP } = {}) {
  gate(env, channel)
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) fail('first_run_scope_invalid', 'The fixture parent must be an existing absolute CI temporary directory.')
  const temp = await realpath(env.RUNNER_TEMP), directory = await realpath(parent)
  if (temp === path.parse(temp).root || temp === await realpath(os.homedir()) || !contained(temp, directory)) fail('first_run_scope_invalid', 'First-run profiles cannot be created outside the runner temporary directory.')
  const parentInfo = await lstat(directory)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || process.getuid && parentInfo.uid !== process.getuid()) fail('first_run_scope_invalid', 'The fixture parent is not an owned ordinary directory.')
  const profile = await mkdtemp(path.join(directory, 'kkcode-first-run-'))
  const identity = await privateDirectory(profile)
  await mkdir(path.join(profile, 'Default'), { mode: 0o700 })
  // Chromium's official CreateSentinel writes this empty file. Explicitly
  // initialize it for later native launches too: --no-first-run alone does not.
  await writeNew(path.join(profile, 'First Run'), '')
  await writeNew(path.join(profile, 'Local State'), JSON.stringify(LOCAL_STATE))
  await writeNew(path.join(profile, 'Default', 'Preferences'), JSON.stringify(PREFERENCES))
  createdProfiles.set(profile, { dev: identity.dev, ino: identity.ino, channel, temp })
  return { profile, args: [...FLAGS], receipt: await initializeBrandedFirstRun({ env, channel, profile, phase: 'prelaunch' }) }
}

/** Read-only evidence of the exact configuration above, never proof that an
 * operating-system modal was accepted or that merely opening a CDP tab worked. */
export async function initializeBrandedFirstRun({ env = process.env, channel, profile, phase = 'postlaunch' } = {}) {
  gate(env, channel)
  if (!['prelaunch', 'postlaunch'].includes(phase)) fail('first_run_phase_invalid', 'Unsupported first-run evidence phase.')
  const known = createdProfiles.get(profile)
  if (!known || known.channel !== channel) fail('first_run_profile_invalid', 'Only a new profile created by this helper can be verified.')
  const temp = await realpath(env.RUNNER_TEMP), canonical = await realpath(profile), current = await privateDirectory(profile)
  if (temp !== known.temp || canonical !== profile || !contained(temp, profile) || current.dev !== known.dev || current.ino !== known.ino) fail('first_run_profile_invalid', 'The owned CI profile identity changed.')
  await privateDirectory(path.join(profile, 'Default'))
  if (await readPrivate(path.join(profile, 'First Run')) !== '') fail('first_run_profile_invalid', 'The first-run sentinel is not the exact initialized empty file.')
  const localState = await readJson(path.join(profile, 'Local State')), preferences = await readJson(path.join(profile, 'Default', 'Preferences'))
  if (localState.user_experience_metrics?.reporting_enabled !== false || preferences.signin?.allowed !== false || preferences.signin?.allowed_on_next_startup !== false
    || Object.keys(PREFERENCES).filter(key => key !== 'signin').some(key => preferences[key] !== false)) fail('first_run_privacy_changed', 'The configured opt-out or no-import preferences changed; initialization was not accepted.')
  return receipt(channel, phase)
}
