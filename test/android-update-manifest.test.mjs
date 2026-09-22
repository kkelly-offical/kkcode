import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAndroidUpdateManifest } from '../scripts/android-update-manifest.mjs'

function fixture() {
  const hash = 'a'.repeat(64), certificate = 'b'.repeat(64)
  return { target: { applicationId: 'cn.kkcode.remote', version: '1.0.1', versionCode: 10004 }, identity: { applicationId: 'cn.kkcode.remote', certificateSha256: certificate }, report: { applicationId: 'cn.kkcode.remote', version: '1.0.1', versionCode: 10004, certificateSha256: certificate, apkSha256: hash, verifiedV2: true, verifiedV3: true, debuggable: false }, apkSha256: hash, apkSize: 512 }
}
test('Android update metadata is generated only from a matching, verified project-signed artifact', () => {
  const value = buildAndroidUpdateManifest(fixture())
  assert.equal(value.versionCode, 10004); assert.equal(value.channel, 'stable')
  assert.equal(value.apk.name, 'kkcode-android-1.0.1.apk'); assert.equal(value.protocolVersion, '1')
  const preview = fixture(); preview.target.version = preview.report.version = '1.0.2-preview.0'
  assert.equal(buildAndroidUpdateManifest(preview).channel, 'preview')
})
test('Android metadata rejects changed bytes, debug/wrong signatures, invalid sizes and mismatched versions', () => {
  for(const mutate of [v => { v.report.debuggable = true }, v => { v.report.verifiedV3 = false }, v => { v.report.certificateSha256 = 'c'.repeat(64) }, v => { v.report.apkSha256 = 'c'.repeat(64) }, v => { v.report.versionCode++ }, v => { v.report.applicationId = 'unrelated.app' }, v => { v.apkSize = 0 }, v => { v.apkSize = 300 * 1024 * 1024 }, v => { v.target.version = v.report.version = '1.1.0' }]) { const value = fixture(); mutate(value); assert.throws(() => buildAndroidUpdateManifest(value)) }
})
