import { ensureUserRoot, usageStorePath } from "../storage/paths.mjs"
import { readJson, writeJson } from "../storage/json-store.mjs"

export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0
  }
}

function addUsage(target, delta, cost) {
  target.input += delta.input || 0
  target.output += delta.output || 0
  target.cacheRead += delta.cacheRead || 0
  target.cacheWrite += delta.cacheWrite || 0
  target.cost += cost || 0
  target.turns += 1
}

function defaultStore() {
  return {
    updatedAt: Date.now(),
    global: emptyUsage(),
    sessions: {}
  }
}

export async function readUsageStore() {
  await ensureUserRoot()
  return readJson(usageStorePath(), defaultStore())
}

async function persist(store) {
  store.updatedAt = Date.now()
  await writeJson(usageStorePath(), store)
}

export async function recordTurn({ sessionId, usage, cost }) {
  const store = await readUsageStore()
  if (!store.sessions[sessionId]) store.sessions[sessionId] = emptyUsage()
  addUsage(store.sessions[sessionId], usage, cost)
  addUsage(store.global, usage, cost)
  await persist(store)
  return {
    turn: {
      input: usage.input || 0,
      output: usage.output || 0,
      cacheRead: usage.cacheRead || 0,
      cacheWrite: usage.cacheWrite || 0,
      cost: cost || 0,
      turns: 1
    },
    session: store.sessions[sessionId],
    global: store.global
  }
}

export async function resetUsage(sessionId = null) {
  if (!sessionId) {
    await persist(defaultStore())
    return
  }
  const store = await readUsageStore()
  delete store.sessions[sessionId]
  store.global = emptyUsage()
  for (const session of Object.values(store.sessions)) {
    store.global.input += session.input
    store.global.output += session.output
    store.global.cacheRead += session.cacheRead
    store.global.cacheWrite += session.cacheWrite
    store.global.cost += session.cost
    store.global.turns += session.turns
  }
  await persist(store)
}

export async function exportUsageCsv() {
  const store = await readUsageStore()
  const rows = [["scope", "sessionId", "input", "output", "cacheRead", "cacheWrite", "cost", "turns"]]
  rows.push([
    "global",
    "",
    store.global.input,
    store.global.output,
    store.global.cacheRead,
    store.global.cacheWrite,
    store.global.cost,
    store.global.turns
  ])
  for (const [sessionId, usage] of Object.entries(store.sessions)) {
    rows.push(["session", sessionId, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost, usage.turns])
  }
  return rows.map((row) => row.join(",")).join("\n") + "\n"
}
