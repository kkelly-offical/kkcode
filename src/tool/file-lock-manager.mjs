import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, open, unlink, writeFile } from "node:fs/promises"
import { userRootDir } from "../storage/paths.mjs"

const LOCK_POLL_MS = 80

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lockDir() {
  return path.join(userRootDir(), "locks")
}

function lockFilePath(targetPath) {
  const absolute = path.resolve(targetPath)
  const hash = createHash("sha1").update(absolute).digest("hex")
  return path.join(lockDir(), `${hash}.lock`)
}

async function ensureLockDir() {
  await mkdir(lockDir(), { recursive: true })
}

export async function acquireFileLock({
  targetPath,
  owner = "unknown",
  waitTimeoutMs = 120000
}) {
  await ensureLockDir()
  const lockFile = lockFilePath(targetPath)
  const started = Date.now()
  while (Date.now() - started <= waitTimeoutMs) {
    try {
      const fd = await open(lockFile, "wx")
      const metadata = {
        owner,
        pid: process.pid,
        targetPath: path.resolve(targetPath),
        acquiredAt: Date.now()
      }
      await fd.writeFile(JSON.stringify(metadata, null, 2), "utf8")
      await fd.close()
      return {
        lockFile,
        owner,
        acquiredAt: metadata.acquiredAt
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      await sleep(LOCK_POLL_MS)
    }
  }
  const err = new Error(`file lock timeout: ${targetPath}`)
  err.code = "LOCK_TIMEOUT"
  throw err
}

export async function releaseFileLock(lockHandle) {
  if (!lockHandle?.lockFile) return
  await unlink(lockHandle.lockFile).catch(() => {})
}

export async function withFileLock({
  targetPath,
  owner = "unknown",
  waitTimeoutMs = 120000,
  run
}) {
  const lock = await acquireFileLock({ targetPath, owner, waitTimeoutMs })
  try {
    return await run()
  } finally {
    await releaseFileLock(lock)
  }
}

export async function writeLockDebug(targetPath, owner = "unknown") {
  await ensureLockDir()
  const infoFile = `${lockFilePath(targetPath)}.meta`
  await writeFile(infoFile, JSON.stringify({ owner, at: Date.now() }, null, 2), "utf8")
  return infoFile
}

