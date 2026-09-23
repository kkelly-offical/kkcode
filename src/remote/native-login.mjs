import { createHash, timingSafeEqual } from 'node:crypto'

// This is a wake-up signal, never an OAuth token delivery URL. Enterprise
// gateways need no domain-specific Android manifest or IdP redirect changes.
export const ANDROID_LOGIN_RETURN = 'cn.kkcode.remote://auth/complete'
export const NATIVE_LOGIN_CAPABILITY = Object.freeze({ version: 1, platform: 'android', redirectUri: ANDROID_LOGIN_RETURN, pkce: 'S256' })
const encodedSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export function nativeLoginRequest(body) {
  if (body?.redirect_uri !== undefined || body?.return_uri !== undefined || body?.return_url !== undefined) throw Object.assign(new Error('Login return addresses are fixed by the gateway'), { statusCode: 400 })
  if (body?.native === undefined) return undefined
  const value = body.native
  if (body.kind !== 'client' || !value || value.platform !== 'android' || value.code_challenge_method !== 'S256' || !encodedSecret(value.state) || !encodedSecret(value.code_challenge) || Object.keys(value).some(key => !['platform', 'state', 'code_challenge', 'code_challenge_method'].includes(key))) {
    throw Object.assign(new Error('Invalid native login request'), { statusCode: 400 })
  }
  return { platform: 'android', state: value.state, challenge: value.code_challenge }
}

export function nativeLoginProof(entry, body) {
  if (!entry?.native) return true
  if (body?.browser === true || typeof body?.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) return false
  const actual = createHash('sha256').update(body.code_verifier).digest('base64url')
  const expected = entry.native.challenge
  return encodedSecret(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export function nativeLoginReturn(entry) {
  if (entry?.native?.platform !== 'android' || !encodedSecret(entry.native.state)) return null
  return `${ANDROID_LOGIN_RETURN}?state=${entry.native.state}`
}
