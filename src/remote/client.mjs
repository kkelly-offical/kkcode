import { readFile } from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import { userRootDir } from '../storage/paths.mjs'
import { DeviceService } from '../device/service.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { acceptRemoteIdentity, prepareRemoteBinding } from './device-lifecycle.mjs'
import { RELAY_FEATURE_EVENT_PUSH } from '../protocol/index.mjs'
import { deviceLoginPath } from '../protocol/login-path.mjs'

const credentialsPath = () => path.join(userRootDir(), 'remote-credentials.json')
// Endpoint selection and local ownership metadata are never token extensions.
// Keep the existing SSO profile contract; its fields are not network addresses.
const tokenFields = value => Object.fromEntries(
  ['access_token', 'refresh_token', 'token_type', 'expires_in', 'profile']
    .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])
)
export async function loadRemoteCredentials() { try { return JSON.parse(await readFile(credentialsPath(), 'utf8')) } catch { return null } }
export async function saveRemoteCredentials(value) { await writePrivateFile(credentialsPath(), JSON.stringify(value)) }
export function gatewayUrl(value) {
  const url = new URL(value)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Gateway must use HTTPS (HTTP is allowed only on loopback)')
  return url.origin
}
/** The owner selects the gateway; credential-bearing API calls may not be
 * redirected to another host (307/308 would otherwise preserve JSON secrets). */
