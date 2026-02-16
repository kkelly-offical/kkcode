import path from "node:path"
import { appendFile, readdir, rename, stat, unlink } from "node:fs/promises"
import { ensureUserRoot, eventLogPath, userRootDir } from "./paths.mjs"

const state = {
  rotateMb: 32,
  retainDays: 14
}

function now() {
  return Date.now()
}

function maxBytes() {
  return Math.max(1, Number(state.rotateMb || 32)) * 1024 * 1024
}

export function configureEventLog(options = {}) {
  if (Number.isFinite(options.rotateMb) && options.rotateMb > 0) state.rotateMb = Number(options.rotateMb)
  if (Number.isFinite(options.retainDays) && options.retainDays > 0) state.retainDays = Number(options.retainDays)
}

async function maybeRotate() {
  const file = eventLogPath()
  const info = await stat(file).catch(() => null)
  if (!info || info.size < maxBytes()) return
  const rotated = path.join(userRootDir(), `events.${now()}.log`)
  await rename(file, rotated).catch(() => {})
}

async function cleanupOldLogs() {
  const cutoff = now() - Math.max(1, Number(state.retainDays || 14)) * 24 * 60 * 60 * 1000
  const entries = await readdir(userRootDir(), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.startsWith("events.") || !entry.name.endsWith(".log")) continue
    const file = path.join(userRootDir(), entry.name)
    const info = await stat(file).catch(() => null)
    if (!info) continue
    if (info.mtimeMs < cutoff) {
      await unlink(file).catch(() => {})
    }
  }
}

export async function appendEventLog(event) {
  await ensureUserRoot()
  await maybeRotate()
  await appendFile(eventLogPath(), JSON.stringify(event) + "\n", "utf8")
  await cleanupOldLogs()
}

export async function eventLogStats() {
  await ensureUserRoot()
  const root = userRootDir()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  let activeBytes = 0
  let rotatedBytes = 0
  let rotatedFiles = 0

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name === "events.log") {
      const info = await stat(path.join(root, entry.name)).catch(() => null)
      if (info) activeBytes += info.size
      continue
    }
    if (entry.name.startsWith("events.") && entry.name.endsWith(".log")) {
      rotatedFiles += 1
      const info = await stat(path.join(root, entry.name)).catch(() => null)
      if (info) rotatedBytes += info.size
    }
  }

  return {
    rotateMb: state.rotateMb,
    retainDays: state.retainDays,
    activeBytes,
    rotatedFiles,
    rotatedBytes
  }
}
