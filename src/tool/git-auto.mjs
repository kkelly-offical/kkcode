import path from "node:path"
import { mkdir } from "node:fs/promises"
import { userRootDir } from "../storage/paths.mjs"
import { readJson, writeJson } from "../storage/json-store.mjs"
import {
  isGitRepo,
  createGhostCommit,
  restoreGhostCommit,
  applyPatch,
  preflightPatch,
  getGitInfo,
  getDiff,
  getStagedDiff
} from "../util/git.mjs"
import {
  saveGhostCommit,
  loadGhostCommit,
  listGhostCommits,
  deleteGhostCommit,
  getLatestGhostCommit,
  cleanupAllExpired
} from "../storage/ghost-commit-store.mjs"

/**
 * Git 自动化工具模块
 * 
 * 为 AI Agent 提供安全的 Git 操作能力：
 * 1. git_snapshot - 创建幽灵提交（临时快照）
 * 2. git_restore - 恢复到指定快照
 * 3. git_apply_patch - 应用 AI 生成的 diff 补丁
 * 4. git_info - 获取仓库信息
 * 5. git_status - 获取当前状态
 * 
 * 安全原则：
 * - AI 只能创建快照和应用补丁，不能直接执行 git commit/push
 * - 所有操作都通过临时索引进行，不干扰用户工作区
 * - 快照有过期时间，自动清理旧数据
 */

const SNAPSHOT_STATE_FILE = "git-snapshot-state.json"

/** 获取快照状态文件路径 */
function getSnapshotStatePath(sessionId) {
  return path.join(userRootDir(), "sessions", sessionId, SNAPSHOT_STATE_FILE)
}

/** 加载会话的快照状态 */
async function loadSnapshotState(sessionId) {
  const filePath = getSnapshotStatePath(sessionId)
  return readJson(filePath, { snapshots: [], lastSnapshotId: null })
}

/** 保存会话的快照状态 */
async function saveSnapshotState(sessionId, state) {
  const filePath = getSnapshotStatePath(sessionId)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeJson(filePath, state)
}

// ============================================================================
// Tool: git_snapshot - 创建幽灵提交快照
// ============================================================================

export const gitSnapshotTool = {
  name: "git_snapshot",
  description: "Create a ghost commit snapshot of the current working directory. This captures the current state without creating a regular git commit, allowing you to restore later if needed. Uses temporary git index to avoid interfering with user's staging area.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Optional snapshot message (default: 'kkcode snapshot')"
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Specific file paths to include (default: all changes)"
      },
      auto: {
        type: "boolean",
        description: "Whether this is an automatic snapshot (default: false)"
      }
    },
    required: []
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()
    const sessionId = ctx.sessionId || "default"

    // 检查是否是 Git 仓库
    if (!(await isGitRepo(cwd))) {
      return {
        ok: false,
        error: "not_a_git_repo",
        message: "Current directory is not a git repository"
      }
    }

    const message = args.message || (args.auto ? "kkcode auto snapshot" : "kkcode snapshot")
    const paths = args.paths || []

    // 创建幽灵提交
    const result = await createGhostCommit(cwd, message, paths)
    if (!result.ok) {
      return {
        ok: false,
        error: "create_failed",
        message: result.error
      }
    }

    // 持久化存储
    await saveGhostCommit(result.ghostCommit)

    // 更新会话状态
    const state = await loadSnapshotState(sessionId)
    state.snapshots.push({
      id: result.ghostCommit.id,
      commitHash: result.ghostCommit.commitHash,
      createdAt: result.ghostCommit.createdAt,
      message: result.ghostCommit.message,
      auto: !!args.auto
    })
    state.lastSnapshotId = result.ghostCommit.id
    await saveSnapshotState(sessionId, state)

    return {
      ok: true,
      snapshot: {
        id: result.ghostCommit.id,
        commitHash: result.ghostCommit.commitHash,
        shortHash: result.ghostCommit.commitHash.slice(0, 8),
        message: result.ghostCommit.message,
        createdAt: result.ghostCommit.createdAt,
        files: result.ghostCommit.files
      },
      message: `Created ghost commit ${result.ghostCommit.commitHash.slice(0, 8)} with ${result.ghostCommit.files.length} file(s)`
    }
  }
}

// ============================================================================
// Tool: git_restore - 恢复到指定快照
// ============================================================================

