import path from "node:path"
import { createHash } from "node:crypto"
import { appendFile, chmod, readdir, rename, stat, unlink } from "node:fs/promises"
import { redactSensitive } from "../http/identity.mjs"
import { ensureUserRoot, eventLogPath, userRootDir } from "./paths.mjs"

const EVENT_CONTENT_KEYS =
  /^(?:args|body|command|content|error|messages?|new_string|old_string|output|prompt|response|system|tool_args)$/i

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

let lastCleanupAt = 0
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

function summarizeEventContent(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null)
  return {
    length: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex")
  }
}

function sanitizeRedactedEventValue(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]"
    seen.add(value)
    const output = value.map((item) => sanitizeRedactedEventValue(item, seen))
    seen.delete(value)
    return output
  }
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    const contentValue = typeof item === "string" || Boolean(item && typeof item === "object")
    output[key] = EVENT_CONTENT_KEYS.test(key) && contentValue
      ? summarizeEventContent(item)
      : sanitizeRedactedEventValue(item, seen)
  }
  seen.delete(value)
  return output
}

export function sanitizeEventForLog(event) {
  return sanitizeRedactedEventValue(redactSensitive(event))
}

export async function appendEventLog(event) {
  await ensureUserRoot()
  await maybeRotate()
  const file = eventLogPath()
  const safeEvent = sanitizeEventForLog(event)
  await appendFile(file, JSON.stringify(safeEvent) + "\n", {
    encoding: "utf8",
    mode: 0o600
  })
  // Tighten permissions on logs created by older versions as well.
  await chmod(file, 0o600).catch(() => {})
  if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
    lastCleanupAt = Date.now()
    await cleanupOldLogs()
  }
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
