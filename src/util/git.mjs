import { spawn } from "node:child_process"
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const GIT_TIMEOUT_MS = 30000

function run(args, cwd = process.cwd(), timeoutMs = GIT_TIMEOUT_MS, env = {}) {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let done = false

    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env }
    })

    const timer = setTimeout(() => {
      done = true
      child.kill()
      resolve({ ok: false, stdout, stderr: "git command timed out", code: null })
    }, timeoutMs)

    child.stdout.on("data", (buf) => { stdout += String(buf) })
    child.stderr.on("data", (buf) => { stderr += String(buf) })

    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: error.message, code: null })
    })

    child.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code })
    })
  })
}

/** Check if cwd is inside a git repo */
export async function isGitRepo(cwd = process.cwd()) {
  const result = await run(["rev-parse", "--is-inside-work-tree"], cwd)
  return result.ok && result.stdout.trim() === "true"
}

/** Get current branch name */
export async function currentBranch(cwd = process.cwd()) {
  const result = await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  return result.ok ? result.stdout.trim() : null
}

/** Check if working tree is clean */
export async function isClean(cwd = process.cwd()) {
  const result = await run(["status", "--porcelain"], cwd)
  return result.ok && !result.stdout.trim()
}

/** Create and checkout a new branch */
export async function createBranch(name, cwd = process.cwd()) {
  const result = await run(["checkout", "-b", name], cwd)
  return { ok: result.ok, message: result.ok ? `created branch: ${name}` : result.stderr }
}

/** Checkout an existing branch */
export async function checkoutBranch(name, cwd = process.cwd()) {
  const result = await run(["checkout", name], cwd)
  return { ok: result.ok, message: result.ok ? `switched to: ${name}` : result.stderr }
}

/** Stage all changes and commit */
export async function commitAll(message, cwd = process.cwd()) {
  const add = await run(["add", "-A"], cwd)
  if (!add.ok) return { ok: false, message: `git add failed: ${add.stderr}` }
  const commit = await run(["commit", "-m", message, "--allow-empty"], cwd)
  if (!commit.ok) {
    // Nothing to commit is not an error
    if (commit.stderr.includes("nothing to commit")) {
      return { ok: true, message: "nothing to commit", empty: true }
    }
    return { ok: false, message: `git commit failed: ${commit.stderr}` }
  }
  return { ok: true, message: commit.stdout.split("\n")[0] || "committed" }
}

/** Merge a branch into current branch */
export async function mergeBranch(source, cwd = process.cwd()) {
  const result = await run(["merge", source, "--no-ff", "-m", `Merge branch '${source}'`], cwd)
  return { ok: result.ok, message: result.ok ? `merged ${source}` : result.stderr }
}

/** Delete a branch */
export async function deleteBranch(name, cwd = process.cwd()) {
  const result = await run(["branch", "-d", name], cwd)
  return { ok: result.ok, message: result.ok ? `deleted branch: ${name}` : result.stderr }
}

/** Get short log of recent commits */
export async function recentCommits(count = 5, cwd = process.cwd()) {
  const result = await run(["log", `--oneline`, `-${count}`], cwd)
  return result.ok ? result.stdout.trim().split("\n").filter(Boolean) : []
}

/** Get diff stat summary */
export async function diffStat(cwd = process.cwd()) {
  const result = await run(["diff", "--stat", "HEAD"], cwd)
  return result.ok ? result.stdout.trim() : ""
}

/** Stash current changes */
export async function stash(message = "auto-stash", cwd = process.cwd()) {
  const result = await run(["stash", "push", "-m", message], cwd)
  return { ok: result.ok, message: result.ok ? result.stdout.trim() : result.stderr }
}

/** Pop stash */
export async function stashPop(cwd = process.cwd()) {
  const result = await run(["stash", "pop"], cwd)
  return { ok: result.ok, message: result.ok ? result.stdout.trim() : result.stderr }
}

