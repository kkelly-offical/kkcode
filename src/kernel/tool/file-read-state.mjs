import path from "node:path"
import { readFile, stat } from "node:fs/promises"
import { currentRuntime, runtimeCwd } from "../core/runtime-context.mjs"

// A read receipt is volatile authority for this kernel, session and workspace,
// not a fact that may be reconstructed from a transcript or summary. Restarting
// the process/kernel intentionally requires reading again. The legacy map is
// only for callers outside a runtime; it is never a fallback inside a kernel.
const legacyFileReadState = new Map()
const kernelFileReadStates = new WeakMap()

function readStates() {
  const runtime = currentRuntime()
  if (!runtime) return legacyFileReadState
  // executeTurn creates shallow runtime copies; the registry identity remains
  // stable across turns but differs between independently created kernels.
  const owner = runtime.tools || runtime
  let scopes = kernelFileReadStates.get(owner)
  if (!scopes) { scopes = new Map(); kernelFileReadStates.set(owner, scopes) }
  const key = JSON.stringify([path.resolve(runtimeCwd()), runtime.sessionId ?? null])
  let scope = scopes.get(key)
  if (!scope) { scope = new Map(); scopes.set(key, scope) }
  return scope
}

function normalizeFilePath(filePath) {
  return path.resolve(runtimeCwd(), String(filePath || ""))
}

function normalizeTimestamp(timestamp) {
  const value = Number(timestamp)
  return Number.isFinite(value) ? Math.floor(value) : Date.now()
}

export function markFileRead(filePath, {
  content = "",
  timestamp = Date.now(),
  offset = undefined,
  limit = undefined,
  isPartialView = false
} = {}) {
  const normalized = normalizeFilePath(filePath)
  readStates().set(normalized, Object.freeze({
    content: String(content ?? ""),
    timestamp: normalizeTimestamp(timestamp),
    offset: Number.isInteger(offset) ? offset : undefined,
    limit: Number.isInteger(limit) ? limit : undefined,
    isPartialView: Boolean(isPartialView)
  }))
}

export function getFileReadState(filePath) {
  return readStates().get(normalizeFilePath(filePath)) || null
}

export function wasFileRead(filePath) {
  return readStates().has(normalizeFilePath(filePath))
}

export function clearFileReadState() {
  readStates().clear()
}

export function extractTrackedView(content, readState) {
  const text = String(content ?? "")
  if (!readState?.isPartialView) return text
  const startLine = Math.max(1, Number(readState.offset) || 1)
  const lines = text.split("\n")
  const sliceLength = Math.max(1, Number(readState.limit) || lines.length)
  return lines.slice(startLine - 1, startLine - 1 + sliceLength).join("\n")
}

export async function refreshFileReadStateFromDisk(filePath, {
  content = undefined
} = {}) {
  const normalized = normalizeFilePath(filePath)
  const nextContent = content === undefined ? await readFile(normalized, "utf8") : String(content)
  const fileStat = await stat(normalized)
  markFileRead(normalized, {
    content: nextContent,
    timestamp: fileStat.mtimeMs,
    isPartialView: false
  })
  return getFileReadState(normalized)
}
