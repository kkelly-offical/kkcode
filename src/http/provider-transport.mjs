import {Agent} from 'undici'

// Never replace the host's global dispatcher. No implicit 300-second parser deadline.
// Every caller MUST retain its finite AbortSignal and its protocol-level body
// limits/idle reader. Otherwise a long queued JSON response can outlive fetch's
// hidden timeout even though the user explicitly configured a larger deadline.
const dispatcher = new Agent({connectTimeout: 0, headersTimeout: 0, bodyTimeout: 0, pipelining: 0,
  maxResponseSize: 16 * 1024 * 1024})

/** @param {string|URL} url @param {RequestInit} init */
export function providerFetch(url, init) {
  if (!(init?.signal instanceof AbortSignal)) throw new Error('Provider transport requires a cancellation signal; its caller must enforce a finite deadline')
  if (!['error', 'manual'].includes(init.redirect || '')) throw new Error('Provider transport refuses automatic redirects')
  // Built-in fetch remains the boundary for existing host mocks and standard
  // Response/WebStream semantics; the dispatcher belongs only to these calls.
  const options = {...init, dispatcher}
  return fetch(url, options)
}
