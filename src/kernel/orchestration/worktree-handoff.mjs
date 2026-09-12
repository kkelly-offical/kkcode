import { readJson, writeJson } from "../../storage/json-store.mjs"
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
  return readJson(backgroundTaskCheckpointPath(taskId), null)
}

async function patchTaskResult(taskId, resultPatch, extra = {}) {
  const current = await readTask(taskId)
  if (!current) return null
  const next = {
    ...current,
    ...extra,
    result: { ...(current.result || {}), ...resultPatch },
    updatedAt: now()
  }
  await writeJson(backgroundTaskCheckpointPath(taskId), next)
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

/**
 * 把保留 worktree 里的变更以 patch 形式应用回主 checkout（Codex 式 handoff）。
 * 全有或全无：默认不走 --3way，冲突就整体中止并保留 worktree。
 */
export async function applyWorktreeResult(task, {
  threeway = false,
  force = false,
  keepWorktree = false,
  dryRun = false
} = {}) {
  const invalid = validatePreservedWorktree(task)
  if (invalid) return { ok: false, error: invalid }

  const repoCwd = String(task.payload.cwd).trim()
  const worktreePath = String(task.result.worktree_path).trim()

  if (!(await git.isGitRepo(repoCwd))) {
    return { ok: false, error: `repository is not a git repo: ${repoCwd}` }
  }
  if (!(await git.isGitRepo(worktreePath))) {
    return { ok: false, error: `preserved worktree is no longer a git repo: ${worktreePath}` }
  }

  const exported = await git.exportWorktreePatch(worktreePath, {
    excludePaths: WORKTREE_CONFIG_EXCLUDES
  })
  if (!exported.ok) {
    return { ok: false, error: `failed to export worktree patch: ${exported.error}` }
  }

  if (exported.empty) {
    if (dryRun) return { ok: true, dryRun: true, empty: true, files: [] }
    const cleanup = await removeDetachedWorktree({ path: worktreePath }, repoCwd)
    await patchTaskResult(task.id, {
      worktree_applied: false,
      worktree_apply_note: "worktree had no changes to apply",
      worktree_preserved: !cleanup.ok,
      worktree_path: cleanup.ok ? null : worktreePath,
      worktree_cleanup_error: cleanup.ok ? null : cleanup.message || "unknown cleanup error"
    })
    return {
      ok: cleanup.ok,
      empty: true,
      files: [],
      cleanup: cleanup.ok ? "removed" : cleanup.message,
      error: cleanup.ok ? undefined : `nothing to apply; worktree cleanup failed: ${cleanup.message}`
    }
  }

  // 脏区重叠检查：apply --check 只看上下文匹配，拦不住「覆盖用户未提交的
  // 别的改动」这一类语义冲突，重叠文件默认拒绝。
  const dirtyPathSet = new Set(await git.dirtyPaths(repoCwd))
  const overlaps = exported.files.filter((file) => dirtyPathSet.has(file))
  if (overlaps.length > 0 && !force) {
    return {
      ok: false,
      error: "main checkout has uncommitted changes overlapping the patch; commit/stash them or rerun with --force",
      overlaps
    }
  }

  const preflight = await git.applyPatch(repoCwd, exported.patch, { check: true, threeway })
  if (!preflight.ok) {
    return {
      ok: false,
      error: `patch does not apply cleanly: ${preflight.error}`,
      conflicts: preflight.conflicts || []
    }
  }

  if (dryRun) {
    return { ok: true, dryRun: true, files: exported.files, overlaps }
  }

  // apply 前的幽灵快照：不挂在任何分支上的恢复点，hash 写回 checkpoint。
  const snapshot = await git.createGhostCommit(
    repoCwd,
    `kkcode: pre-apply snapshot for task ${task.id}`
  )
  const snapshotHash = snapshot.ok ? snapshot.ghostCommit?.commitHash || null : null

  const applied = await git.applyPatch(repoCwd, exported.patch, { threeway })
  if (!applied.ok) {
    return {
      ok: false,
      error: `git apply failed: ${applied.error}`,
      conflicts: applied.conflicts || [],
      snapshot: snapshotHash
    }
  }

  let cleanup = { ok: true, message: "kept" }
  if (!keepWorktree) {
    cleanup = await removeDetachedWorktree({ path: worktreePath }, repoCwd)
  }

  await patchTaskResult(task.id, {
    worktree_applied: true,
    applied_at: now(),
    applied_files: exported.files,
    apply_snapshot: snapshotHash,
    worktree_preserved: keepWorktree || !cleanup.ok,
    worktree_path: keepWorktree || !cleanup.ok ? worktreePath : null,
    worktree_cleanup_error: !keepWorktree && !cleanup.ok
      ? cleanup.message || "unknown cleanup error"
      : null
  })

  return {
    ok: true,
    files: exported.files,
    applied: applied.applied || [],
    snapshot: snapshotHash,
    snapshot_error: snapshot.ok ? undefined : snapshot.error,
    worktree: keepWorktree ? "kept" : cleanup.ok ? "removed" : "cleanup-failed",
    cleanup_error: !keepWorktree && !cleanup.ok ? cleanup.message : undefined
  }
}

/** 丢弃保留的 worktree（不应用任何变更）。 */
export async function discardWorktreeResult(task) {
  const invalid = validatePreservedWorktree(task)
  if (invalid) return { ok: false, error: invalid }

  const repoCwd = String(task.payload.cwd).trim()
  const worktreePath = String(task.result.worktree_path).trim()

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
}
