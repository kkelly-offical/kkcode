import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { acquirePromotionLock, openPromotionJournal, writePromotionJson } from "../../storage/promotion-journal.mjs"
import { backgroundTaskCheckpointPath } from "../../storage/paths.mjs"
import * as git from "../../util/git.mjs"

// 与 background-worker 的 copyWorkspaceConfigFiles 保持一致：这些文件是 worker
// 复制进 worktree 的运行配置，不是子智能体的产出，回收时必须排除。
const WORKTREE_CONFIG_EXCLUDES = [
  "kkcode.config.json",
  "kkcode.config.yaml",
  ".kkcode/config.json",
  ".kkcode/config.yaml"
]

const TERMINAL_STATES = new Set(["completed", "cancelled", "error", "interrupted"])

function now() {
  return Date.now()
}

async function readTask(taskId) {
  if (typeof taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/.test(taskId)) throw new Error("invalid task checkpoint ID")
  const task = JSON.parse(await readFile(backgroundTaskCheckpointPath(taskId), "utf8"))
  if (task?.id !== taskId) throw new Error("task checkpoint identity is invalid")
  return task
}

async function patchTaskResult(taskId, resultPatch, extra = {}) {
  const current = await readTask(taskId)
  const next = {
    ...current,
    ...extra,
    result: { ...(current.result || {}), ...resultPatch },
    updatedAt: now()
  }
  await writePromotionJson(backgroundTaskCheckpointPath(taskId), next)
  return next
}

/**
 * 清理 detached worktree：撤销为它落的临时信任记录，再交给带防护的
 * git.removeWorktree。worker 的进程 cwd 可能就在 worktree 里（Windows 会因此
 * 锁住目录），所以先离开再删。
 */
export async function removeDetachedWorktree(worktree, repoCwd) {
  try {
    const { revokeTrust } = await import("../permission/workspace-trust.mjs")
    await revokeTrust(worktree.path)
  } catch { /* 撤不掉也只是留下一条无害的 trusted:false 记录 */ }
  try {
    process.chdir(repoCwd)
  } catch { /* 主仓路径不可用时由 removeWorktree 的校验报错 */ }
  return git.removeWorktree(worktree.path, repoCwd)
}

function validatePreservedWorktree(task) {
  if (!task?.id) return "task not found"
  if (!TERMINAL_STATES.has(task.status)) {
    return `task is not in a terminal state (status=${task.status || "unknown"})`
  }
  const result = task.result || {}
  if (result.worktree_applied === true) {
    return "worktree result already applied"
  }
  if (result.worktree_discarded === true) {
    return "worktree result already discarded"
  }
  if (result.worktree_preserved !== true || !result.worktree_path) {
    return "task has no preserved worktree"
  }
  const repoCwd = String(task.payload?.cwd || "").trim()
  if (!repoCwd) return "task payload has no repository cwd"
  return null
}

const hash = value => createHash("sha256").update(value).digest("hex")
const sameState = (a, b) => a?.head === b?.head && a?.indexTree === b?.indexTree
  && a?.worktreeTree === b?.worktreeTree && a?.dirtyFingerprint === b?.dirtyFingerprint

