import { readFile, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAndroidReleaseTarget } from './android-release-target.mjs'

export function buildAndroidUpdateManifest({ target, identity, report, apkSha256, apkSize }) {
  if (report.applicationId !== identity.applicationId || target.applicationId !== identity.applicationId || report.version !== target.version || report.versionCode !== target.versionCode) throw new Error('Android verification report does not match release target')
  if (report.certificateSha256 !== identity.certificateSha256 || !report.verifiedV2 || !report.verifiedV3 || report.debuggable !== false) throw new Error('A verified project-signed APK is required')
  if (report.apkSha256 !== apkSha256 || !/^[a-f0-9]{64}$/.test(apkSha256)) throw new Error('APK changed after signature verification')
  if (!Number.isSafeInteger(apkSize) || apkSize < 1 || apkSize > 256 * 1024 * 1024) throw new Error('APK size is outside the update policy')
  if (!/^1\.0\.\d+(?:-preview\.\d+)?$/.test(target.version)) throw new Error('Unsupported Android update channel/version')
  return {
    schemaVersion: 1, applicationId: target.applicationId, versionName: target.version, versionCode: target.versionCode,
    channel: target.version.includes('-') ? 'preview' : 'stable', minSdk: 29, protocolVersion: '1',
    apk: { name: `kkcode-android-${target.version}.apk`, size: apkSize, sha256: apkSha256, certificateSha256: identity.certificateSha256 }
  }
}

async function main() {
  const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
  const target = await readAndroidReleaseTarget(root)
  const identity = JSON.parse(await readFile(path.join(root, 'configs/android-release.json'), 'utf8'))
  const report = JSON.parse(await readFile(path.join(root, 'test-results/android-release-verification.json'), 'utf8'))
  const apk = path.join(root, 'android/app/build/outputs/apk/release/app-release.apk')
  const apkSha256 = createHash('sha256').update(await readFile(apk)).digest('hex')
  const manifest = buildAndroidUpdateManifest({ target, identity, report, apkSha256, apkSize: (await stat(apk)).size })
  const output = path.join(root, 'test-results/android-update.json')
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ manifest: output, version: manifest.versionName, versionCode: manifest.versionCode, apk: manifest.apk.name, sha256: apkSha256 }))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
