import { readFile } from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import { userRootDir } from '../storage/paths.mjs'
import { DeviceService } from '../device/service.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { acceptRemoteIdentity, prepareRemoteBinding } from './device-lifecycle.mjs'

const credentialsPath = () => path.join(userRootDir(), 'remote-credentials.json')
export async function loadRemoteCredentials() { try { return JSON.parse(await readFile(credentialsPath(), 'utf8')) } catch { return null } }
export async function saveRemoteCredentials(value) { await writePrivateFile(credentialsPath(), JSON.stringify(value)) }
export function gatewayUrl(value) {
  const url = new URL(value)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Gateway must use HTTPS (HTTP is allowed only on loopback)')
  return url.origin
}
export async function loginRemote({ gateway, name = 'KK Code computer', print = console.error, signal, transferHistory = false } = {}) {
  const previousCredentials = await loadRemoteCredentials()
  gateway = gatewayUrl(gateway || previousCredentials?.gateway || '')
  const discovery = await fetch(`${gateway}/api/v1/discovery`, { signal })
  if (!discovery.ok) throw new Error(`Gateway discovery failed: HTTP ${discovery.status}`)
  gateway = gatewayUrl((await discovery.json()).gateway || gateway)
  const response = await fetch(`${gateway}/auth/device`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind: 'device' }), signal })
  if (!response.ok) throw new Error(`Gateway login failed: HTTP ${response.status}`)
  const flow = await response.json()
  print(`Login to KK Code:\n${flow.verification_uri_complete}\nCode: ${flow.user_code}\nConfirm the computer and organization in your browser.`)
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
    const reply = await fetch(`${gateway}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: flow.device_code }), signal })
    const result = await reply.json()
    if (reply.ok) {
      const credentials = { gateway, ...result, expiresAt: Date.now() + result.expires_in * 1000 }
      try { await acceptRemoteIdentity(credentials, { transferHistory, previousCredentials }) }
      catch (error) {
        // A browser may have selected the wrong organization account. Revoke the
        // newly issued login without replacing the existing local credential.
        await fetch(`${gateway}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.access_token}` }, body: JSON.stringify({ kind: 'device' }), signal }).catch(() => {})
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
  const response = await fetch(`${credentials.gateway}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: credentials.refresh_token }), signal })
  if (!response.ok) throw Object.assign(new Error('Remote login expired. Sign in again with the device owner account'), { code: 'login_required', status: response.status })
  const tokens = await response.json()
  const updated = { ...credentials, ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 }
  await saveRemoteCredentials(updated)
  return updated
}
export async function revokeRemoteDevice({ deviceId, credentials, signal } = {}) {
  const response = await fetch(`${credentials.gateway}/api/v1/devices/${encodeURIComponent(deviceId)}/unbind`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.access_token}` }, body: JSON.stringify({ confirmation: deviceId }), signal: signal || AbortSignal.timeout(30000) })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw Object.assign(new Error(error.error?.message || `Device unbind failed: HTTP ${response.status}. The local binding remains locked; retry unbind after restoring connectivity`), { code: error.error?.code || 'unbind_failed', status: response.status })
  }
  return response.json()
}
export async function connectRelay({ service, credentials, onStatus = () => {} }) {
  await prepareRemoteBinding(service, credentials)
  let stopped = false, socket, timer, backoff = 1000
  async function connect() {
    if (stopped) return
    try {
      if (credentials.expiresAt < Date.now() + 60000) {
        try { credentials = await refreshRemoteCredentials(credentials, { signal: AbortSignal.timeout(15000) }) }
        catch (error) { if ([400, 401, 403].includes(error.status)) { stopped = true; onStatus('login_required'); return }; throw error }
      }
      if (stopped) return
      const connection = socket = new WebSocket(`${credentials.gateway.replace(/^http/, 'ws')}/relay/device`, { headers: { Authorization: `Bearer ${credentials.access_token}` }, maxPayload: 6 * 1024 * 1024, handshakeTimeout: 15000 })
      connection.on('open', () => { connection.send(JSON.stringify({ type: 'register', device: { id: service.metadata.id, name: service.metadata.name } })) })
      connection.on('message', async raw => {
        let message
        try {
          message = JSON.parse(raw.toString())
          if (message.type === 'registered') { backoff = 1000; onStatus('connected'); return }
          if (message.type !== 'request') return
          const result = await service.request(message.request, message.principal)
          if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'response', id: message.id, result }))
        } catch (error) {
          if (message?.id && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'response', id: message.id, error: { code: error.code || 'device_error', message: error.message }, status: error.status || 400 }))
        }
      })
      connection.on('error', () => {})
      connection.on('close', (code, reason) => {
        if (stopped) return
        if (code === 1008 && reason.toString() !== 'Authentication expired') { stopped = true; onStatus('login_required'); return }
        onStatus('disconnected'); retry()
      })
    } catch { retry() }
  }
  function retry() { if (!stopped) { timer = setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2) } }
  await connect()
  return { close() { stopped = true; clearTimeout(timer); socket?.close(1000, 'Terminal closed'); onStatus('offline') } }
}
export async function createRemoteDevice(options = {}) { return new DeviceService(options).initialize() }