/** Generate a branch name from session/objective */
export function generateBranchName(sessionId, objective = "") {
  const prefix = "kkcode"
  const shortId = String(sessionId || "").slice(0, 8)
  const slug = String(objective || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
  return `${prefix}/${shortId}${slug ? "-" + slug : ""}`
}

// ============================================================================
// Ghost Commit (幽灵提交) - AI Agent Git 自动化核心功能
// ============================================================================

/**
 * Ghost Commit 元数据结构
 * @typedef {Object} GhostCommitInfo
 * @property {string} id - 幽灵提交ID (UUID)
 * @property {string} commitHash - Git 提交对象哈希
 * @property {string} repoPath - 仓库绝对路径
 * @property {string} parentHash - 父提交哈希
 * @property {string} message - 提交信息
 * @property {number} createdAt - 创建时间戳
 * @property {string[]} files - 包含的文件列表
 */

/**
 * 创建幽灵提交 (Ghost Commit)
 * 使用临时索引创建不引用在任何分支上的提交对象
 * 
 * @param {string} repoPath - 仓库路径
 * @param {string} message - 提交信息
 * @param {string[]} [paths=[]] - 要包含的文件路径（相对于repoPath），空数组表示所有更改
 * @returns {Promise<{ok: boolean, ghostCommit?: GhostCommitInfo, error?: string}>}
 */
export async function createGhostCommit(repoPath, message = "kkcode snapshot", paths = []) {
  // 检查是否是 Git 仓库
  if (!(await isGitRepo(repoPath))) {
    return { ok: false, error: "not a git repository" }
  }

  // 获取当前 HEAD
  const headResult = await run(["rev-parse", "HEAD"], repoPath)
  if (!headResult.ok) {
    return { ok: false, error: `failed to get HEAD: ${headResult.stderr}` }
  }
  const parentHash = headResult.stdout.trim()

  // 创建临时目录和临时索引文件
  let tmpDir = null
  let indexPath = null
  
  try {
    tmpDir = await mkdtemp(path.join(tmpdir(), "kkcode-git-"))
    indexPath = path.join(tmpDir, "index")

    // 1. 读取当前 HEAD 到临时索引
    const readTreeResult = await run(
      ["read-tree", "HEAD"],
      repoPath,
      GIT_TIMEOUT_MS,
      { GIT_INDEX_FILE: indexPath }
    )
    if (!readTreeResult.ok) {
      return { ok: false, error: `read-tree failed: ${readTreeResult.stderr}` }
    }

    // 2. 添加更改到临时索引
    const addArgs = paths.length > 0 
      ? ["add", "--", ...paths]
      : ["add", "-A"]
    const addResult = await run(
      addArgs,
      repoPath,
      GIT_TIMEOUT_MS,
      { GIT_INDEX_FILE: indexPath }
    )
    if (!addResult.ok) {
      return { ok: false, error: `git add failed: ${addResult.stderr}` }
    }

    // 3. 写入树对象
    const writeTreeResult = await run(
      ["write-tree"],
      repoPath,
      GIT_TIMEOUT_MS,
      { GIT_INDEX_FILE: indexPath }
    )
    if (!writeTreeResult.ok) {
      return { ok: false, error: `write-tree failed: ${writeTreeResult.stderr}` }
    }
    const treeHash = writeTreeResult.stdout.trim()

    // 4. 创建提交对象 (幽灵提交)
    const commitTreeResult = await run(
      ["commit-tree", treeHash, "-p", parentHash, "-m", message],
      repoPath
    )
    if (!commitTreeResult.ok) {
      return { ok: false, error: `commit-tree failed: ${commitTreeResult.stderr}` }
    }
    const commitHash = commitTreeResult.stdout.trim()

    // 5. 获取包含的文件列表
    const diffResult = await run(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash],
      repoPath
    )
    const files = diffResult.ok 
      ? diffResult.stdout.trim().split("\n").filter(Boolean)
      : []

    return {
      ok: true,
      ghostCommit: {
        id: generateGhostCommitId(),
        commitHash,
        repoPath: path.resolve(repoPath),
        parentHash,
        message,
        createdAt: Date.now(),
        files
      }
    }
  } catch (error) {
    return { ok: false, error: error.message }
  } finally {
    // 清理临时目录
    if (tmpDir) {
      try {
        await rmdir(tmpDir, { recursive: true })
      } catch { /* ignore cleanup errors */ }
    }
  }
}

