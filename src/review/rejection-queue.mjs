import { ensureProjectRoot, reviewRejectionQueuePath } from "../storage/paths.mjs"
import { readJson, writeJson } from "../storage/json-store.mjs"

function now() {
  return Date.now()
}

function defaults() {
  return {
    updatedAt: now(),
    entries: []
  }
}

async function load(cwd = process.cwd()) {
  await ensureProjectRoot(cwd)
  return readJson(reviewRejectionQueuePath(cwd), defaults())
}

async function save(data, cwd = process.cwd()) {
  data.updatedAt = now()
  await writeJson(reviewRejectionQueuePath(cwd), data)
}

export async function enqueueRejection(entry, cwd = process.cwd()) {
  const data = await load(cwd)
  data.entries.push({
    id: `rej_${now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now(),
    consumed: false,
    ...entry
  })
  await save(data, cwd)
  return data.entries[data.entries.length - 1]
}

export async function listRejections(cwd = process.cwd()) {
  const data = await load(cwd)
  return data.entries.sort((a, b) => b.createdAt - a.createdAt)
}

export async function pendingRejections(cwd = process.cwd()) {
  const data = await load(cwd)
  return data.entries.filter((entry) => !entry.consumed)
}

export async function markRejectionsConsumed(ids, sessionId, cwd = process.cwd()) {
  if (!ids.length) return
  const data = await load(cwd)
  const set = new Set(ids)
  for (const entry of data.entries) {
    if (!set.has(entry.id)) continue
    entry.consumed = true
    entry.consumedAt = now()
    entry.consumedBy = sessionId
  }
  await save(data, cwd)
}

export async function clearRejections(cwd = process.cwd()) {
  await save(defaults(), cwd)
}