export const gitRestoreTool = {
  name: "git_restore",
  description: "Restore the working directory to a previously created ghost commit snapshot. This will overwrite current changes with the snapshot state.",
  inputSchema: {
    type: "object",
    properties: {
      snapshot_id: {
        type: "string",
        description: "The ghost commit snapshot ID to restore to"
      },
      restore_index: {
        type: "boolean",
        description: "Whether to also restore the staging area (default: false)"
      }
    },
    required: ["snapshot_id"]
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()
    const sessionId = ctx.sessionId || "default"

    if (!(await isGitRepo(cwd))) {
      return {
        ok: false,
        error: "not_a_git_repo",
        message: "Current directory is not a git repository"
      }
    }

    const snapshotId = args.snapshot_id
    const restoreIndex = args.restore_index || false

    // 加载幽灵提交元数据
    const ghostCommit = await loadGhostCommit(cwd, snapshotId)
    if (!ghostCommit) {
      return {
        ok: false,
        error: "snapshot_not_found",
        message: `Snapshot ${snapshotId} not found. Use git_list_snapshots to see available snapshots.`
      }
    }

    // 恢复到幽灵提交
    const result = await restoreGhostCommit(cwd, ghostCommit.commitHash, restoreIndex)
    if (!result.ok) {
      return {
        ok: false,
        error: "restore_failed",
        message: result.error
      }
    }

    return {
      ok: true,
      restored: {
        snapshotId: ghostCommit.id,
        commitHash: ghostCommit.commitHash,
        shortHash: ghostCommit.commitHash.slice(0, 8),
        message: ghostCommit.message,
        createdAt: ghostCommit.createdAt
      },
      message: `Restored to snapshot ${ghostCommit.commitHash.slice(0, 8)}: ${ghostCommit.message}`
    }
  }
}

// ============================================================================
// Tool: git_list_snapshots - 列出所有快照
// ============================================================================

export const gitListSnapshotsTool = {
  name: "git_list_snapshots",
  description: "List all ghost commit snapshots for the current repository, ordered by creation time (newest first).",
  inputSchema: {
    type: "object",
    properties: {
      include_expired: {
        type: "boolean",
        description: "Include expired snapshots (default: false)"
      }
    },
    required: []
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()

    if (!(await isGitRepo(cwd))) {
      return {
        ok: false,
        error: "not_a_git_repo",
        message: "Current directory is not a git repository"
      }
    }

    const snapshots = await listGhostCommits(cwd, { 
      includeExpired: args.include_expired 
    })

    return {
      ok: true,
      count: snapshots.length,
      snapshots: snapshots.map(s => ({
        id: s.id,
        commitHash: s.commitHash,
        shortHash: s.commitHash.slice(0, 8),
        message: s.message,
        createdAt: s.createdAt,
        fileCount: s.files?.length || 0,
        isExpired: s.isExpired || false
      }))
    }
  }
}

// ============================================================================
// Tool: git_apply_patch - 应用 AI 生成的 diff 补丁
// ============================================================================

export const gitApplyPatchTool = {
  name: "git_apply_patch",
  description: "Apply a unified diff/patch to the working directory. Supports 3-way merge for conflict resolution. First runs a preflight check to validate the patch can be applied, then applies it if valid.",
  inputSchema: {
    type: "object",
    properties: {
      diff: {
        type: "string",
        description: "The unified diff/patch content to apply"
      },
      preflight_only: {
        type: "boolean",
        description: "Only check if patch can be applied, don't actually apply (default: false)"
      },
      threeway: {
        type: "boolean",
        description: "Use 3-way merge for better conflict resolution (default: true)"
      }
    },
    required: ["diff"]
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()

    if (!(await isGitRepo(cwd))) {
      return {
        ok: false,
        error: "not_a_git_repo",
        message: "Current directory is not a git repository"
      }
    }

    const diff = args.diff
    const preflightOnly = args.preflight_only || false
    const threeway = args.threeway !== false // 默认 true

    if (!diff || !diff.trim()) {
      return {
        ok: false,
        error: "empty_diff",
        message: "Diff content is empty"
      }
    }

    // 预检
    const preflight = await preflightPatch(cwd, diff)
    if (!preflight.applicable) {
      return {
        ok: false,
        error: "preflight_failed",
        message: "Patch cannot be applied",
        conflicts: preflight.conflicts,
        details: preflight.error
      }
    }

    if (preflightOnly) {
      return {
        ok: true,
        preflight: true,
        applicable: true,
        message: "Patch can be applied successfully"
      }
    }

    // 应用 patch
    const result = await applyPatch(cwd, diff, { 
      threeway,
      check: false 
    })

    if (!result.ok) {
      return {
        ok: false,
        error: "apply_failed",
        message: result.error,
        conflicts: result.conflicts
      }
    }

    return {
      ok: true,
      applied: result.applied,
      message: `Successfully applied patch to ${result.applied.length} file(s)`,
      files: result.applied
    }
  }
}

