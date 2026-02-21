import path from "node:path"
import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises"
import { userRootDir } from "./paths.mjs"

const GHOST_COMMIT_DIR = "ghost-commits"
const MAX_GHOST_COMMITS_PER_REPO = 50 // 每个仓库最多保留的幽灵提交数
const GHOST_COMMIT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7天过期

/**
 * Ghost Commit 存储管理
 * 
 * 提供幽灵提交的持久化存储、查询、清理等功能。
 * 存储位置: ~/.kkcode/ghost-commits/
 */

/** 获取幽灵提交存储目录 */
export function getGhostCommitDir() {
  return path.join(userRootDir(), GHOST_COMMIT_DIR)
}

/** 获取仓库的存储目录（基于 repoPath 的哈希） */
function getRepoDir(repoPath) {
  // 使用简单的哈希来避免路径中的特殊字符问题
  const hash = Buffer.from(repoPath).toString("base64url")
  return path.join(getGhostCommitDir(), hash)
}

/** 确保目录存在 */
async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * 保存幽灵提交元数据
 * 
 * @param {Object} ghostCommit - 幽灵提交信息
 * @param {string} ghostCommit.id - 唯一ID
 * @param {string} ghostCommit.commitHash - Git commit hash
 * @param {string} ghostCommit.repoPath - 仓库路径
 * @param {string} ghostCommit.parentHash - 父提交hash
 * @param {string} ghostCommit.message - 提交信息
 * @param {number} ghostCommit.createdAt - 创建时间戳
 * @param {string[]} ghostCommit.files - 包含的文件列表
 */
export async function saveGhostCommit(ghostCommit) {
  const repoDir = getRepoDir(ghostCommit.repoPath)
  await ensureDir(repoDir)

  const filePath = path.join(repoDir, `${ghostCommit.id}.json`)
  const data = {
    ...ghostCommit,
    savedAt: Date.now()
  }

  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")

  // 清理旧的幽灵提交
  await cleanupOldGhostCommits(ghostCommit.repoPath)

  return { ok: true, path: filePath }
}

/**
 * 加载幽灵提交元数据
 * 
 * @param {string} repoPath - 仓库路径
 * @param {string} ghostCommitId - 幽灵提交ID
 * @returns {Promise<Object|null>}
 */
export async function loadGhostCommit(repoPath, ghostCommitId) {
  const repoDir = getRepoDir(repoPath)
  const filePath = path.join(repoDir, `${ghostCommitId}.json`)

  try {
    const content = await readFile(filePath, "utf8")
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * 列出仓库的所有幽灵提交
 * 
 * @param {string} repoPath - 仓库路径
 * @param {Object} options - 选项
 * @param {boolean} [options.includeExpired=false] - 是否包含已过期的
 * @returns {Promise<Array<Object>>}
 */
export async function listGhostCommits(repoPath, options = {}) {
  const { includeExpired = false } = options
  const repoDir = getRepoDir(repoPath)

  try {
    const entries = await readdir(repoDir, { withFileTypes: true })
    const commits = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue

      try {
        const content = await readFile(path.join(repoDir, entry.name), "utf8")
        const commit = JSON.parse(content)

        // 检查是否过期
        const isExpired = Date.now() - commit.createdAt > GHOST_COMMIT_TTL_MS
        if (!includeExpired && isExpired) {
          // 删除过期文件
          await unlink(path.join(repoDir, entry.name)).catch(() => {})
          continue
        }

        commits.push({
          ...commit,
          isExpired
        })
      } catch {
        // 跳过无效文件
      }
    }

    // 按创建时间降序排列
    return commits.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

/**
 * 删除幽灵提交
 * 
 * @param {string} repoPath - 仓库路径
 * @param {string} ghostCommitId - 幽灵提交ID
 * @returns {Promise<boolean>}
 */
export async function deleteGhostCommit(repoPath, ghostCommitId) {
  const repoDir = getRepoDir(repoPath)
  const filePath = path.join(repoDir, `${ghostCommitId}.json`)

  try {
    await unlink(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 清理旧的幽灵提交
 * 保留最新的 MAX_GHOST_COMMITS_PER_REPO 个
 * 
 * @param {string} repoPath - 仓库路径
 */
export async function cleanupOldGhostCommits(repoPath) {
  const commits = await listGhostCommits(repoPath, { includeExpired: true })

  if (commits.length <= MAX_GHOST_COMMITS_PER_REPO) {
    return
  }

  // 删除多余的旧提交
  const toDelete = commits.slice(MAX_GHOST_COMMITS_PER_REPO)
  for (const commit of toDelete) {
    await deleteGhostCommit(repoPath, commit.id)
  }
}

/**
 * 清理所有过期的幽灵提交
 * 
 * @returns {Promise<{deleted: number}>}
 */
export async function cleanupAllExpired() {
  const baseDir = getGhostCommitDir()
  let deleted = 0

  try {
    const repoDirs = await readdir(baseDir, { withFileTypes: true })
    
    for (const dir of repoDirs) {
      if (!dir.isDirectory()) continue

      const repoPath = path.join(baseDir, dir.name)
      try {
        const files = await readdir(repoPath)
        
        for (const file of files) {
          if (!file.endsWith(".json")) continue

          try {
            const content = await readFile(path.join(repoPath, file), "utf8")
            const commit = JSON.parse(content)
            
            const isExpired = Date.now() - commit.createdAt > GHOST_COMMIT_TTL_MS
            if (isExpired) {
              await unlink(path.join(repoPath, file))
              deleted++
            }
          } catch {
            // 跳过无效文件
          }
        }
      } catch {
        // 跳过无法读取的目录
      }
    }
  } catch {
    // 目录可能不存在
  }

  return { deleted }
}

/**
 * 获取最新的幽灵提交
 * 
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<Object|null>}
 */
export async function getLatestGhostCommit(repoPath) {
  const commits = await listGhostCommits(repoPath)
  return commits[0] || null
}

/**
 * 统计幽灵提交数量
 * 
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<{total: number, expired: number}>}
 */
export async function countGhostCommits(repoPath) {
  const commits = await listGhostCommits(repoPath, { includeExpired: true })
  const expired = commits.filter(c => c.isExpired).length
  return { total: commits.length, expired }
}
