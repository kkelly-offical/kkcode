import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import { readJson, writeJson } from "../storage/json-store.mjs"
import { userRootDir } from "../storage/paths.mjs"
import { isGitRepo } from "../util/git.mjs"
import { gitSnapshotTool } from "../tool/git-auto.mjs"
import { listGhostCommits, getLatestGhostCommit } from "../storage/ghost-commit-store.mjs"

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

// ============================================================================
// Git Snapshot Integration - AI Agent 自动 Git 快照功能
// ============================================================================

/**
 * 在 AI 修改前自动创建 Git 快照
 * 
 * @param {string} sessionId - 会话ID
 * @param {string} cwd - 工作目录
 * @param {Object} config - 配置对象
 * @param {Object} options - 选项
 * @param {string} [options.reason] - 快照原因
 * @returns {Promise<{ok: boolean, snapshot?: Object, skipped?: boolean, reason?: string}>}
 */
export async function autoSnapshotBeforeEdit(sessionId, cwd, config = {}, options = {}) {
  // 检查 Git 自动化是否启用
  if (config.git_auto?.enabled === false) {
    return { ok: true, skipped: true, reason: "git_auto_disabled" }
  }

  // 检查自动快照是否启用
  if (config.git_auto?.auto_snapshot === false) {
    return { ok: true, skipped: true, reason: "auto_snapshot_disabled" }
  }

  // 检查是否是 Git 仓库
  if (!(await isGitRepo(cwd))) {
    return { ok: true, skipped: true, reason: "not_a_git_repo" }
  }

  try {
    const result = await gitSnapshotTool.execute(
      {
        auto: true,
        message: options.reason || `Auto snapshot before AI edit (session: ${sessionId})`
      },
      { cwd, sessionId, config }
    )

    if (result.ok) {
      return {
        ok: true,
        snapshot: result.snapshot,
        skipped: false
      }
    } else {
      return {
        ok: false,
        skipped: true,
        reason: result.message || "snapshot_failed"
      }
    }
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      reason: error.message
    }
  }
}

/**
 * 获取会话的 Git 快照历史
 * 
 * @param {string} sessionId - 会话ID
 * @param {string} cwd - 工作目录
 * @returns {Promise<Array<Object>>}
 */
export async function getSessionSnapshots(sessionId, cwd) {
  if (!(await isGitRepo(cwd))) {
    return []
  }

  const snapshots = await listGhostCommits(cwd)
  // 过滤出当前会话的快照
  return snapshots.filter(s => 
    s.message?.includes(`session: ${sessionId}`) ||
    s.message?.includes("Auto snapshot")
  )
}

/**
 * 恢复到会话的最近一次快照
 * 
 * @param {string} sessionId - 会话ID
 * @param {string} cwd - 工作目录
 * @returns {Promise<{ok: boolean, message?: string, error?: string}>}
 */
export async function restoreLastSessionSnapshot(sessionId, cwd) {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, error: "Not a git repository" }
  }

  const snapshots = await getSessionSnapshots(sessionId, cwd)
  if (snapshots.length === 0) {
    return { ok: false, error: "No snapshots found for this session" }
  }

  const latest = snapshots[0]
  const { gitRestoreTool } = await import("../tool/git-auto.mjs")

  const result = await gitRestoreTool.execute(
    { snapshot_id: latest.id },
    { cwd, sessionId }
  )

  return result
}

/**
 * Checkpoint Manager - 统一的管理器
 * 
 * 协调 JSON checkpoint 和 Git snapshot 两种机制：
 * - JSON checkpoint: 保存会话状态（内存中的数据）
 * - Git snapshot: 保存工作目录状态（文件系统状态）
 */
export class CheckpointManager {
  constructor(sessionId, cwd, config = {}) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.config = config
    this.lastSnapshotId = null
  }

  /**
   * 在修改前创建检查点（自动决定使用哪种机制）
   */
  async beforeEdit(reason = "AI edit") {
    const results = {
      jsonCheckpoint: null,
      gitSnapshot: null
    }

    // 1. 创建 JSON checkpoint（如果配置启用）
    if (this.config.checkpoint?.enabled !== false) {
      // 这里可以扩展保存更多会话状态
      results.jsonCheckpoint = await saveCheckpoint(this.sessionId, {
        type: "pre_edit",
        reason,
        timestamp: Date.now()
      })
    }

    // 2. 创建 Git snapshot（如果配置启用）
    if (this.config.git_auto?.enabled !== false && this.config.git_auto?.auto_snapshot !== false) {
      const snapshotResult = await autoSnapshotBeforeEdit(
        this.sessionId,
        this.cwd,
        this.config,
        { reason }
      )
      
      if (snapshotResult.ok && !snapshotResult.skipped) {
        results.gitSnapshot = snapshotResult.snapshot
        this.lastSnapshotId = snapshotResult.snapshot.id
      }
    }

    return results
  }

  /**
   * 恢复到最近一次检查点
   */
  async restore() {
    if (this.lastSnapshotId) {
      const { gitRestoreTool } = await import("../tool/git-auto.mjs")
      return await gitRestoreTool.execute(
        { snapshot_id: this.lastSnapshotId },
        { cwd: this.cwd, sessionId: this.sessionId }
      )
    }

    // 如果没有快照ID，尝试恢复到最近一次会话快照
    return await restoreLastSessionSnapshot(this.sessionId, this.cwd)
  }

  /**
   * 获取当前会话的所有快照
   */
  async listSnapshots() {
    return await getSessionSnapshots(this.sessionId, this.cwd)
  }
}

/**
 * 创建 CheckpointManager 实例的工厂函数
 */
export function createCheckpointManager(sessionId, cwd, config) {
  return new CheckpointManager(sessionId, cwd, config)
}
