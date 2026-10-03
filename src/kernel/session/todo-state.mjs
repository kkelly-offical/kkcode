import { randomUUID } from 'node:crypto'

/** Authored planning state, never a verification receipt or execution authority. */
export const TODO_STATES = Object.freeze(['pending', 'in_progress', 'completed', 'blocked', 'cancelled'])
const identity = /^[A-Za-z0-9_-]{1,128}$/
const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_ITEMS = 100
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: code === 'todo_conflict' ? 409 : 400 }) }
function id(value, label = 'identity') {
  if (typeof value !== 'string' || !identity.test(value) || forbidden.has(value)) fail('todo_invalid', `Invalid todo ${label}`)
  return value
}
function agentIdentity(value) {
  // Agent names are labels (including plugin:name and localized roles), never
  // filesystem segments. Keep them bounded and free of control/path syntax.
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128 || forbidden.has(value)
      || /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('todo_invalid', 'Invalid todo agent identity')
  return value
}
function object(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('todo_invalid', `Invalid todo ${label}`)
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('todo_invalid', `Invalid todo ${label}`)
  return value.trim()
}
function references(value = []) {
  if (!Array.isArray(value) || value.length > 32) fail('todo_invalid', 'Todo evidence references must be a bounded array')
  const seen = new Set()
  return value.map(reference => {
    object(reference, ['kind', 'id'], 'evidence reference')
    if (!['message', 'part'].includes(reference.kind)) fail('todo_invalid', 'Todo evidence must reference a conversation message or part, not a path or verification claim')
    id(reference.id, 'evidence reference')
    const key = `${reference.kind}:${reference.id}`
    if (seen.has(key)) fail('todo_invalid', 'Duplicate todo evidence reference')
    seen.add(key)
    return { kind: reference.kind, id: reference.id }
  })
}
function dependencies(value = []) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS || new Set(value).size !== value.length) fail('todo_invalid', 'Invalid todo dependencies')
  return value.map(value => id(value, 'dependency'))
}
function graph(items) {
  const byId = new Map(items.map(item => [item.id, item])), seen = new Set(), visiting = new Set()
  if (byId.size !== items.length) fail('todo_invalid', 'Duplicate todo id')
  function visit(item) {
    if (visiting.has(item.id)) fail('todo_invalid', 'Todo dependencies contain a cycle')
    if (seen.has(item.id)) return
    visiting.add(item.id)
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency)) fail('todo_scope', 'Todo dependency does not belong to this session')
      visit(byId.get(dependency))
    }
    visiting.delete(item.id); seen.add(item.id)
  }
  for (const item of items) visit(item)
}

export function emptyTodoSnapshot(sessionId) {
  return { version: 1, sessionId: id(sessionId, 'session'), revision: 0, items: [], updatedAt: 0,
    source: { kind: 'initial', agentId: 'main', turnId: null, previousRevision: 0 } }
}

function validateSnapshot(snapshot, sessionId) {
  object(snapshot, ['version', 'sessionId', 'revision', 'items', 'updatedAt', 'source'], 'snapshot')
  if (snapshot.version !== 1 || snapshot.sessionId !== sessionId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || !Number.isSafeInteger(snapshot.updatedAt) || snapshot.updatedAt < 0 || !Array.isArray(snapshot.items) || snapshot.items.length > MAX_ITEMS) fail('todo_storage', 'Todo snapshot is invalid or belongs to another session')
  object(snapshot.source, ['kind', 'agentId', 'turnId', 'previousRevision', 'restoredRevision'], 'source')
  if (!['initial', 'update', 'rewind'].includes(snapshot.source.kind) || !Number.isSafeInteger(snapshot.source.previousRevision)
      || snapshot.source.previousRevision !== Math.max(0, snapshot.revision - 1) || (snapshot.source.kind === 'initial') !== (snapshot.revision === 0)
      || snapshot.source.kind !== 'rewind' && snapshot.source.restoredRevision !== undefined) fail('todo_storage', 'Todo history revision chain is invalid')
  agentIdentity(snapshot.source.agentId)
  if (snapshot.source.turnId !== null) id(snapshot.source.turnId, 'turn')
  if (snapshot.source.kind === 'rewind' && (!Number.isSafeInteger(snapshot.source.restoredRevision) || snapshot.source.restoredRevision < 0 || snapshot.source.restoredRevision >= snapshot.revision)) fail('todo_storage', 'Todo rewind target is invalid')
  for (const item of snapshot.items) {
    object(item, ['id', 'content', 'activeForm', 'status', 'reason', 'owner', 'dependencies', 'evidenceRefs', 'revision', 'createdAt', 'updatedAt'], 'item')
    id(item.id, 'id'); text(item.content, 2048, 'content')
    if (item.activeForm !== undefined) text(item.activeForm, 256, 'active form')
    if (item.reason !== undefined) text(item.reason, 512, 'reason')
    object(item.owner, ['sessionId', 'agentId'], 'owner')
    if (item.owner.sessionId !== sessionId || !TODO_STATES.includes(item.status) || !Number.isSafeInteger(item.revision) || item.revision < 1
        || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < item.createdAt) fail('todo_storage', 'Todo item metadata is invalid')
    agentIdentity(item.owner.agentId); dependencies(item.dependencies); references(item.evidenceRefs)
  }
  graph(snapshot.items)
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) fail('todo_invalid', 'Todo snapshot is too large')
  return snapshot
}

