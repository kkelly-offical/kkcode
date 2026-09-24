import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { userRootDir } from "./paths.mjs"
import { acquireProcessLock } from "./process-lock.mjs"

const digest = value => createHash("sha256").update(value).digest("hex")
const stages = new Set(["planned", "applying", "applied", "receipted", "cleanup"])
const oid = value => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value)
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const treeState = state => state && oid(state.head) && oid(state.indexTree) && oid(state.worktreeTree) && sha(state.dirtyFingerprint)
const transitions = {
  planned: new Set(["planned", "applying", "applied"]),
  applying: new Set(["applying", "applied"]),
  applied: new Set(["applied", "receipted"]),
  receipted: new Set(["receipted", "cleanup"]),
  cleanup: new Set(["cleanup"])
}

/** No in-place fallback: an unsuccessful replacement leaves the previous record. */
export async function writePromotionJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, file)
    // Directory fsync is unsupported on Windows. There we retain the atomic
    // rename + flushed file guarantee; do not pretend to promise power-loss XA.
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(file), "r")
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await handle?.close()
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error })
  }
}

/** Repository-wide exclusion, including promotions from different worktrees. */
export async function acquirePromotionLock(repository) {
  // The lock belongs to the repository, not KKCODE_HOME: two hosts configured
  // with different state roots must not concurrently promote into one checkout.
  return acquireProcessLock(path.join(repository.commonDir, "kkcode-promotion.lock"))
}

/**
 * A durable journal independent of the legacy task-checkpoint projection.
 * Callers hold acquirePromotionLock across the read/transition/effect sequence.
 * A checksum detects corruption, not malicious modification by the OS user.
 */
export function openPromotionJournal(repository, taskId) {
  if (!taskId || typeof taskId !== "string") throw new Error("promotion task ID is required")
  const operationId = digest(JSON.stringify([repository.commonDir, repository.root, taskId]))
  const file = path.join(userRootDir(), "promotions", digest(repository.commonDir), `${operationId}.json`)
  const validate = record => {
    if (!record || record.operationId !== operationId || record.taskId !== taskId
      || record.repository?.root !== repository.root || record.repository?.commonDir !== repository.commonDir
      || !stages.has(record.stage) || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !treeState(record.before) || !treeState(record.candidate)
      || !oid(record.expectedAfter?.head) || !oid(record.expectedAfter?.indexTree) || !oid(record.expectedAfter?.worktreeTree)
      || !sha(record.patchHash) || !path.isAbsolute(record.worktreePath || "")
      || !Array.isArray(record.files) || record.files.some(file => typeof file !== "string")
      || typeof record.empty !== "boolean" || typeof record.keepWorktree !== "boolean"
      || (record.stage !== "planned" && !record.empty && !oid(record.snapshot))
      || (["applied", "receipted", "cleanup"].includes(record.stage) && !treeState(record.after))
      || (record.stage === "cleanup" && !["pending", "removed", "kept", "failed"].includes(record.cleanup))) {
      throw new Error("promotion journal is invalid; inspect it before recovery")
    }
  }
  const read = async () => {
    let text
    try { text = await readFile(file, "utf8") }
    catch (error) { if (error.code === "ENOENT") return null; throw error }
    let envelope
    try { envelope = JSON.parse(text) } catch { throw new Error("promotion journal is corrupt; inspect it before recovery") }
    const record = envelope?.record
    if (envelope?.format !== 1 || !record || envelope.checksum !== digest(JSON.stringify(record))) throw new Error("promotion journal checksum is invalid; inspect it before recovery")
    validate(record)
    return record
  }
  return {
    operationId,
    file,
    read,
    async write(record) {
      const previous = await read()
      validate(record)
      if (record.operationId !== operationId || record.taskId !== taskId
        || record.revision !== (previous?.revision || 0) + 1
        || !stages.has(record.stage) || (!previous && record.stage !== "planned")
        || (previous && !transitions[previous.stage].has(record.stage))) {
        throw new Error("invalid or stale promotion journal transition")
      }
      if (previous && (record.patchHash !== previous.patchHash || record.worktreePath !== previous.worktreePath)) {
        throw new Error("promotion candidate changed; previous operation must be inspected")
      }
      if (previous && previous.stage !== "planned"
        && ["before", "candidate", "expectedAfter", "snapshot", "threeway", "force", "keepWorktree", "files"].some(key => JSON.stringify(record[key]) !== JSON.stringify(previous[key]))) {
        throw new Error("promotion evidence is immutable after apply intent")
      }
      if (previous?.after && JSON.stringify(record.after) !== JSON.stringify(previous.after)) {
        throw new Error("applied promotion receipt is immutable")
      }
      await writePromotionJson(file, { format: 1, checksum: digest(JSON.stringify(record)), record })
    }
  }
}
