/** Host-owned durable task contracts. These APIs are not model tool endpoints. */
export const RUN_STORE_SCHEMA_VERSION = 2
export const RUN_STATES = Object.freeze(['running', 'waiting_input', 'waiting_approval', 'paused', 'verification_failed', 'outcome_unknown', 'cancelled', 'completed'])
export const ACTION_STATES = Object.freeze(['prepared', 'succeeded', 'failed', 'unknown', 'not_applied'])

/** @param {string} code @param {string} message @returns {Error & {code: string}} */
export function runStoreError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw runStoreError('INVALID_INPUT', `${label} must be an object`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw runStoreError('INVALID_INPUT', `${label}: unsupported field ${key}`)
  return value
}

export function text(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw runStoreError('INVALID_INPUT', `${label} must be nonempty text (up to ${max} characters)`)
  return value
}

export function id(value, label = 'id') {
  text(value, label, 160)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)) throw runStoreError('INVALID_INPUT', `${label} contains unsupported characters`)
  return value
}

export function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw runStoreError('INVALID_INPUT', `${label} must be an integer between ${min} and ${max}`)
  return value
}

export function oneOf(value, values, label) {
  if (!values.includes(value)) throw runStoreError('INVALID_INPUT', `${label} is unsupported`)
  return value
}

export function strings(value, label, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems) throw runStoreError('INVALID_INPUT', `${label} must be an array with at most ${maxItems} items`)
  return value.map(entry => text(entry, label))
}

export function hash(value, label = 'hash') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw runStoreError('INVALID_INPUT', `${label} must be a SHA-256 hex digest`)
  return value
}

export function validateTaskContract(value) {
  object(value, ['objective', 'nonGoals', 'allowedPaths', 'allowedTools', 'allowedNetworkOrigins', 'allowedExternalActions', 'requiredCriteria'], 'contract')
  text(value.objective, 'contract.objective', 32_768)
  if (!Array.isArray(value.requiredCriteria) || value.requiredCriteria.length > 100) throw runStoreError('INVALID_INPUT', 'contract.requiredCriteria must be an explicit array with at most 100 criteria')
  const seen = new Set()
  const requiredCriteria = value.requiredCriteria.map(entry => {
    object(entry, ['id', 'description'], 'criterion')
    id(entry.id, 'criterion.id')
    text(entry.description, 'criterion.description')
    if (seen.has(entry.id)) throw runStoreError('INVALID_INPUT', 'criterion IDs must be unique')
    seen.add(entry.id)
    return { id: entry.id, description: entry.description }
  })
  return {
    objective: value.objective,
    nonGoals: strings(value.nonGoals ?? [], 'contract.nonGoals'),
    allowedPaths: strings(value.allowedPaths ?? [], 'contract.allowedPaths'),
    allowedTools: strings(value.allowedTools ?? [], 'contract.allowedTools').map(tool => id(tool, 'contract.allowedTools')),
    allowedNetworkOrigins: strings(value.allowedNetworkOrigins ?? [], 'contract.allowedNetworkOrigins').map(origin => {
      let url
      try { url = new URL(origin) } catch { throw runStoreError('INVALID_INPUT', 'Network grants must be explicit HTTP(S) origins') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || origin.includes('*')) throw runStoreError('INVALID_INPUT', 'Network grants cannot contain credentials, paths, wildcards, queries or fragments')
      return url.origin
    }),
    allowedExternalActions: strings(value.allowedExternalActions ?? [], 'contract.allowedExternalActions'),
    requiredCriteria
  }
}

export function validateAction(value) {
  object(value, ['id', 'kind', 'target', 'parameterHash', 'effect', 'retryPolicy', 'context'], 'action')
  if (value.effect !== 'read' && value.retryPolicy === 'safe') throw runStoreError('INVALID_INPUT', 'Side effects cannot be classified as unconditionally safe to retry')
  let context
  if (value.context !== undefined) {
    object(value.context, ['sessionId', 'turnId', 'invocationId', 'durableTurnId'], 'action.context')
    context = { sessionId: id(value.context.sessionId, 'action.context.sessionId'), turnId: id(value.context.turnId, 'action.context.turnId'), invocationId: text(value.context.invocationId, 'action.context.invocationId', 512), durableTurnId: id(value.context.durableTurnId, 'action.context.durableTurnId') }
  }
  return {
    id: id(value.id, 'action.id'),
    kind: text(value.kind, 'action.kind', 160),
    target: text(value.target, 'action.target'),
    parameterHash: hash(value.parameterHash, 'action.parameterHash'),
    effect: oneOf(value.effect, ['read', 'local_write', 'external_write'], 'action.effect'),
    retryPolicy: oneOf(value.retryPolicy, ['safe', 'idempotent', 'reconcile', 'never'], 'action.retryPolicy'),
    ...(context ? { context } : {})
  }
}

export function validateVerification(value) {
  object(value, ['id', 'criterionId', 'candidateHash', 'status', 'evidenceRefs'], 'verification')
  return {
    id: id(value.id, 'verification.id'),
    criterionId: id(value.criterionId, 'verification.criterionId'),
    candidateHash: hash(value.candidateHash, 'verification.candidateHash'),
    status: oneOf(value.status, ['passed', 'failed', 'unknown', 'not_applicable'], 'verification.status'),
    evidenceRefs: strings(value.evidenceRefs ?? [], 'verification.evidenceRefs')
  }
}

export function validateRunBinding(value) {
  object(value, ['sessionId', 'cwd', 'accountId', 'projectId', 'contractApprovalRef', 'importedSessionRef'], 'binding')
  const binding = {
    sessionId: id(value.sessionId, 'binding.sessionId'),
    cwd: text(value.cwd, 'binding.cwd'),
    accountId: text(value.accountId, 'binding.accountId', 160),
    projectId: text(value.projectId, 'binding.projectId', 160)
  }
  for (const key of ['contractApprovalRef', 'importedSessionRef']) if (value[key] !== undefined) binding[key] = text(value[key], `binding.${key}`, 256)
  return binding
}
