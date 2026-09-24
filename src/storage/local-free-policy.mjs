import { createHash } from 'node:crypto'
import { object, text, integer, hash, oneOf, runStoreError } from './run-store-contracts.mjs'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value

export function localFreePolicyId(value) {
  const { id: _id, ...body } = value
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')
}

/** Storage metadata only. This schema is not a grant or proof that a listener
 * exists: the trusted host must separately verify its branded local authority. */
export function normalizeLocalFreePolicy(input) {
  object(input, ['version', 'id', 'provider', 'model', 'protocol', 'baseUrl', 'scopeHash', 'maxRequests', 'maxTokens', 'listener'], 'localFreePolicy')
  if (input.version !== 1) throw runStoreError('INVALID_LOCAL_FREE_POLICY', 'Local free inference policies require version 1')
  const baseUrl = text(input.baseUrl, 'localFreePolicy.baseUrl', 4096)
  let url
  try { url = new URL(baseUrl) } catch { throw runStoreError('INVALID_LOCAL_FREE_POLICY', 'Local free inference requires a canonical literal loopback URL') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || baseUrl.includes('?') || baseUrl.includes('#') || url.href !== baseUrl) {
    throw runStoreError('INVALID_LOCAL_FREE_POLICY', 'Local free inference requires a canonical literal loopback URL without credentials, query or fragment')
  }
  object(input.listener, ['pid', 'uid', 'fd', 'inode', 'startTimeTicks', 'executable'], 'localFreePolicy.listener')
  const decimal = (value, label) => {
    text(value, label, 32)
    if (!/^\d+$/.test(value)) throw runStoreError('INVALID_LOCAL_FREE_POLICY', `${label} must be a decimal identifier`)
    return value
  }
  const policy = {
    version: 1,
    provider: text(input.provider, 'localFreePolicy.provider', 200), model: text(input.model, 'localFreePolicy.model', 256),
    protocol: oneOf(input.protocol, ['openai', 'anthropic', 'responses', 'ollama'], 'localFreePolicy.protocol'), baseUrl,
    scopeHash: hash(input.scopeHash, 'localFreePolicy.scopeHash'),
    maxRequests: integer(input.maxRequests, 'localFreePolicy.maxRequests', 1, 10000),
    maxTokens: integer(input.maxTokens, 'localFreePolicy.maxTokens', 1, 10_000_000_000),
    listener: { pid: integer(input.listener.pid, 'listener.pid', 1), uid: integer(input.listener.uid, 'listener.uid'),
      fd: integer(input.listener.fd, 'listener.fd'), inode: decimal(input.listener.inode, 'listener.inode'),
      startTimeTicks: decimal(input.listener.startTimeTicks, 'listener.startTimeTicks'), executable: text(input.listener.executable, 'listener.executable', 4096) }
  }
  const id = localFreePolicyId(policy)
  if (hash(input.id, 'localFreePolicy.id') !== id) throw runStoreError('INVALID_LOCAL_FREE_POLICY', 'Local free policy ID does not match its frozen fields')
  return { ...policy, id }
}
