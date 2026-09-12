import path from "node:path"
import { readFile, stat } from "node:fs/promises"

const fileReadState = new Map()

function normalizeFilePath(filePath) {
  return path.resolve(String(filePath || ""))
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
  fileReadState.set(normalized, {
    content: String(content ?? ""),
    timestamp: normalizeTimestamp(timestamp),
    offset: Number.isInteger(offset) ? offset : undefined,
    limit: Number.isInteger(limit) ? limit : undefined,
    isPartialView: Boolean(isPartialView)
  })
}

export function getFileReadState(filePath) {
  return fileReadState.get(normalizeFilePath(filePath)) || null
}

export function wasFileRead(filePath) {
  return fileReadState.has(normalizeFilePath(filePath))
}

export function clearFileReadState() {
  fileReadState.clear()
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
