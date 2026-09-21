export const PROTOCOL_VERSION = '1'
export const DEFAULT_PORT = 18271
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