/** Reconstruct independently of event retention in remote transports. A malformed
 * canonical event fails closed; it is not silently interpreted as an empty list. */
export function readTodoSnapshot(parts, sessionId) {
  let snapshot = emptyTodoSnapshot(sessionId)
  for (const part of parts || []) {
    if (part.type !== 'todo.updated') continue
    const next = validateSnapshot(part.snapshot, sessionId)
    if (next.revision !== snapshot.revision + 1) fail('todo_storage', 'Todo history has a missing or duplicate revision')
    snapshot = next
  }
  return structuredClone(snapshot)
}

/** Called inside the session store transaction. Only the current agent's items
 * may be edited. Omitted own items become cancelled, never silently disappear.
 * @param {any} previous @param {any} input
 * @param {{sessionId: string, agentId?: string, turnId?: string | null, now?: number, messages?: any[], parts?: any[]}} options */
export function reduceTodoSnapshot(previous, input, { sessionId, agentId = 'main', turnId = null, now = Date.now(), messages = [], parts = [] }) {
  id(sessionId, 'session'); agentIdentity(agentId); if (turnId !== null) id(turnId, 'turn')
  validateSnapshot(previous, sessionId)
  object(input, ['todos', 'expectedRevision', 'mode'], 'update')
  if (input.mode !== undefined && !['merge', 'replace'].includes(input.mode)) fail('todo_invalid', 'Todo mode must be merge or replace')
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('todo_invalid', 'A todo expectedRevision is required')
  if (input.expectedRevision !== previous.revision) fail('todo_conflict', `Todo revision changed (expected ${input.expectedRevision}, current ${previous.revision}); read the current list before retrying`)
  if (!Array.isArray(input.todos) || input.todos.length > MAX_ITEMS) fail('todo_invalid', 'Todo list must contain at most 100 items')
  const timestamp = Math.max(now, previous.updatedAt), used = new Set(), prior = new Map(previous.items.map(item => [item.id, item]))
  const available = { message: new Set(messages.map(item => item.id)), part: new Set(parts.map(item => item.id)) }
  const items = input.todos.map(raw => {
    object(raw, ['id', 'content', 'activeForm', 'status', 'reason', 'dependencies', 'evidenceRefs'], 'input item')
    const content = text(raw.content, 2048, 'content')
    if (!TODO_STATES.includes(raw.status)) fail('todo_invalid', 'Invalid todo status')
    // Legacy callers without IDs preserve identity by exact unique description.
    // Ambiguous duplicate descriptions require explicit IDs rather than guessing.
    const matches = raw.id === undefined ? previous.items.filter(item => item.owner.agentId === agentId && item.content === content && !used.has(item.id)) : []
    if (matches.length > 1) fail('todo_invalid', 'Ambiguous todo content; specify the stable item id')
    const existing = raw.id === undefined ? matches[0] : prior.get(id(raw.id, 'id'))
    if (raw.id !== undefined && !existing) fail('todo_scope', 'Todo id does not belong to this session')
    if (existing && existing.owner.agentId !== agentId) fail('todo_scope', 'Todo belongs to another agent')
    const todoId = existing?.id || `todo_${randomUUID().replaceAll('-', '')}`
    if (used.has(todoId)) fail('todo_invalid', 'Duplicate todo id')
    used.add(todoId)
    const evidenceRefs = references(raw.evidenceRefs ?? existing?.evidenceRefs)
    for (const reference of evidenceRefs) {
      if (!available[reference.kind].has(reference.id)) fail('todo_scope', 'Todo evidence does not belong to the current conversation')
    }
    const value = { id: todoId, content, ...(raw.activeForm === undefined ? existing?.activeForm ? { activeForm: existing.activeForm } : {} : { activeForm: text(raw.activeForm, 256, 'active form') }),
      status: raw.status, ...(raw.reason !== undefined ? {reason: text(raw.reason, 512, 'reason')} : existing?.status === raw.status && existing.reason ? {reason: existing.reason} : {}),
      owner: { sessionId, agentId }, dependencies: dependencies(raw.dependencies ?? existing?.dependencies), evidenceRefs,
      revision: existing ? existing.revision + 1 : 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp }
    if (existing && JSON.stringify({ ...value, revision: existing.revision, updatedAt: existing.updatedAt }) === JSON.stringify(existing)) return structuredClone(existing)
    return value
  })
  for (const item of previous.items) {
    if (used.has(item.id)) continue
    items.push(input.mode !== 'merge' && item.owner.agentId === agentId && !['completed', 'cancelled'].includes(item.status)
      ? { ...structuredClone(item), status: 'cancelled', revision: item.revision + 1, updatedAt: timestamp } : structuredClone(item))
  }
  if (items.length > MAX_ITEMS) fail('todo_invalid', 'Todo history contains 100 items; update existing items instead of replacing their identities')
  if (input.mode === 'merge') {
    const order = new Map(previous.items.map((item, index) => [item.id, index]))
    items.sort((a, b) => (order.get(a.id) ?? previous.items.length) - (order.get(b.id) ?? previous.items.length))
  }
  graph(items)
  return validateSnapshot({ version: 1, sessionId, revision: previous.revision + 1, items, updatedAt: timestamp,
    source: { kind: 'update', agentId, turnId, previousRevision: previous.revision } }, sessionId)
}