/** Dependency boundary for deterministic failure injection; not model-callable. */
export function createWorktreeHandoff({
  gitApi = git,
  journalFactory = openPromotionJournal,
  lockRepository = acquirePromotionLock,
  patchCheckpoint = patchTaskResult,
  removeWorktree = removeDetachedWorktree
} = {}) {
  return async function apply(task, {
    threeway = false, force = false, keepWorktree = false, dryRun = false
  } = {}) {
    if (!task?.id || !task.payload?.cwd) return { ok: false, error: "task has no repository cwd or ID" }
    let lock
    /** @type {any} */
    let record = null
    try {
      const repository = await gitApi.repositoryIdentity(String(task.payload.cwd).trim())
      const repoCwd = repository.root
      lock = await lockRepository(repository)
      const journal = journalFactory(repository, task.id)
      record = await journal.read()
      const save = async patch => {
        const next = {
          ...record, ...patch,
          operationId: journal.operationId, taskId: task.id, repository,
          revision: (record?.revision || 0) + 1, updatedAt: now()
        }
        await journal.write(next)
        record = next
      }
      const result = (extra = {}) => ({
        ok: true, operationId: record.operationId, empty: record.empty,
        files: record.files, applied: record.files, snapshot: record.snapshot,
        worktree: record.cleanup === "removed" ? "removed" : record.cleanup === "failed" ? "cleanup-failed" : "kept",
        cleanup: record.cleanup, cleanup_error: record.cleanupError || undefined, ...extra
      })
      const checkpoint = async (removed = false) => patchCheckpoint(task.id, {
        worktree_applied: !record.empty,
        worktree_apply_note: record.empty ? "worktree had no changes to apply" : null,
        applied_at: record.appliedAt, applied_files: record.files,
        apply_snapshot: record.snapshot, apply_operation_id: record.operationId,
        worktree_preserved: !removed, worktree_path: removed ? null : record.worktreePath,
        worktree_cleanup_error: record.cleanupError || null
      })
      const finish = async (recovered = false) => {
        // The legacy checkpoint is a projection, not the sole proof that apply
        // happened. Keep the candidate until BOTH it and the durable receipt exist.
        if (record.stage === "applied") {
          await checkpoint()
          await save({ stage: "receipted" })
        }
        if (record.stage === "receipted") await save({ stage: "cleanup", cleanup: "pending" })
        if (record.cleanup === "pending") {
          if (record.keepWorktree) {
            await save({ stage: "cleanup", cleanup: "kept" })
          } else {
            const candidate = await gitApi.captureWorkingTreeState(record.worktreePath)
            if (!candidate.ok || !sameState(candidate.state, record.candidate)) {
              const removed = !candidate.ok && recovered
                ? await gitApi.inspectWorktreeRemoval(record.worktreePath, repoCwd) : { ok: false, removed: false }
              await save({
                stage: "cleanup", cleanup: removed.ok && removed.removed ? "removed" : "failed",
                cleanupError: removed.ok && removed.removed ? null : "candidate changed or is unavailable; preserved for inspection"
              })
            } else {
              const cleanup = await removeWorktree({ path: record.worktreePath }, repoCwd)
              await save({ stage: "cleanup", cleanup: cleanup.ok ? "removed" : "failed", cleanupError: cleanup.ok ? null : cleanup.message || "cleanup failed" })
            }
          }
        }
        await checkpoint(record.cleanup === "removed")
        return result({ recovered, alreadyApplied: recovered })
      }

      if (record && record.stage !== "planned") {
        if (dryRun) return result({ dryRun: true, alreadyApplied: ["applied", "receipted", "cleanup"].includes(record.stage), recovery_required: record.stage === "applying" })
        if (record.stage === "cleanup" && record.cleanup !== "pending") return await finish(true)
        const observed = await gitApi.captureWorkingTreeState(repoCwd)
        if (record.stage === "applying" || !observed.ok || !sameState(observed.state, record.after)) {
          return {
            ok: false, operationId: record.operationId, recovery_required: true,
            snapshot: record.snapshot, observed: observed.state || null,
            baselineUnchanged: observed.ok && sameState(observed.state, record.before),
            expectedAfterMatched: observed.ok && observed.state.head === record.expectedAfter.head
              && observed.state.indexTree === record.expectedAfter.indexTree && observed.state.worktreeTree === record.expectedAfter.worktreeTree,
            error: "promotion outcome requires inspection; refusing to replay git apply or remove the preserved candidate"
          }
        }
        return await finish(true)
      }

      const invalid = validatePreservedWorktree(task)
      if (invalid) return { ok: false, error: invalid }
      // Read it strictly before any effect; missing/corrupt task projection is
      // not permission to proceed without a recoverable receipt destination.
      const persistedTask = await readTask(task.id)
      if (persistedTask.result?.worktree_discarded || persistedTask.result?.worktree_applied) {
        return { ok: false, error: "task checkpoint says worktree was already applied or discarded" }
      }
      const worktreePath = await realpath(String(task.result.worktree_path).trim())
      if (persistedTask.payload?.cwd !== task.payload.cwd || persistedTask.result?.worktree_path !== task.result.worktree_path
        || !TERMINAL_STATES.has(persistedTask.status)) {
        return { ok: false, error: "task checkpoint changed; reload it before applying" }
      }
      const candidateIdentity = await gitApi.repositoryIdentity(worktreePath)
      if (candidateIdentity.commonDir !== repository.commonDir || candidateIdentity.root !== worktreePath || worktreePath === repoCwd) {
        return { ok: false, error: "candidate is not a separate worktree of this repository" }
      }
      const candidate = await gitApi.captureWorkingTreeState(worktreePath)
      const baseline = await gitApi.captureWorkingTreeState(repoCwd)
      if (!candidate.ok || !baseline.ok) return { ok: false, error: candidate.error || baseline.error }
      const exported = await gitApi.exportWorktreePatch(worktreePath, { excludePaths: WORKTREE_CONFIG_EXCLUDES })
      if (!exported.ok) return { ok: false, error: `failed to export worktree patch: ${exported.error}` }
      const patchHash = hash(exported.patch)
      if (record && (record.patchHash !== patchHash || record.worktreePath !== worktreePath)) {
        return { ok: false, error: "candidate changed since promotion was planned; inspect the previous operation first" }
      }
      const overlaps = exported.files.filter(file => baseline.dirtyPaths.includes(file))
      if (overlaps.length && !force) {
        return { ok: false, error: "main checkout has uncommitted changes overlapping the patch; commit/stash them or rerun with --force", overlaps }
      }
      if (!exported.empty) {
        const preflight = await gitApi.applyPatch(repoCwd, exported.patch, { check: true, threeway, controlled: true })
        if (!preflight.ok) return { ok: false, error: `patch does not apply cleanly: ${preflight.error}`, conflicts: preflight.conflicts || [] }
      }
      const expected = exported.empty ? { ok: true, ...baseline.state }
        : await gitApi.predictPromotionTrees(repoCwd, baseline.state, exported.patch, { threeway })
      if (!expected.ok) return { ok: false, code: expected.code || "promotion_prediction_failed", error: `cannot verify candidate patch result: ${expected.error}` }
      const checked = await gitApi.captureWorkingTreeState(repoCwd)
      const checkedCandidate = await gitApi.captureWorkingTreeState(worktreePath)
      if (!checked.ok || !checkedCandidate.ok || !sameState(checked.state, baseline.state) || !sameState(checkedCandidate.state, candidate.state)) {
        return { ok: false, code: "promotion_baseline_changed", error: "repository or candidate changed during preflight; retry after inspecting the new baseline" }
      }
      if (dryRun) return { ok: true, dryRun: true, empty: exported.empty, files: exported.files, overlaps }
      await save({
        stage: "planned", createdAt: record?.createdAt || now(),
        before: baseline.state, candidate: candidate.state, expectedAfter: { head: expected.head, indexTree: expected.indexTree, worktreeTree: expected.worktreeTree }, worktreePath, patchHash,
        files: exported.files, empty: exported.empty, threeway, force, keepWorktree, snapshot: null
      })
      if (!exported.empty) {
        const snapshot = await gitApi.createGhostCommit(repoCwd, `kkcode: pre-apply snapshot for task ${task.id}`, [], { controlled: true })
        const snapshotHash = snapshot.ok ? snapshot.ghostCommit?.commitHash : null
        if (!snapshotHash) return { ok: false, operationId: record.operationId, error: `recovery snapshot failed; patch was not applied: ${snapshot.error || "missing snapshot hash"}` }
        if (snapshot.ghostCommit.treeHash !== record.before.worktreeTree) {
          return { ok: false, code: "promotion_baseline_changed", error: "recovery snapshot does not match the checked baseline; patch was not applied" }
        }
        const retained = await gitApi.retainPromotionSnapshot(repoCwd, record.operationId, snapshotHash, record.before.indexTree)
        if (!retained.ok) return { ok: false, error: `recovery snapshot could not be retained; patch was not applied: ${retained.error}` }
        await save({ stage: "planned", snapshot: snapshotHash })
      }
      // The lock coordinates KK promotions, not arbitrary editors. Recheck full
      // content immediately before the write. External edits can still race;
      // failed/unknown applies preserve all evidence and are never blindly retried.
      const finalBaseline = await gitApi.captureWorkingTreeState(repoCwd)
      const finalCandidate = await gitApi.captureWorkingTreeState(worktreePath)
      if (!finalBaseline.ok || !finalCandidate.ok || !sameState(finalBaseline.state, record.before) || !sameState(finalCandidate.state, record.candidate)) {
        return { ok: false, code: "promotion_baseline_changed", error: "repository or candidate changed before apply; recovery snapshot and candidate retained", snapshot: record.snapshot }
      }
      if (!record.empty) {
        await save({ stage: "applying" })
        const applied = await gitApi.applyPatch(repoCwd, exported.patch, { threeway, controlled: true })
        if (!applied.ok) return { ok: false, error: `git apply failed; inspect outcome before retrying: ${applied.error}`, conflicts: applied.conflicts || [], snapshot: record.snapshot, recovery_required: true }
      }
      const after = await gitApi.captureWorkingTreeState(repoCwd)
      if (!after.ok) throw new Error(`cannot persist applied-state fingerprint: ${after.error}`)
      if (after.state.head !== record.expectedAfter.head || after.state.indexTree !== record.expectedAfter.indexTree
        || after.state.worktreeTree !== record.expectedAfter.worktreeTree) {
        throw new Error("checkout differs from the predicted patch result; preserve the candidate and inspect concurrent edits")
      }
      await save({ stage: "applied", after: after.state, appliedAt: now() })
      return await finish()
    } catch (error) {
      return {
        ok: false, error: String(error?.message || error),
        operationId: record?.operationId, snapshot: record?.snapshot,
        recovery_required: Boolean(record && record.stage !== "planned")
      }
    } finally {
      await lock?.release()
    }
  }
}

