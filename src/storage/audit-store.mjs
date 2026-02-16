import { ensureUserRoot, auditStorePath } from "./paths.mjs"
import { readJson, writeJson } from "./json-store.mjs"

const state = {
  maxEntries: 5000
}

function defaults() {
  return {
    updatedAt: Date.now(),
    entries: []
  }
}

export function configureAuditStore(options = {}) {
  if (Number.isInteger(options.maxEntries) && options.maxEntries > 100) {
    state.maxEntries = options.maxEntries
  }
}

export async function readAuditStore() {
  await ensureUserRoot()
  return readJson(auditStorePath(), defaults())
}

export async function appendAuditEntry(entry) {
  const store = await readAuditStore()
  store.entries.push({
    id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    ...entry
  })
  if (store.entries.length > state.maxEntries) {
    store.entries = store.entries.slice(-state.maxEntries)
  }
  store.updatedAt = Date.now()
  await writeJson(auditStorePath(), store)
  return store.entries[store.entries.length - 1]
}

export async function listAuditEntries(options = {}) {
  const store = await readAuditStore()

  const query = typeof options === "number" ? { limit: options } : options
  const limit = Math.max(1, Number(query.limit || 200))
  const sessionId = query.sessionId || null
  const tool = query.tool || null
  const type = query.type || null
  const sinceMs = query.sinceMs || null

  const list = store.entries.filter((entry) => {
    if (sessionId && entry.sessionId !== sessionId) return false
    if (tool && entry.tool !== tool) return false
    if (type && entry.type !== type) return false
    if (sinceMs && entry.createdAt < sinceMs) return false
    return true
  })

  return list.slice(-limit).reverse()
}

export async function auditStats() {
  const store = await readAuditStore()
  const now = Date.now()
  const oneHour = now - 60 * 60 * 1000
  const oneDay = now - 24 * 60 * 60 * 1000

  let error1h = 0
  let error24h = 0
  for (const entry of store.entries) {
    const isError = String(entry.type || "").includes("error") || entry.ok === false
    if (!isError) continue
    if (entry.createdAt >= oneHour) error1h += 1
    if (entry.createdAt >= oneDay) error24h += 1
  }

  return {
    total: store.entries.length,
    error1h,
    error24h,
    maxEntries: state.maxEntries
  }
}
