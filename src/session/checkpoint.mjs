import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import { readJson, writeJson } from "../storage/json-store.mjs"
import { userRootDir } from "../storage/paths.mjs"

function checkpointDir(sessionId) {
  return path.join(userRootDir(), "checkpoints", sessionId)
}

function checkpointFile(sessionId, name) {
  return path.join(checkpointDir(sessionId), `${name}.json`)
}

function latestFile(sessionId) {
  return checkpointFile(sessionId, "latest")
}

export async function saveCheckpoint(sessionId, data) {
  const dir = checkpointDir(sessionId)
  await mkdir(dir, { recursive: true })
  const checkpoint = {
    sessionId,
    savedAt: Date.now(),
    ...data
  }
  await writeJson(latestFile(sessionId), checkpoint)
  const numbered = checkpointFile(sessionId, `cp_${data.iteration || 0}`)
  await writeJson(numbered, checkpoint)
  return checkpoint
}

export async function loadCheckpoint(sessionId, name = "latest") {
  const file = name === "latest" ? latestFile(sessionId) : checkpointFile(sessionId, name)
  return readJson(file, null)
}

export async function listCheckpoints(sessionId) {
  const dir = checkpointDir(sessionId)
  const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/, ""))
    .sort()
}