/**
 * 恢复到幽灵提交状态
 * 使用 git restore 将工作区恢复到幽灵提交的状态
 * 
 * @param {string} repoPath - 仓库路径
 * @param {string} commitHash - 幽灵提交的 commit hash
 * @param {boolean} [restoreIndex=false] - 是否也恢复暂存区
 * @returns {Promise<{ok: boolean, message?: string, error?: string}>}
 */
export async function restoreGhostCommit(repoPath, commitHash, restoreIndex = false) {
  // 验证提交对象存在
  const catFileResult = await run(["cat-file", "-t", commitHash], repoPath)
  if (!catFileResult.ok || catFileResult.stdout.trim() !== "commit") {
    return { ok: false, error: `invalid commit hash: ${commitHash}` }
  }

  // 恢复工作区
  const restoreArgs = ["restore", "--source", commitHash, "."]
  const restoreResult = await run(restoreArgs, repoPath)
  if (!restoreResult.ok) {
    return { ok: false, error: `restore failed: ${restoreResult.stderr}` }
  }

  // 如果需要，也恢复暂存区
  if (restoreIndex) {
    const readTreeResult = await run(["read-tree", commitHash], repoPath)
    if (!readTreeResult.ok) {
      return { ok: false, error: `restore index failed: ${readTreeResult.stderr}` }
    }
  }

  return { ok: true, message: `restored to ${commitHash.slice(0, 8)}` }
}

/**
 * 应用 Patch (AI 生成的 diff)
 * 支持 git apply --3way 进行三方合并
 * 
 * @param {string} repoPath - 仓库路径
 * @param {string} diff - 统一格式的 diff 文本
 * @param {Object} options - 选项
 * @param {boolean} [options.threeway=true] - 使用三方合并
 * @param {boolean} [options.check=false] - 仅检查，不实际应用
 * @param {boolean} [options.whitespace="nowarn"] - 空白字符处理
 * @returns {Promise<{ok: boolean, applied?: string[], skipped?: string[], conflicts?: string[], error?: string}>}
 */
export async function applyPatch(repoPath, diff, options = {}) {
  const { 
    threeway = true, 
    check = false,
    whitespace = "nowarn"
  } = options

  // 创建临时 patch 文件
  let patchPath = null
  try {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "kkcode-patch-"))
    patchPath = path.join(tmpDir, "changes.patch")
    await writeFile(patchPath, diff, "utf8")

    // 构建 git apply 参数
    const applyArgs = ["apply"]
    if (threeway) applyArgs.push("--3way")
    if (check) applyArgs.push("--check")
    if (whitespace) applyArgs.push(`--whitespace=${whitespace}`)
    if (!check) applyArgs.push("-v") // verbose for parsing results
    applyArgs.push(patchPath)

    const result = await run(applyArgs, repoPath)

    // 解析结果
    if (!result.ok) {
      // 解析错误信息，提取冲突文件
      const conflictMatch = result.stderr.match(/error: patch failed: (.+)/g)
      const conflicts = conflictMatch 
        ? conflictMatch.map(m => m.replace(/error: patch failed: /, "").split(":")[0])
        : []
      
      return {
        ok: false,
        error: result.stderr,
        conflicts
      }
    }

    // 解析成功应用的文件
    const appliedMatch = result.stdout.match(/Applied patch to (.+)/g)
    const applied = appliedMatch
      ? appliedMatch.map(m => m.replace(/Applied patch to /, "").trim())
      : []

    return {
      ok: true,
      applied,
      skipped: [],
      conflicts: []
    }
  } catch (error) {
    return { ok: false, error: error.message }
  } finally {
    // 清理临时文件
    if (patchPath) {
      try {
        const tmpDir = path.dirname(patchPath)
        await unlink(patchPath)
        await rmdir(tmpDir)
      } catch { /* ignore cleanup errors */ }
    }
  }
}