export const applyWorktreeResult = createWorktreeHandoff()

/** 丢弃保留的 worktree（不应用任何变更）。 */
export async function discardWorktreeResult(task) {
  const invalid = validatePreservedWorktree(task)
  if (invalid) return { ok: false, error: invalid }

  const repoCwd = String(task.payload.cwd).trim()
  const worktreePath = String(task.result.worktree_path).trim()

  let lock
  try {
    const repository = await git.repositoryIdentity(repoCwd)
    lock = await acquirePromotionLock(repository)
    const journal = await openPromotionJournal(repository, task.id).read()
    if (journal && journal.stage !== "planned") {
      return { ok: false, error: "promotion has an applied or unknown outcome; inspect its receipt before discarding the candidate" }
    }
    const current = await readTask(task.id)
    const currentInvalid = validatePreservedWorktree(current)
    if (currentInvalid || current.result.worktree_path !== worktreePath) return { ok: false, error: currentInvalid || "task checkpoint changed" }
    const cleanup = await removeDetachedWorktree({ path: worktreePath }, repoCwd)
    await patchTaskResult(task.id, {
      worktree_discarded: cleanup.ok,
      worktree_preserved: !cleanup.ok,
      worktree_path: cleanup.ok ? null : worktreePath,
      worktree_cleanup_error: cleanup.ok ? null : cleanup.message || "unknown cleanup error"
    })
    return cleanup.ok
      ? { ok: true, discarded: true }
      : { ok: false, error: `worktree removal failed: ${cleanup.message}` }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  } finally { await lock?.release() }
}
