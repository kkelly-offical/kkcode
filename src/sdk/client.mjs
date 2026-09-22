import { PROTOCOL_VERSION } from '../protocol/index.mjs'
export { PROTOCOL_VERSION }

const pause = (milliseconds, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('Aborted')) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
})
const errorFrom = (body, status) => Object.assign(new Error(body?.error?.message || (typeof body?.error === 'string' ? body.error : `HTTP ${status}`)), { code: body?.error?.code || `http_${status}`, status })
const withSignal = (promise, signal) => !signal ? promise : new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason || new Error('Aborted'))
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
})

/** Browser-safe device SDK: local/Host and Relay share exactly the same RPC API. */
export class DeviceClient {
  constructor({ url, token, deviceId = null, gateway = false, refreshToken = null, onCredentials, fetch: fetchImpl = globalThis.fetch, headers = {}, retries = 5 }) {
    this.url = url.replace(/\/$/, ''); this.token = token; this.deviceId = deviceId
    this.refreshToken = refreshToken; this.onCredentials = onCredentials; this.refreshing = null; this.gateway = gateway || Boolean(deviceId)
    this.fetch = fetchImpl.bind(globalThis); this.headers = headers; this.retries = Math.max(0, Math.min(5, retries))
  }
  async refresh({ signal } = {}) {
    if (!this.refreshing) this.refreshing = (async () => {
      const response = await this.fetch(`${this.url}/auth/refresh`, { method: 'POST', redirect: 'error', credentials: 'include', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.refreshToken ? { refresh_token: this.refreshToken } : {}) })
      const body = await response.json()
      if (!response.ok) throw errorFrom(body, response.status)
      if (body.access_token) { this.token = body.access_token; this.refreshToken = body.refresh_token; await this.onCredentials?.(body) }
      return body
    })().finally(() => { this.refreshing = null })
    return withSignal(this.refreshing, signal)
  }
  async http(path, { method = 'GET', body, signal } = {}) {
    const make = () => this.fetch(`${this.url}${path}`, { method, redirect: 'error', credentials: 'include', signal, headers: { 'Content-Type': 'application/json', 'X-KK-Code-Client': 'sdk', ...(typeof window === 'undefined' ? { 'User-Agent': 'KK Code SDK' } : {}), ...this.headers, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    let response = await make()
    if (response.status === 401 && (this.refreshToken || this.gateway)) { await this.refresh({ signal }); response = await make() }
    const envelope = await response.json().catch(() => null)
    if (!response.ok || envelope?.error) throw errorFrom(envelope, response.status)
    return envelope
  }
  async request(method, params = {}, { signal, id = crypto.randomUUID(), issuedAt = Date.now() } = {}) {
    const target = this.deviceId ? `/api/v1/devices/${encodeURIComponent(this.deviceId)}/rpc` : '/api/v1/rpc'
    for (let attempt = 0; ; attempt++) {
      try { return (await this.http(target, { method: 'POST', body: { id, method, params, issuedAt }, signal })).result }
      catch (error) {
        if (signal?.aborted || attempt >= this.retries || (error.status && ![429, 502, 503, 504].includes(error.status))) throw error
        await pause(Math.min(250 * 2 ** attempt, 4000), signal)
      }
    }
  }
  listDevices(options) { return this.http('/api/v1/devices', options) }
  profile(options) { return this.http('/api/v1/profile', options) }
  async *events(sessionId, { after = 0, signal, interval = 1000 } = {}) {
    let cursor = after
    while (!signal?.aborted) {
      const batch = await this.request('events.list', { sessionId, after: cursor }, { signal })
      if (batch.gap) throw Object.assign(new Error('Event history was compacted; reload the session snapshot'), { code: 'replay_gap', after: batch.earliest })
      for (const event of batch.events) { cursor = event.seq; yield event }
      await pause(interval, signal)
    }
  }
}
