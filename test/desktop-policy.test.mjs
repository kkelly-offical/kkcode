import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
const { gatewayOrigin, externalUrl, trustedFrame, uiPreferences, bundledGatewayAsset } = createRequire(import.meta.url)('../apps/desktop/policy.cjs')

test('desktop gateway chooser accepts only a clean HTTPS origin', () => {
  assert.equal(gatewayOrigin(' https://coding.example.com/ '), 'https://coding.example.com')
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'file:///C:/config', 'https://example.com/login', 'https://example.com/?token=secret', 'javascript:alert(1)']) assert.throws(() => gatewayOrigin(value))
})
test('external links never dispatch executable local protocols', () => {
  assert.equal(externalUrl('https://example.com/docs'), 'https://example.com/docs')
  for (const value of ['file:///etc/passwd', 'cmd:calc.exe', 'powershell:test', 'javascript:alert(1)', 'https://user:secret@example.com']) assert.equal(externalUrl(value), null)
})
test('desktop IPC requires the local top-level frame of this application window', () => {
  const frame = { url: 'http://127.0.0.1:12345/' }, contents = { mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents }
  assert.equal(trustedFrame({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:12345'), true)
  assert.equal(trustedFrame({ sender: contents, senderFrame: { url: frame.url } }, window, 'http://127.0.0.1:12345'), false)
  frame.url = 'https://coding.example.com/'
  assert.equal(trustedFrame({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:12345'), false)
})
test('desktop display persistence accepts only known non-secret preferences', () => {
  assert.deepEqual(uiPreferences({ token: 'must-not-persist', 'kkcode.web.theme': 'light', 'kkcode.web.reading': '{"scale":125,"width":"wide"}', 'kkcode.studio.palette': '../../secret' }), { 'kkcode.web.theme': 'light', 'kkcode.web.reading': '{"scale":125,"width":"wide"}' })
  assert.deepEqual(uiPreferences({ 'kkcode.web.reading': '{"scale":100000,"width":"full"}' }), {})
})
test('bundled gateway UI replaces exact static GETs only, without intercepting authentication or APIs', () => {
  const origins = new Set(['https://gateway.example.com']), assets = new Map([['/', 'index.html'], ['/assets/index.js', 'index.js']])
  assert.equal(bundledGatewayAsset({ method: 'GET', url: 'https://gateway.example.com/assets/index.js' }, origins, assets), '/assets/index.js')
  for (const url of ['https://gateway.example.com/api/v1/discovery', 'https://gateway.example.com/auth/token', 'https://gateway.example.com/assets/../../secret', 'https://other.example.com/', 'https://user:secret@gateway.example.com/']) assert.equal(bundledGatewayAsset({ method: 'GET', url }, origins, assets), null)
  assert.equal(bundledGatewayAsset({ method: 'POST', url: 'https://gateway.example.com/' }, origins, assets), null)
})
