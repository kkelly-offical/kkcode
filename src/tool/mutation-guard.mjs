import { readFile, stat } from "node:fs/promises"
import { getFileReadState, extractTrackedView } from "./file-read-state.mjs"

function missingReadMessage(displayPath, operation) {
  return `error: "${displayPath}" has not been read yet. Read it first before ${operation}.`
}

function partialReadMessage(displayPath, operation) {
  return `error: "${displayPath}" was only partially read. Read the full file before ${operation}.`
}

function staleReadMessage(displayPath, operation) {
  return `error: "${displayPath}" has changed since it was last read. Read it again before ${operation}.`
}

function missingFileMessage(displayPath, operation) {
  return `error: "${displayPath}" no longer exists. Re-read the latest workspace state before ${operation}.`
}

export async function validateExistingFileMutation({
  targetPath,
  displayPath,
  operation,
  requireFullRead = false
}) {
  const readState = getFileReadState(targetPath)
  const label = String(displayPath || targetPath)
  const action = String(operation || "modifying it")

  if (!readState) {
    return { ok: false, reason: "unread", message: missingReadMessage(label, action) }
  }

  if (requireFullRead && readState.isPartialView) {
    return { ok: false, reason: "partial_read", message: partialReadMessage(label, action) }
  }

  try {
    const fileStat = await stat(targetPath)
    const currentTimestamp = Math.floor(fileStat.mtimeMs)
    const currentContent = await readFile(targetPath, "utf8")
    const currentTrackedView = extractTrackedView(currentContent, readState)
    if (currentTrackedView === readState.content) {
      return { ok: true, readState, currentTimestamp, currentContent }
    }

    return { ok: false, reason: "stale", message: staleReadMessage(label, action) }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, reason: "missing", message: missingFileMessage(label, action) }
    }
    throw error
  }
}
