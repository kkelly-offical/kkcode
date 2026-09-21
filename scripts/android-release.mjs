import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAndroidApkTarget, readAndroidReleaseTarget } from './android-release-target.mjs'

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const target = await readAndroidReleaseTarget(root)
const directory = path.resolve(process.env.KKCODE_ANDROID_SIGNING_DIR || path.join(homedir(), '.local/share/kkcode-signing'))
const initialize = process.argv.includes('--init-key')
const onlyVerify = process.argv.includes('--verify-only')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
if (!sdk) throw new Error('Set ANDROID_HOME or ANDROID_SDK_ROOT')
if (directory === root || directory.startsWith(`${root}${path.sep}`)) throw new Error('Signing identity must be stored outside the checkout')

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`${path.basename(program)} failed (${result.status ?? result.error?.code}). Inspect the local tool separately; signing diagnostics are not echoed to prevent secret disclosure.`)
  return result.stdout
}
async function privateFile(file, content) { await writeFile(file, content, { mode: 0o600, flag: 'wx' }) }
await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
if ((await realpath(directory)).startsWith(`${await realpath(root)}${path.sep}`)) throw new Error('Signing directory resolves inside the checkout')
const config = path.join(directory, 'signing.properties')
const store = path.join(directory, 'kkcode-release.p12')
const password = path.join(directory, 'store-password')
const publicInfo = path.join(directory, 'signing-public.json')
if (initialize) {
  const existing = await readdir(directory)
  if (existing.length) throw new Error('Signing directory is not empty; refusing to overwrite or regenerate a release identity. Use the existing configuration.')
  await privateFile(password, `${randomBytes(48).toString('base64url')}\n`)
  run('keytool', ['-genkeypair', '-keystore', store, '-storetype', 'PKCS12', '-storepass:file', password, '-keypass:file', password, '-alias', 'kkcode-release', '-keyalg', 'RSA', '-keysize', '4096', '-sigalg', 'SHA256withRSA', '-validity', '10000', '-dname', 'CN=KK Code Release, OU=Release Engineering, O=KK Code', '-noprompt'])
  await chmod(store, 0o600)
  // java.util.Properties requires backslashes to be escaped on Windows.
  const escape = value => value.replaceAll('\\', '\\\\')
  await privateFile(config, `storeFile=${escape(store)}\nkeyAlias=kkcode-release\nstorePasswordFile=${escape(password)}\nkeyPasswordFile=${escape(password)}\n`)
  const certificate = run('keytool', ['-exportcert', '-keystore', store, '-storepass:file', password, '-alias', 'kkcode-release'], { encoding: null })
  const info = { applicationId: 'cn.kkcode.remote', alias: 'kkcode-release', algorithm: 'RSA-4096 / SHA256withRSA', certificateSha256: createHash('sha256').update(certificate).digest('hex'), createdAt: new Date().toISOString(), purpose: 'production-release', keyBackupRequired: true }
  await writeFile(publicInfo, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
}
for (const file of [config, store, password, publicInfo]) await access(file, constants.R_OK)
for (const file of [config, store, password]) if (process.platform !== 'win32' && ((await stat(file)).mode & 0o077)) throw new Error('Signing key/config/password must be private (0600)')
const metadata = JSON.parse(await readFile(publicInfo, 'utf8'))
if (metadata.purpose !== 'production-release' || metadata.applicationId !== 'cn.kkcode.remote') throw new Error('Signing identity metadata does not match KK Code release')
if (!onlyVerify) {
  const gradle = process.env.KKCODE_GRADLE || (process.platform === 'win32' ? 'gradle.bat' : 'gradle')
  run(gradle, [':app:assembleRelease', '--max-workers=4', '--console=plain', ...(process.argv.includes('--offline') ? ['--offline'] : [])], { cwd: path.join(root, 'android'), env: { ...process.env, KKCODE_ANDROID_SIGNING_PROPERTIES: config } })
}
const versions = (await readdir(path.join(sdk, 'build-tools'))).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
if (!versions.length) throw new Error('Android SDK build-tools are missing')
const buildTools = path.join(sdk, 'build-tools', versions[0])
const apk = path.join(root, 'android/app/build/outputs/apk/release/app-release.apk')
const verified = run(path.join(buildTools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'), ['verify', '--verbose', '--print-certs', apk])
const digest = verified.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9]+)/i)?.[1]?.toLowerCase()
if (digest !== metadata.certificateSha256.toLowerCase()) throw new Error('APK certificate does not match the project release identity')
// With minSdk 29 the verifier chooses v3 and reports v2=false even when a valid
// v2 block exists. Check that block separately; this does not lower app minSdk.
const legacyVerified = run(path.join(buildTools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'), ['verify', '--min-sdk-version', '24', '--max-sdk-version', '27', '--verbose', '--print-certs', apk])
const legacyDigest = legacyVerified.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9]+)/i)?.[1]?.toLowerCase()
if (!/Verified using v2 scheme[^\n]*true/.test(legacyVerified) || !/Verified using v3 scheme[^\n]*true/.test(verified) || legacyDigest !== digest) throw new Error('Release APK is missing matching v2/v3 signing')
const manifest = run(path.join(buildTools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'), ['dump', 'badging', apk])
assertAndroidApkTarget(manifest, target)
const report = { ...metadata, ...target, keyBackupRequired: true, apk, apkSha256: createHash('sha256').update(await readFile(apk)).digest('hex'), verifiedV2: true, verifiedV3: true, debuggable: false, verifiedAt: new Date().toISOString() }
await mkdir(path.join(root, 'test-results'), { recursive: true })
await writeFile(path.join(root, 'test-results/android-release-verification.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ...target, certificateSha256: digest, apkSha256: report.apkSha256, verifiedV2: true, verifiedV3: true, debuggable: false, apk }, null, 2))
