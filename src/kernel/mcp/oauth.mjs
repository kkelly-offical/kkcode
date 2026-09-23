import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Client, StreamableHTTPClientTransport, SSEClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import { encryptedStore } from '../../storage/encrypted-store.mjs'
import { MCP_CLIENT_INFO } from './constants.mjs'

const required = () => Object.assign(new Error('MCP authorization required; run kkcode mcp auth --server <name>'), { code: 'mcp_auth_required' })
function endpoint(config) {
  const url = new URL(config.url || config.base_url)
  if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('MCP OAuth requires HTTPS outside loopback')
  return url
}
/** @param {string} name @param {any} config @param {{redirectUrl?: string, onAuthorization?: (url: URL) => unknown, state?: string}} [options] */
export function createMcpOAuthProvider(name, config, { redirectUrl, onAuthorization, state } = {}) {
  const url = endpoint(config), store = encryptedStore(`mcp-oauth:${name}:${url.href}`)
  let activeRedirect = redirectUrl
  const field = key => async () => (await store.read())[key]
  const save = key => async value => { await store.update(data => ({ ...data, [key]: value, ...(activeRedirect ? { redirectUrl: activeRedirect } : {}) })) }
  const provider = {
    get redirectUrl() { return activeRedirect },
    get clientMetadata() { return { client_name: 'KK Code', application_type: 'native', redirect_uris: activeRedirect ? [activeRedirect] : [], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } },
    state: () => state,
    clientInformation: async () => {
      const saved = await store.read()
      if (onAuthorization && activeRedirect && saved.redirectUrl !== activeRedirect && !saved.tokens) return undefined
      return saved.client
    }, saveClientInformation: save('client'),
    tokens: field('tokens'), saveTokens: save('tokens'),
    discoveryState: field('discovery'), saveDiscoveryState: save('discovery'),
    saveCodeVerifier: save('verifier'), codeVerifier: async () => { const verifier = await field('verifier')(); if (!verifier) throw required(); return verifier },
    redirectToAuthorization: async authorizationUrl => { if (!onAuthorization) throw required(); await onAuthorization(authorizationUrl) },
    invalidateCredentials: async scope => store.update(data => {
      if (scope === 'all') return null
      const keys = { client: 'client', tokens: 'tokens', verifier: 'verifier', discovery: 'discovery' }
      delete data[keys[scope]]; return data
    })
  }
  return {
    provider, store,
    async initialize() {
      const saved = await store.read()
      if (!activeRedirect) activeRedirect = saved.redirectUrl
      return Boolean(saved.tokens)
    }
  }
}

/** @param {string} name @param {any} config @param {{onAuthorization?: (url: URL) => unknown, signal?: AbortSignal, timeoutMs?: number}} [options] */
export async function loginMcpOAuth(name, config, { onAuthorization, signal, timeoutMs = 180000 } = {}) {
  const url = endpoint(config), state = randomBytes(32).toString('base64url')
  let accept, decline, handled = false
  const callback = new Promise((resolve, reject) => { accept = resolve; decline = reject })
  // Attach rejection handling before the browser can cancel the flow.
  callback.catch(() => {})
  let redirectUrl
  const server = createServer((req, res) => {
    const incoming = new URL(req.url, redirectUrl)
    const expectedHost = new URL(redirectUrl).host
    const supplied = Buffer.from(incoming.searchParams.get('state') || ''), expected = Buffer.from(state)
    if (handled || req.method !== 'GET' || req.headers.host !== expectedHost || incoming.pathname !== '/callback' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(400).end('Invalid authorization callback'); return }
    handled = true
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end('请返回 KK Code。You can close this page.')
    // The SDK checks iss before interpreting the authorization error or code.
    accept(incoming.searchParams)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(null)) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('OAuth callback did not bind a loopback port')
  redirectUrl = `http://127.0.0.1:${address.port}/callback`
  const auth = createMcpOAuthProvider(name, config, { redirectUrl, onAuthorization, state })
  const controller = new AbortController()
  const cancel = error => { decline(error); controller.abort(error); void client.close().catch(() => {}) }
  const abort = () => cancel(new Error('MCP authorization cancelled'))
  const timer = setTimeout(() => cancel(new Error('MCP authorization timed out')), timeoutMs)
  signal?.addEventListener('abort', abort, { once: true })
  const Transport = String(config.transport || config.type).toLowerCase() === 'legacy-sse' ? SSEClientTransport : StreamableHTTPClientTransport
  const transport = new Transport(url, { authProvider: auth.provider, requestInit: { signal: controller.signal } }), client = new Client(MCP_CLIENT_INFO)
  try {
    if (signal?.aborted) throw new Error('MCP authorization cancelled')
    await auth.initialize()
    try { await client.connect(transport); return { authorized: true } }
    catch (error) { if (!(error instanceof UnauthorizedError)) throw error }
    await transport.finishAuth(await callback)
    return { authorized: true }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort)
    await client.close().catch(() => {})
    try { await auth.provider.invalidateCredentials('verifier') }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
}
