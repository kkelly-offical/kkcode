import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION, SESSION_IDLE_TYPES, SESSION_RUNNING_TYPES } from '../protocol/index.mjs'
import { sessionStatusFromRow } from '../http/sse.mjs'

const TRANSITORY = new Set([429, 502, 503, 504])

/**
 * Gateway SSE fanout (docs/remote-sse-contract.md). Journal rows arrive from
 * push-capable devices over the relay socket; every subscriber additionally
 * keeps a journal sync loop (events.list) so reconnect replay, sequence jumps,
 * devices without push and HA routes terminating on another node all converge
 * on identical semantics. Syncs are read-only RPCs issued with the
 * subscriber's own principal: they renew the subscriber's control lease
 * exactly like events.list polling and never bypass sharing grants.
 */
export class GatewayEventHub {
  constructor({ sendRpc, pollMs = 1000, syncMs = 30000, statusMs = 10000, maxPerAccount = 16, maxPerDevice = 64 }) {
    this.sendRpc = sendRpc
    this.pollMs = pollMs; this.syncMs = syncMs; this.statusMs = statusMs
    this.maxPerAccount = maxPerAccount; this.maxPerDevice = maxPerDevice
    this.subs = new Set()
    this.push = new Map()
  }
  countForAccount(accountId) { let n = 0; for (const sub of this.subs) if (!sub.closed && sub.accountId === accountId) n++; return n }
  countForDevice(deviceId) { let n = 0; for (const sub of this.subs) if (!sub.closed && sub.deviceId === deviceId) n++; return n }
  setPush(deviceId, capable) { this.push.set(deviceId, capable) }
  _enqueue(sub, operation) { sub.chain = sub.chain.then(operation).catch(() => this._close(sub)) }
  _close(sub) {
    if (sub.closed) return
    sub.closed = true
    clearTimeout(sub.timer)
    this.subs.delete(sub)
    sub.writer.close()
  }
  remove(sub) { this._close(sub) }
  close() { for (const sub of [...this.subs]) this._close(sub) }
  closeDevice(deviceId) { for (const sub of [...this.subs]) if (sub.deviceId === deviceId) this._close(sub) }
  closeIdentitySession(identitySessionId) { for (const sub of [...this.subs]) if (sub.identitySessionId === identitySessionId) this._close(sub) }
  /** Sharing changed: re-check every subscriber of this device now. */
  revalidate(deviceId) { for (const sub of this.subs) if (sub.deviceId === deviceId && !sub.closed) this._enqueue(sub, async () => { if (!await sub.access()) this._close(sub) }) }
  /** Relay connection appeared/disappeared on this node: sync immediately. */
  deviceRegistered(deviceId, pushCapable) {
    this.setPush(deviceId, pushCapable)
    for (const sub of this.subs) if (sub.deviceId === deviceId && !sub.closed) this._enqueue(sub, () => sub.kind === 'session' ? this._syncSession(sub) : this._syncDevice(sub))
  }
  deviceClosed(deviceId) {
    this.setPush(deviceId, false)
    for (const sub of this.subs) {
      if (sub.deviceId !== deviceId || sub.closed) continue
      if (sub.kind === 'session') this._markOffline(sub)
      else this._enqueue(sub, async () => this._deviceOffline(sub))
    }
  }
  _markOffline(sub) {
    if (sub.online === false) return
    const was = sub.online
    sub.online = false
    if (was === true) sub.writer.send({ event: 'device.offline', data: { type: 'device.offline', deviceId: sub.deviceId, timestamp: Date.now() } })
  }
  _markOnline(sub) {
    if (sub.online !== false) { sub.online = true; return }
    sub.online = true
    sub.writer.send({ event: 'device.online', data: { type: 'device.online', deviceId: sub.deviceId, timestamp: Date.now() } })
  }
  addSessionStream({ deviceId, sessionId, after, principal, writer, access, accountId, identitySessionId }) {
    const sub = { kind: 'session', deviceId, sessionId, cursor: after, principal, writer, access, accountId, identitySessionId, closed: false, online: null, lastState: null, chain: Promise.resolve(), timer: null }
    this.subs.add(sub)
    const schedule = () => {
      if (sub.closed) return
      const idle = this.push.get(deviceId) === true ? this.syncMs : this.pollMs
      sub.timer = setTimeout(() => this._enqueue(sub, async () => { await this._syncSession(sub); schedule() }), idle)
      sub.timer.unref?.()
    }
    this._enqueue(sub, () => this._syncSession(sub, true))
    schedule()
    return sub
  }
  addDeviceStream({ deviceId, principal, writer, access, accountId, identitySessionId, grants = null }) {
    const sub = { kind: 'device', deviceId, principal, writer, access, accountId, identitySessionId, grants, closed: false, online: null, active: new Set(), localId: 0, chain: Promise.resolve(), timer: null }
    this.subs.add(sub)
    const schedule = () => {
      if (sub.closed) return
      sub.timer = setTimeout(() => this._enqueue(sub, async () => { await this._syncDevice(sub); schedule() }), this.statusMs)
      sub.timer.unref?.()
    }
    this._enqueue(sub, () => this._syncDevice(sub, true))
    schedule()
    return sub
  }
  /** Live journal row pushed by a push-capable device. */
  publish(deviceId, row) {
    for (const sub of this.subs) {
      if (sub.closed || sub.deviceId !== deviceId) continue
      if (sub.kind === 'session') {
        if (row.sessionId !== sub.sessionId || row.seq <= sub.cursor) continue
        this._enqueue(sub, async () => {
          if (sub.closed || row.seq <= sub.cursor) return
          if (row.seq > sub.cursor + 1) return this._syncSession(sub)
          if (!sub.writer.send({ id: String(row.seq), event: row.type, data: row })) return this._close(sub)
          sub.cursor = row.seq
          // Turn lifecycle and approval rows change the envelope state: refresh
          // it authoritatively from the device right away, not at the next tick.
          if (SESSION_IDLE_TYPES.includes(row.type) || SESSION_RUNNING_TYPES.includes(row.type) || row.type.startsWith('approval.')) await this._syncSession(sub)
        })
      } else {
        const status = sessionStatusFromRow(row)
        if (!status || sub.grants && !sub.grants.has(row.sessionId)) continue
        this._enqueue(sub, async () => {
          if (sub.closed || sub.active.has(row.sessionId) === status.running) return
          if (status.running) sub.active.add(row.sessionId)
          else sub.active.delete(row.sessionId)
          if (!sub.writer.send({ id: String(++sub.localId), event: 'session.status', data: { type: 'session.status', deviceId, ...status, timestamp: row.timestamp } })) this._close(sub)
        })
      }
    }
  }
  /** Device-scope live event (settings/models); owner streams only. */
  publishDeviceEvent(deviceId, event) {
    for (const sub of this.subs) {
      if (sub.closed || sub.deviceId !== deviceId || sub.kind !== 'device' || sub.grants) continue
      this._enqueue(sub, async () => { if (!sub.closed && !sub.writer.send({ id: String(++sub.localId), event: event.type, data: event })) this._close(sub) })
    }
  }
  async _rpc(sub, method, params) {
    const reply = await this.sendRpc(sub.deviceId, { id: randomUUID(), method, params }, sub.principal)
    if (reply?.error) throw Object.assign(new Error(reply.error.message || 'Device request failed'), { statusCode: reply.status || 400 })
    return reply?.result
  }
  _transitory(error) { return TRANSITORY.has(error?.statusCode || error?.status) }
  async _syncSession(sub, hello = false) {
    if (sub.closed) return
    if (!await sub.access()) return this._close(sub)
    let envelope
    try { envelope = await this._rpc(sub, 'events.list', { sessionId: sub.sessionId, after: sub.cursor }) }
    catch (error) {
      if (this._transitory(error)) return this._markOffline(sub)
      return this._close(sub)
    }
    if (sub.closed || !envelope) return
    this._markOnline(sub)
    // Hello/gap frames must not advance Last-Event-ID past backlog rows that
    // have not been delivered yet, so they carry the subscriber's cursor.
    if (hello) {
      sub.writer.send({ id: String(sub.cursor), event: 'connected', data: { type: 'connected', schemaVersion: PROTOCOL_VERSION, sessionId: sub.sessionId, earliest: envelope.earliest, cursor: envelope.cursor, running: envelope.running, control: envelope.control, approvals: envelope.approvals, pendingApprovalCount: envelope.pendingApprovalCount } })
      sub.lastState = { running: envelope.running, control: envelope.control, pendingApprovalCount: envelope.pendingApprovalCount }
    }
    if (envelope.gap && !sub.writer.send({ id: String(sub.cursor), event: 'replay.gap', data: { type: 'replay.gap', earliest: envelope.earliest, cursor: envelope.cursor } })) return this._close(sub)
    for (const row of envelope.events || []) {
      if (row.seq <= sub.cursor) continue
      if (!sub.writer.send({ id: String(row.seq), event: row.type, data: row })) return this._close(sub)
      sub.cursor = row.seq
    }
    const state = { running: envelope.running, control: envelope.control, pendingApprovalCount: envelope.pendingApprovalCount }
    if (!hello && JSON.stringify(state) !== JSON.stringify(sub.lastState)) {
      sub.lastState = state
      sub.writer.send({ id: String(sub.cursor), event: 'session.state', data: { type: 'session.state', sessionId: sub.sessionId, ...state } })
    }
  }
  async _deviceOffline(sub) {
    if (sub.online === false) return
    const was = sub.online
    sub.online = false
    const stopped = [...sub.active]
    sub.active.clear()
    if (was == null) return
    if (!sub.writer.send({ id: String(++sub.localId), event: 'device.offline', data: { type: 'device.offline', deviceId: sub.deviceId, timestamp: Date.now() } })) return this._close(sub)
    for (const sessionId of stopped) if (!sub.writer.send({ id: String(++sub.localId), event: 'session.status', data: { type: 'session.status', deviceId: sub.deviceId, sessionId, running: false, timestamp: Date.now() } })) return this._close(sub)
  }
  async _syncDevice(sub, hello = false) {
    if (sub.closed) return
    const access = await sub.access()
    if (!access) return this._close(sub)
    sub.grants = access.owner ? null : access.sessions
    let result
    try { result = await this._rpc(sub, 'status', {}) }
    catch (error) {
      if (this._transitory(error)) {
        if (hello) { sub.online = false; sub.writer.send({ id: String(++sub.localId), event: 'connected', data: { type: 'connected', schemaVersion: PROTOCOL_VERSION, deviceId: sub.deviceId, online: false, active: [] } }) }
        else await this._deviceOffline(sub)
        return
      }
      return this._close(sub)
    }
    if (sub.closed || !result) return
    const active = new Set(result.active || [])
    if (sub.grants) for (const sessionId of [...active]) if (!sub.grants.has(sessionId)) active.delete(sessionId)
    if (hello) {
      sub.online = true
      sub.active = active
      sub.writer.send({ id: String(++sub.localId), event: 'connected', data: { type: 'connected', schemaVersion: PROTOCOL_VERSION, deviceId: sub.deviceId, online: true, active: [...active] } })
      return
    }
    if (sub.online !== true) {
      sub.online = true
      if (!sub.writer.send({ id: String(++sub.localId), event: 'device.online', data: { type: 'device.online', deviceId: sub.deviceId, timestamp: Date.now() } })) return this._close(sub)
    }
    for (const sessionId of active) {
      if (sub.active.has(sessionId)) continue
      if (!sub.writer.send({ id: String(++sub.localId), event: 'session.status', data: { type: 'session.status', deviceId: sub.deviceId, sessionId, running: true, timestamp: Date.now() } })) return this._close(sub)
    }
    for (const sessionId of sub.active) {
      if (active.has(sessionId)) continue
      if (!sub.writer.send({ id: String(++sub.localId), event: 'session.status', data: { type: 'session.status', deviceId: sub.deviceId, sessionId, running: false, timestamp: Date.now() } })) return this._close(sub)
    }
    sub.active = active
  }
}