// ============================================================================
// Tool: git_info - 获取仓库信息
// ============================================================================

export const gitInfoTool = {
  name: "git_info",
  description: "Get comprehensive git repository information including current branch, commit hash, remote URLs, and working tree status. Useful for understanding the repository context before making changes.",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()

    const result = await getGitInfo(cwd)
    if (!result.ok) {
      return {
        ok: false,
        error: "git_info_failed",
        message: result.error,
        isGitRepo: false
      }
    }

    return {
      ok: true,
      info: result.info
    }
  }
}

// ============================================================================
// Tool: git_status - 获取当前状态
// ============================================================================

export const gitStatusTool = {
  name: "git_status",
  description: "Get detailed git status including uncommitted changes, staged changes, and diffs. Shows both working tree and staging area status.",
  inputSchema: {
    type: "object",
    properties: {
      include_diff: {
        type: "boolean",
        description: "Include actual diff content (default: true)"
      }
    },
    required: []
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()

    if (!(await isGitRepo(cwd))) {
      return {
        ok: false,
        error: "not_a_git_repo",
        message: "Current directory is not a git repository"
      }
    }

    const includeDiff = args.include_diff !== false // 默认 true

    const [infoResult, unstagedResult, stagedResult] = await Promise.all([
      getGitInfo(cwd),
      includeDiff ? getDiff(cwd) : { ok: true, diff: "" },
      includeDiff ? getStagedDiff(cwd) : { ok: true, diff: "" }
    ])

    if (!infoResult.ok) {
      return {
        ok: false,
        error: "status_failed",
        message: infoResult.error
      }
    }

    return {
      ok: true,
      status: {
        branch: infoResult.info.currentBranch,
        commit: infoResult.info.currentCommit,
        shortCommit: infoResult.info.currentCommit?.slice(0, 8),
        hasUncommittedChanges: infoResult.info.hasUncommittedChanges,
        changedFiles: infoResult.info.changedFiles,
        unstagedDiff: unstagedResult.diff,
        stagedDiff: stagedResult.diff
      }
    }
  }
}

// ============================================================================
// Tool: git_delete_snapshot - 删除快照
// ============================================================================

export const gitDeleteSnapshotTool = {
  name: "git_delete_snapshot",
  description: "Delete a ghost commit snapshot by ID. This only removes the metadata; the git commit object may still exist until git garbage collection runs.",
  inputSchema: {
    type: "object",
    properties: {
      snapshot_id: {
        type: "string",
        description: "The snapshot ID to delete"
      }
    },
    required: ["snapshot_id"]
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()
    const snapshotId = args.snapshot_id

    const deleted = await deleteGhostCommit(cwd, snapshotId)
    if (!deleted) {
      return {
        ok: false,
        error: "not_found",
        message: `Snapshot ${snapshotId} not found`
      }
    }

    return {
      ok: true,
      deleted: snapshotId,
      message: `Deleted snapshot ${snapshotId}`
    }
  }
}

// ============================================================================
// Tool: git_cleanup - 清理过期快照
// ============================================================================

export const gitCleanupTool = {
  name: "git_cleanup",
  description: "Clean up all expired ghost commit snapshots across all repositories. Snapshots older than 7 days are considered expired.",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  },
  async execute() {
    const result = await cleanupAllExpired()
    return {
      ok: true,
      deleted: result.deleted,
      message: `Cleaned up ${result.deleted} expired snapshot(s)`
    }
  }
}

// ============================================================================
// 导出所有 Git 自动化工具
// ============================================================================

export const gitAutoTools = [
  gitSnapshotTool,
  gitRestoreTool,
  gitListSnapshotsTool,
  gitApplyPatchTool,
  gitInfoTool,
  gitStatusTool,
  gitDeleteSnapshotTool,
  gitCleanupTool
]

/**
 * 获取最后一次快照 ID（用于自动恢复）
 */
export async function getLastSnapshotId(sessionId) {
  const state = await loadSnapshotState(sessionId)
  return state.lastSnapshotId
}

/**
 * 在修改前自动创建快照（如果配置启用）
 */
export async function autoSnapshotBeforeEdit(sessionId, cwd, config = {}) {
  if (!config.git_auto?.enabled || !config.git_auto?.auto_snapshot) {
    return { skipped: true, reason: "auto_snapshot_disabled" }
  }

  if (!(await isGitRepo(cwd))) {
    return { skipped: true, reason: "not_a_git_repo" }
  }

  const result = await gitSnapshotTool.execute(
    { auto: true, message: "Auto snapshot before AI edit" },
    { cwd, sessionId }
  )

  return result
}
