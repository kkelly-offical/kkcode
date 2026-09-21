import { readFile } from 'node:fs/promises'
import path from 'node:path'

export function parseAndroidReleaseTarget(packageVersion, gradle) {
  const version = gradle.match(/^\s*versionName\s*=\s*"([^"]+)"\s*$/m)?.[1]
  const versionCode = Number(gradle.match(/^\s*versionCode\s*=\s*(\d+)\s*$/m)?.[1])
  const applicationId = gradle.match(/^\s*applicationId\s*=\s*"([^"]+)"\s*$/m)?.[1]
  if (typeof packageVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(packageVersion)) throw new Error('Root package version must be a semantic version')
  if (version !== packageVersion) throw new Error('Android versionName must exactly match the root package version')
  if (applicationId !== 'cn.kkcode.remote' || !Number.isSafeInteger(versionCode) || versionCode <= 0 || versionCode > 2100000000) throw new Error('Android release target has an invalid application ID or versionCode')
  return { applicationId, version, versionCode, channel: version.includes('-') ? 'prerelease' : 'stable' }
}

export async function readAndroidReleaseTarget(root) {
  const [packageSource, gradle] = await Promise.all([readFile(path.join(root, 'package.json'), 'utf8'), readFile(path.join(root, 'android/app/build.gradle.kts'), 'utf8')])
  return parseAndroidReleaseTarget(JSON.parse(packageSource).version, gradle)
}

export function assertAndroidApkTarget(badging, target) {
  const line = badging.split(/\r?\n/).find(value => value.startsWith('package:')) || ''
  const fields = Object.fromEntries([...line.matchAll(/\b(name|versionCode|versionName)='([^']*)'/g)].map(match => [match[1], match[2]]))
  if (fields.name !== target.applicationId || fields.versionName !== target.version || Number(fields.versionCode) !== target.versionCode || /^application-debuggable(?:\s|$)/m.test(badging)) throw new Error('APK manifest does not match the non-debuggable Android release target')
}

export function assertAndroidInstalledTarget(packageInfo, target) {
  const version = packageInfo.match(/^\s*versionName=([^\r\n]+)$/m)?.[1]?.trim()
  const versionCode = Number(packageInfo.match(/^\s*versionCode=(\d+)\b/m)?.[1])
  if (version !== target.version || versionCode !== target.versionCode || /^\s*flags=.*\bDEBUGGABLE\b/m.test(packageInfo)) throw new Error('Installed package does not match the non-debuggable Android release target')
}
