import test from 'node:test'
import assert from 'node:assert/strict'
import { assertAndroidApkTarget, assertAndroidInstalledTarget, parseAndroidReleaseTarget } from '../scripts/android-release-target.mjs'

const gradle = (version = '1.0.1-preview.0', code = 10001) => `applicationId = "cn.kkcode.remote"\nversionName = "${version}"\nversionCode = ${code}\n`
const target = parseAndroidReleaseTarget('1.0.1-preview.0', gradle())
const badging = (version = target.version, code = target.versionCode) => `package: name='cn.kkcode.remote' versionCode='${code}' versionName='${version}' platformBuildVersionName='15'\n`
const installed = (version = target.version, code = target.versionCode) => `    versionCode=${code} minSdk=29 targetSdk=35\n    versionName=${version}\n    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]\n`

test('Android release target supports exact prerelease parity', () => {
  assert.deepEqual(target, { applicationId: 'cn.kkcode.remote', version: '1.0.1-preview.0', versionCode: 10001, channel: 'prerelease' })
  assert.equal(parseAndroidReleaseTarget('1.0.2', gradle('1.0.2', 10002)).channel, 'stable')
})
test('Android versionName must match the root package exactly', () => {
  assert.throws(() => parseAndroidReleaseTarget('1.0.1', gradle()), /exactly match/)
  assert.throws(() => parseAndroidReleaseTarget('1.0.1-preview.1', gradle()), /exactly match/)
  assert.throws(() => parseAndroidReleaseTarget('not-a-version', gradle()), /semantic version/)
})
test('Android release target rejects invalid version codes and application IDs', () => {
  assert.throws(() => parseAndroidReleaseTarget(target.version, gradle(target.version, 0)), /invalid/)
  assert.throws(() => parseAndroidReleaseTarget(target.version, gradle(target.version, 2100000001)), /invalid/)
  assert.throws(() => parseAndroidReleaseTarget(target.version, gradle().replace('cn.kkcode.remote', 'cn.other.app')), /invalid/)
})
test('APK manifest validation accepts the precise preview and rejects stable or other builds', () => {
  assert.doesNotThrow(() => assertAndroidApkTarget(badging(), target))
  assert.throws(() => assertAndroidApkTarget(badging('1.0.1'), target), /does not match/)
  assert.throws(() => assertAndroidApkTarget(badging('1.0.1-preview.01'), target), /does not match/)
  assert.throws(() => assertAndroidApkTarget(badging(target.version, 10002), target), /does not match/)
  assert.throws(() => assertAndroidApkTarget(badging().replace('cn.kkcode.remote', 'cn.other.app'), target), /does not match/)
})
test('APK and installed-package validation reject debuggable builds', () => {
  assert.throws(() => assertAndroidApkTarget(`${badging()}application-debuggable\n`, target), /non-debuggable/)
  assert.throws(() => assertAndroidInstalledTarget(installed().replace('HAS_CODE', 'HAS_CODE DEBUGGABLE'), target), /non-debuggable/)
})
test('Installed-package validation compares exact version name and code', () => {
  assert.doesNotThrow(() => assertAndroidInstalledTarget(installed(), target))
  assert.throws(() => assertAndroidInstalledTarget(installed('1.0.1'), target), /does not match/)
  assert.throws(() => assertAndroidInstalledTarget(installed('1.0.1-preview.0-stale'), target), /does not match/)
  assert.throws(() => assertAndroidInstalledTarget(installed(target.version, 10002), target), /does not match/)
})