export function requestGateway(gateway, route, options = {}) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\\r\n]/.test(route)) throw new Error('Invalid gateway API path')
  return fetch(`${gatewayUrl(gateway)}${route}`, { ...options, redirect: 'error' })
}
export async function discoverRemoteGateway(gateway, { signal } = {}) {
  gateway = gatewayUrl(gateway)
  for (let redirects = 0; redirects <= 5; redirects++) {
    // Discovery is public and carries no cookie, bearer or grant. Permit an
    // explicit canonical-origin redirect, validating transport at every hop.
    const response = await fetch(`${gateway}/api/v1/discovery`, { signal, redirect: 'manual', credentials: 'omit' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Gateway discovery redirect has no location')
      gateway = gatewayUrl(new URL(location, gateway).href)
      continue
    }
    if (!response.ok) throw new Error(`Gateway discovery failed: HTTP ${response.status}`)
    return gatewayUrl((await response.json()).gateway || gateway)
  }
  throw new Error('Gateway discovery exceeded the redirect limit')
}
export async function loginRemote({ gateway, name = 'KK Code computer', print = console.error, signal, transferHistory = false } = {}) {
  const previousCredentials = await loadRemoteCredentials()
  gateway = gatewayUrl(gateway || previousCredentials?.gateway || '')
  gateway = await discoverRemoteGateway(gateway, { signal })
  const response = await requestGateway(gateway, '/auth/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind: 'device' }), signal })
  if (!response.ok) throw new Error(`Gateway login failed: HTTP ${response.status}`)
  const flow = await response.json()
  print(`Login to KK Code:\n${gateway}${deviceLoginPath(flow.user_code)}\nCode: ${flow.user_code}\nConfirm the computer and organization in your browser.`)
  const deadline = Date.now() + flow.expires_in * 1000
  let interval = Math.max(5, flow.interval || 5)
  while (Date.now() < deadline) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(done, interval * 1000)
      function done() { signal?.removeEventListener('abort', aborted); resolve() }
      function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal.reason) }
      if (signal?.aborted) return aborted()
      signal?.addEventListener('abort', aborted, { once: true })
    })
    const reply = await requestGateway(gateway, '/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: flow.device_code }), signal })
    const result = await reply.json()
    if (reply.ok) {
      // Only explicit public discovery may select a canonical gateway. Token
      // metadata must not redirect the next bearer/refresh request to a new
      // origin, even when a federated issuer includes an extra `gateway` field.
      const credentials = { ...tokenFields(result), gateway, expiresAt: Date.now() + result.expires_in * 1000 }
      try { await acceptRemoteIdentity(credentials, { transferHistory, previousCredentials }) }
      catch (error) {
        // A browser may have selected the wrong organization account. Revoke the
        // newly issued login without replacing the existing local credential.
        await requestGateway(gateway, '/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.access_token}` }, body: JSON.stringify({ kind: 'device' }), signal }).catch(() => {})
        throw error
      }
      await saveRemoteCredentials(credentials)
      return credentials
    }
    if (result.error === 'slow_down') interval += 5
    else if (result.error !== 'authorization_pending') throw new Error(`Login failed: ${result.error}`)
  }
  throw new Error('Login code expired')
}
export async function refreshRemoteCredentials(credentials, { signal } = {}) {
  const gateway = gatewayUrl(credentials.gateway)
  const response = await requestGateway(gateway, '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: credentials.refresh_token }), signal })
  if (!response.ok) throw Object.assign(new Error('Remote login expired. Sign in again with the device owner account'), { code: 'login_required', status: response.status })
  const tokens = await response.json()
  const updated = { ...credentials, ...tokenFields(tokens), gateway, expiresAt: Date.now() + tokens.expires_in * 1000 }
  await saveRemoteCredentials(updated)
  return updated
}
export async function revokeRemoteDevice({ deviceId, credentials, signal } = {}) {
  const response = await requestGateway(credentials.gateway, `/api/v1/devices/${encodeURIComponent(deviceId)}/unbind`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.access_token}` }, body: JSON.stringify({ confirmation: deviceId }), signal: signal || AbortSignal.timeout(30000) })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw Object.assign(new Error(error.error?.message || `Device unbind failed: HTTP ${response.status}. The local binding remains locked; retry unbind after restoring connectivity`), { code: error.error?.code || 'unbind_failed', status: response.status })
  }
  return response.json()
}
export async function connectRelay({ service, credentials, onStatus = () => {} }) {
  await prepareRemoteBinding(service, credentials)
  let stopped = false, socket, timer, backoff = 1000, registered = false
  // Push journal rows/device events upstream for the gateway's SSE streams.
  // Rows stay replayable from the journal, so shedding under backpressure is
  // safe: the gateway heals a sequence jump through a journal re-sync.
  const push = (type, event) => {
    if (!registered || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 4 * 1024 * 1024) return
    socket.send(JSON.stringify({ type, event }))
  }
  const onEvent = row => push('event', row), onDevice = event => push('device-event', event)
  service.on('event', onEvent)
  service.on('device', onDevice)
  async function connect() {
    if (stopped) return
    try {
      if (credentials.expiresAt < Date.now() + 60000) {
        try { credentials = await refreshRemoteCredentials(credentials, { signal: AbortSignal.timeout(15000) }) }
        catch (error) { if ([400, 401, 403].includes(error.status)) { stopped = true; onStatus('login_required'); return }; throw error }
      }
      if (stopped) return
      const connection = socket = new WebSocket(`${gatewayUrl(credentials.gateway).replace(/^http/, 'ws')}/relay/device`, { headers: { Authorization: `Bearer ${credentials.access_token}` }, followRedirects: false, maxPayload: 6 * 1024 * 1024, handshakeTimeout: 15000 })
      connection.on('open', () => { connection.send(JSON.stringify({ type: 'register', device: { id: service.metadata.id, name: service.metadata.name }, features: [RELAY_FEATURE_EVENT_PUSH] })) })
      connection.on('message', async raw => {
        let message
        try {
          message = JSON.parse(raw.toString())
          if (message.type === 'registered') { backoff = 1000; registered = true; onStatus('connected'); return }
          if (message.type !== 'request') return
          const result = await service.request(message.request, message.principal)
          if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'response', id: message.id, result }))
        } catch (error) {
          if (message?.id && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'response', id: message.id, error: { code: error.code || 'device_error', message: error.message }, status: error.status || 400 }))
        }
      })
      connection.on('error', () => {})
      connection.on('close', (code, reason) => {
        registered = false
        if (stopped) return
        if (code === 1008 && reason.toString() !== 'Authentication expired') { stopped = true; onStatus('login_required'); return }
        onStatus('disconnected'); retry()
      })
    } catch { retry() }
  }
  function retry() { if (!stopped) { timer = setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2) } }
  await connect()
  return { close() { stopped = true; registered = false; clearTimeout(timer); service.off('event', onEvent); service.off('device', onDevice); socket?.close(1000, 'Terminal closed'); onStatus('offline') } }
}
export async function createRemoteDevice(options = {}) { return new DeviceService(options).initialize() }
