import { PROTOCOL_VERSION, ProtocolError } from '../protocol/index.mjs'
import { sessionStatusFromRow } from '../http/sse.mjs'

const idPattern = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Replayable per-session SSE stream on the device server
 * (docs/remote-sse-contract.md). Replays the journal after `after`, then
 * follows the live event emitter; out-of-order/lost live rows heal through a
 * journal re-sync. The periodic tick also renews the caller's control lease,
 * preserving events.list polling semantics for stream-only clients.
 */
export function createSessionEventStream({ service, sessionId, after = 0, principal = { id: 'local', client: 'local' }, writer, syncMs = 30000 }) {
  if (!idPattern.test(sessionId)) throw new ProtocolError('invalid_session', 'Invalid session id')
  let cursor = after, closed = false, lastState = null
  let chain = Promise.resolve()
  const enqueue = operation => { chain = chain.then(operation).catch(() => writer.close()) }
  const deliverRows = rows => {
    for (const row of rows) {
      if (row.seq <= cursor) continue
      if (!writer.send({ id: String(row.seq), event: row.type, data: row })) return false
      cursor = row.seq
    }
    return true
  }
  const deliverState = state => {
    if (lastState && JSON.stringify(state) === JSON.stringify(lastState)) return
    lastState = state
    writer.send({ id: String(cursor), event: 'session.state', data: { type: 'session.state', sessionId, ...state } })
  }
  const sync = async () => {
    if (closed) return
    const envelope = await service.sessionEvents(sessionId, cursor, principal)
    if (closed) return
    if (envelope.gap && !writer.send({ id: String(cursor), event: 'replay.gap', data: { type: 'replay.gap', earliest: envelope.earliest, cursor: envelope.cursor } })) return writer.close()
    if (!deliverRows(envelope.events)) return writer.close()
    deliverState(service.sessionState(sessionId, principal))
  }
  const onRow = row => {
    if (closed || row.sessionId !== sessionId || row.seq <= cursor) return
    enqueue(async () => {
      // A queued replay/hello may have delivered this row while its live
      // callback was waiting. Recheck inside the serialized operation so a
      // stale live row cannot duplicate output or move the cursor backwards.
      if (closed || row.seq <= cursor) return
      if (row.seq > cursor + 1) return sync()
      if (!writer.send({ id: String(row.seq), event: row.type, data: row })) return writer.close()
      cursor = row.seq
      deliverState(service.sessionState(sessionId, principal))
    })
  }
  const timer = setInterval(() => enqueue(sync), syncMs)
  timer.unref?.()
  service.on('event', onRow)
  enqueue(async () => {
    const envelope = await service.sessionEvents(sessionId, cursor, principal)
    if (closed) return
    // Hello/gap frames must not advance Last-Event-ID past backlog rows that
    // have not been delivered yet, so they carry the requested cursor.
    writer.send({ id: String(cursor), event: 'connected', data: { type: 'connected', schemaVersion: PROTOCOL_VERSION, sessionId, earliest: envelope.earliest, cursor: envelope.cursor, running: envelope.running, control: envelope.control, approvals: envelope.approvals, pendingApprovalCount: envelope.pendingApprovalCount } })
    lastState = { running: envelope.running, control: envelope.control, pendingApprovalCount: envelope.pendingApprovalCount }
    if (envelope.gap && !writer.send({ id: String(cursor), event: 'replay.gap', data: { type: 'replay.gap', earliest: envelope.earliest, cursor: envelope.cursor } })) return writer.close()
    if (!deliverRows(envelope.events)) writer.close()
  })
  return {
    get closed() { return closed },
    close() {
      if (closed) return
      closed = true
      clearInterval(timer)
      service.off('event', onRow)
      writer.close()
    }
  }
}

/** Live-only device-scope stream: online snapshot, session status, settings/model events. */
export function createDeviceEventStream({ service, writer }) {
  let closed = false, localId = 0
  const active = new Map()
  for (const sessionId of service.turns.keys()) active.set(sessionId, true)
  writer.send({ id: String(++localId), event: 'connected', data: { type: 'connected', schemaVersion: PROTOCOL_VERSION, deviceId: service.metadata.id, online: true, active: [...active.keys()] } })
  const onRow = row => {
    if (closed) return
    const status = sessionStatusFromRow(row)
    if (!status || active.get(status.sessionId) === status.running) return
    active.set(status.sessionId, status.running)
    if (!writer.send({ id: String(++localId), event: 'session.status', data: { type: 'session.status', deviceId: service.metadata.id, ...status, timestamp: row.timestamp } })) close()
  }
  const onDevice = event => { if (!closed && !writer.send({ id: String(++localId), event: event.type, data: event })) close() }
  service.on('event', onRow)
  service.on('device', onDevice)
  function close() {
    if (closed) return
    closed = true
    service.off('event', onRow)
    service.off('device', onDevice)
    writer.close()
  }
  return { get closed() { return closed }, close }
}
