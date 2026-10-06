import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { nativeLoginRequest, nativeLoginProof, nativeLoginReturn } from '../src/remote/native-login.mjs'
const { loginReturn } = createRequire(import.meta.url)('../apps/desktop/login-policy.cjs')
test('desktop gateway login wakes only the matching app flow; tokens still require PKCE', () => {
  const state = 's'.repeat(43), verifier = 'v'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url')
  const native = nativeLoginRequest({ kind: 'client', native: { platform: 'windows', state, code_challenge: challenge, code_challenge_method: 'S256' } })
  const url = nativeLoginReturn({ native }), pending = { state, expires: 2000 }
  assert.equal(url, `cn.kkcode.desktop://auth/complete?state=${state}`)
  assert.equal(loginReturn(url, pending, 1000), true)
  for (const invalid of [url.replace('desktop', 'remote'), url + '&token=secret', url.replace(state, 'x'.repeat(43)), url.replace('/complete', '/other'), url + '#secret']) assert.equal(loginReturn(invalid, pending, 1000), false)
  assert.equal(loginReturn(url, pending, 3000), false)
  assert.equal(loginReturn(url, null, 1000), false)
  assert.equal(nativeLoginProof({ native }, { browser: true, code_verifier: verifier }), true)
  assert.equal(nativeLoginProof({ native }, { browser: true }), false)
  assert.equal(nativeLoginProof({ native }, { browser: true, code_verifier: state }), false)
  assert.equal(nativeLoginProof({ native: { ...native, platform: 'android' } }, { browser: true, code_verifier: verifier }), false)
})