/**
 * 预检 Patch - 检查 patch 是否可以应用，不实际修改文件
 * 
 * @param {string} repoPath - 仓库路径
 * @param {string} diff - 统一格式的 diff 文本
 * @returns {Promise<{applicable: boolean, conflicts?: string[], error?: string}>}
 */
export async function preflightPatch(repoPath, diff) {
  const result = await applyPatch(repoPath, diff, { check: true })
  return {
    applicable: result.ok,
    conflicts: result.conflicts,
    error: result.error
  }
}

/**
 * 获取 Git 仓库信息
 * 收集当前仓库的上下文信息供 AI 使用
 * 
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<{ok: boolean, info?: Object, error?: string}>}
 */
export async function getGitInfo(repoPath) {
  if (!(await isGitRepo(repoPath))) {
    return { ok: false, error: "not a git repository" }
  }

  try {
    // 并行获取各种信息
    const [
      branchResult,
      commitResult,
      remoteResult,
      statusResult,
      statusPorcelain
    ] = await Promise.all([
      run(["rev-parse", "--abbrev-ref", "HEAD"], repoPath),
      run(["rev-parse", "HEAD"], repoPath),
      run(["remote", "-v"], repoPath),
      run(["status", "--short"], repoPath),
      run(["status", "--porcelain"], repoPath)
    ])

    // 解析远程仓库信息
    const remotes = remoteResult.ok 
      ? remoteResult.stdout.split("\n")
          .filter(line => line.includes("(fetch)"))
          .map(line => {
            const parts = line.split(/\s+/)
            return { name: parts[0], url: parts[1] }
          })
      : []

    // 解析状态
    const hasUncommittedChanges = statusPorcelain.ok && statusPorcelain.stdout.trim() !== ""
    const changedFiles = statusPorcelain.ok 
      ? statusPorcelain.stdout.split("\n").filter(Boolean).map(line => ({
          status: line.slice(0, 2),
          path: line.slice(3)
        }))
      : []

    return {
      ok: true,
      info: {
        isGitRepo: true,
        currentBranch: branchResult.ok ? branchResult.stdout.trim() : null,
        currentCommit: commitResult.ok ? commitResult.stdout.trim() : null,
        remotes,
        hasUncommittedChanges,
        changedFiles,
        statusSummary: statusResult.ok ? statusResult.stdout : ""
      }
    }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/**
 * 获取当前工作目录与指定提交的 diff
 * 
 * @param {string} repoPath - 仓库路径
 * @param {string} [target="HEAD"] - 目标提交
 * @returns {Promise<{ok: boolean, diff?: string, error?: string}>}
 */
export async function getDiff(repoPath, target = "HEAD") {
  const result = await run(["diff", target], repoPath)
  return {
    ok: result.ok,
    diff: result.ok ? result.stdout : undefined,
    error: result.ok ? undefined : result.stderr
  }
}

/**
 * 获取暂存区的 diff
 * 
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<{ok: boolean, diff?: string, error?: string}>}
 */
export async function getStagedDiff(repoPath) {
  const result = await run(["diff", "--staged"], repoPath)
  return {
    ok: result.ok,
    diff: result.ok ? result.stdout : undefined,
    error: result.ok ? undefined : result.stderr
  }
}

// ============================================================================
// 内部工具函数
// ============================================================================

/** 生成幽灵提交ID */
function generateGhostCommitId() {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 8)
  return `gc_${timestamp}_${random}`
}
