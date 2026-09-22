export const PROTOCOL_VERSION = '1'
export const DEFAULT_PORT = 18271

/**
 * Remote real-time event contract (docs/remote-sse-contract.md). SSE streams
 * are additive transports over the existing replay journal: session streams
 * deliver the same rows `events.list` returns, keyed by the per-session `seq`
 * cursor, so `Last-Event-ID` reconnection replay and request dedup keep their
 * existing semantics. Nothing here changes the headless JSONL schema.
 */
export const SSE_RETRY_MS = 2000
export const SSE_KEEPALIVE_MS = 15000
export const SSE_MAX_BUFFERED_BYTES = 2 * 1024 * 1024
/** Relay `register` feature flag: the device pushes journal rows upstream as
 * `{type:'event', event:<row>}` and device-scope events as `{type:'device-event', event}`.
 * Older peers omit/ignore these messages; receivers fall back to journal sync. */
export const RELAY_FEATURE_EVENT_PUSH = 'events.push'
/** Control frames every SSE stream may emit (not journal rows). */
export const SSE_CONTROL_TYPES = Object.freeze(['connected', 'replay.gap', 'session.state'])
/** Device-scope status events on the device stream (and relay `device-event`). */
export const DEVICE_EVENT_TYPES = Object.freeze(['device.online', 'device.offline', 'session.status', 'settings.updated', 'models.updated', 'mcp.loaded'])
/** Turn lifecycle row types that determine whether a session is running. */
export const SESSION_RUNNING_TYPES = Object.freeze(['turn.start', 'turn.auto_continue'])
export const SESSION_IDLE_TYPES = Object.freeze(['turn.finish', 'turn.result', 'turn.failed'])
export const DEVICE_METHODS = Object.freeze([
  'status', 'folders.list', 'files.read', 'sessions.list', 'sessions.get', 'sessions.create', 'sessions.configure',
  'turns.start', 'turns.cancel', 'events.list', 'control.acquire', 'control.release',
  'approvals.resolve', 'commands.list', 'commands.run', 'settings.get', 'settings.update',
  'extensions.list', 'extensions.reload', 'models.discover', 'profile.get', 'profile.update',
  'attachments.upload', 'attachments.list', 'attachments.remove', 'branches.list', 'branches.switch', 'branches.create'
])
export class ProtocolError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}
export function validateRequest(request) {
  if (!request || typeof request !== 'object' || !DEVICE_METHODS.includes(request.method)) throw new ProtocolError('unknown_method', 'Unsupported device operation')
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id)) throw new ProtocolError('invalid_id', 'A unique request id is required')
  if (request.params != null && (typeof request.params !== 'object' || Array.isArray(request.params))) throw new ProtocolError('invalid_params', 'params must be an object')
  if (request.issuedAt != null && (!Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0 || request.issuedAt > Date.now() + 5 * 60000)) throw new ProtocolError('invalid_request_time', 'Request timestamp is invalid or too far in the future')
  return request
}