/** Preserve the complete journal and append a monotonically newer restoration.
 * Repeated rewinds follow restoration links rather than reviving undone updates. */
export function rewindTodoSnapshot(parts, sessionId, { removedTurnIds = [], cutoff = Infinity, now = Date.now() } = {}) {
  const current = readTodoSnapshot(parts, sessionId)
  if (!current.revision) return null
  const history = new Map([[0, emptyTodoSnapshot(sessionId)], ...parts.filter(part => part.type === 'todo.updated').map(part => [part.snapshot.revision, part.snapshot])])
  const removed = new Set(removedTurnIds)
  let target = current
  while (target.revision) {
    if (target.source.kind === 'rewind') { target = history.get(target.source.restoredRevision); continue }
    if (target.source.turnId ? removed.has(target.source.turnId) : target.updatedAt >= cutoff) { target = history.get(target.source.previousRevision); continue }
    break
  }
  const values = items => JSON.stringify(items.map(({ revision: _revision, updatedAt: _updatedAt, ...item }) => item))
  if (values(target.items) === values(current.items)) return null
  const timestamp = Math.max(now, current.updatedAt)
  const maxRevisions = new Map()
  for (const snapshot of history.values()) for (const item of snapshot.items) maxRevisions.set(item.id, Math.max(maxRevisions.get(item.id) || 0, item.revision))
  return validateSnapshot({ version: 1, sessionId, revision: current.revision + 1,
    items: target.items.map(item => ({ ...structuredClone(item), revision: maxRevisions.get(item.id) + 1, updatedAt: timestamp })), updatedAt: timestamp,
    source: { kind: 'rewind', agentId: 'main', turnId: null, previousRevision: current.revision, restoredRevision: target.revision } }, sessionId)
}
