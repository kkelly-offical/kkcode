import test from 'node:test'
import assert from 'node:assert/strict'
import { DeviceClient } from '../src/sdk/client.mjs'

const json = (value, status = 200) => new Response(JSON.stringify(value), { status })

test('SDK binds fetch and uses one RPC shape for local and Relay transports', async () => {
  const calls = []
  const fetch = function (url, options) { assert.equal(this, globalThis); calls.push({ url, options }); return Promise.resolve(json({ result: { ok: true } })) }
  const local = new DeviceClient({ url: 'https://computer.example/', token: 'fixture', fetch })
  const relay = new DeviceClient({ url: 'https://gateway.example', deviceId: 'device /1', fetch })
  assert.deepEqual(await local.request('status', {}, { id: 'local-request' }), { ok: true })
  await relay.request('status', {}, { id: 'relay-request' })
  assert.equal(calls[0].url, 'https://computer.example/api/v1/rpc')
  assert.equal(calls[1].url, 'https://gateway.example/api/v1/devices/device%20%2F1/rpc')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture')
  assert.equal(calls[0].options.headers['User-Agent'], 'KK Code SDK')
  const { issuedAt, ...envelope } = JSON.parse(calls[1].options.body)
  assert.ok(Number.isSafeInteger(issuedAt) && Math.abs(Date.now() - issuedAt) < 10000)
  assert.deepEqual(envelope, { id: 'relay-request', method: 'status', params: {} })
})

test('SDK retries transient failures with the original mutation ID, never retries authorization errors', async () => {
  const ids = [], timestamps = []
  const client = new DeviceClient({ url: 'https://device.example', fetch: async (url, options) => {
    ids.push(JSON.parse(options.body).id)
    timestamps.push(JSON.parse(options.body).issuedAt)
    return ids.length === 1 ? json({ error: { code: 'device_offline' } }, 503) : json({ result: 'done' })
  } })
  assert.equal(await client.request('turns.start', { prompt: 'one action' }, { id: 'stable-mutation' }), 'done')
  assert.deepEqual(ids, ['stable-mutation', 'stable-mutation'])
  assert.equal(timestamps[0], timestamps[1])
  let forbiddenCalls = 0
  const denied = new DeviceClient({ url: 'https://device.example', fetch: async () => { forbiddenCalls++; return json({ error: { code: 'forbidden', message: 'Denied' } }, 403) } })
  await assert.rejects(denied.request('settings.get'), error => error.code === 'forbidden' && error.status === 403)
  assert.equal(forbiddenCalls, 1)
})

test('parallel unauthorized SDK calls share one rotating refresh token exchange', async () => {
  let refreshes = 0, saved = 0
  const client = new DeviceClient({ url: 'https://gateway.example', token: 'expired', refreshToken: 'refresh-once', onCredentials: () => { saved++ }, fetch: async (url, options) => {
    if (url.endsWith('/auth/refresh')) {
      refreshes++; assert.equal(JSON.parse(options.body).refresh_token, 'refresh-once')
      await new Promise(resolve => setTimeout(resolve, 10))
      return json({ access_token: 'renewed', refresh_token: 'next', expires_in: 3600 })
    }
    return options.headers.Authorization === 'Bearer renewed' ? json({ result: 'ok' }) : json({ error: 'login_required' }, 401)
  } })
  assert.deepEqual(await Promise.all([client.request('status'), client.request('sessions.list')]), ['ok', 'ok'])
  assert.equal(refreshes, 1); assert.equal(saved, 1); assert.equal(client.refreshToken, 'next')
})

test('aborting one refresh waiter does not cancel another caller or rotating credential persistence', async () => {
  let finish
  const client = new DeviceClient({ url: 'https://gateway.example', gateway: true, fetch: async () => {
    await new Promise(resolve => { finish = resolve })
    return json({ refreshed: true })
  } })
  const controller = new AbortController(), first = client.refresh({ signal: controller.signal }), second = client.refresh()
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(first, /caller cancelled/)
  finish(); assert.deepEqual(await second, { refreshed: true })
})

test('SDK cancellation stops retry backoff and replay gaps request a snapshot reload', async () => {
  const controller = new AbortController(); let calls = 0
  const client = new DeviceClient({ url: 'https://device.example', fetch: async () => { calls++; queueMicrotask(() => controller.abort(new Error('cancelled'))); throw new Error('Connection reset') } })
  await assert.rejects(client.request('status', {}, { signal: controller.signal }), /Connection reset|cancelled/)
  assert.equal(calls, 1)
  const replay = new DeviceClient({ url: 'https://device.example', fetch: async () => json({ result: { gap: true, earliest: 42, events: [] } }) })
  await assert.rejects(replay.events('session').next(), error => error.code === 'replay_gap' && error.after === 42)
})

test('SDK stream refreshes authentication, dispatches gaps and releases its reader on callback failure', async () => {
  let refreshed = 0, cancelled = 0
  const rows = [], gaps = []
  const client = new DeviceClient({ url: 'https://device.example', token: 'expired', refreshToken: 'refresh', fetch: async (url, options) => {
    if (url.endsWith('/auth/refresh')) { refreshed++; return json({ access_token: 'fresh', refresh_token: 'next' }) }
    if (options.headers.Authorization !== 'Bearer fresh') return json({}, 401)
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: replay.gap\ndata: {"earliest":4}\n\nevent: tool.finish\ndata: {"seq":4}\n\n')) }, cancel() { cancelled++ } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  await assert.rejects(client.stream('test', { onGap: gap => { gaps.push(gap) }, onEvent: event => { rows.push(event); throw new Error('consumer stopped') } }), /consumer stopped/)
  assert.equal(refreshed, 1); assert.equal(cancelled, 1); assert.equal(rows[0].seq, 4); assert.equal(gaps[0].earliest, 4)
})

test('SDK stream cancellation closes an idle reader without waiting for another event', async () => {
  let cancelled = false
  const controller = new AbortController()
  const client = new DeviceClient({ url: 'https://device.example', fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } }) })
  const operation = client.stream('test', { signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(new Error('switched device'))
  await assert.rejects(operation, /switched device/)
  assert.equal(cancelled, true)
})
