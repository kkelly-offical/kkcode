import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, copyFile, writeFile, unlink, rm, readFile, realpath, stat, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runControlledGit } from "./controlled-git.mjs"

const GIT_TIMEOUT_MS = 30000
const WORKTREE_CLEANUP_TIMEOUT_MS = 5000

async function controlledRun(args, cwd = process.cwd(), timeoutMs = GIT_TIMEOUT_MS, env = {}, raw = false) {
  const result = await runControlledGit(args, { cwd, timeoutMs, env })
  return { ...result, stdout: raw ? result.stdout : result.stdout.trim(), stderr: result.stderr.trim() }
}

function run(args, cwd = process.cwd(), timeoutMs = GIT_TIMEOUT_MS, env = {}, raw = false) {
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
      resolve({ ok: code === 0, stdout: raw ? stdout : stdout.trim(), stderr: stderr.trim(), code })
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
export async function isClean(cwd = process.cwd(), timeoutMs = GIT_TIMEOUT_MS) {
  const result = await run(["status", "--porcelain"], cwd, timeoutMs)
  return result.ok && !result.stdout.trim()
}

/** List dirty paths in the working tree (porcelain output; rename 取新路径) */
export async function dirtyPaths(cwd = process.cwd()) {
  const result = await run(["status", "--porcelain"], cwd)
  if (!result.ok) return []
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const body = line.slice(2).trim()
      const arrow = body.lastIndexOf(" -> ")
      return (arrow >= 0 ? body.slice(arrow + 4) : body).replace(/^"|"$/g, "")
    })
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

/** Create a detached git worktree rooted at HEAD for isolated local execution */
export async function createDetachedWorktree(cwd = process.cwd(), label = "task") {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, error: "not a git repository" }
  }

  const prefix = `kkcode-worktree-${String(label || "task").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 24)}-`
  const worktreePath = await mkdtemp(path.join(tmpdir(), prefix))
  const addResult = await run(["worktree", "add", "--detach", worktreePath, "HEAD"], cwd, GIT_TIMEOUT_MS)
  if (!addResult.ok) {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: addResult.stderr || "git worktree add failed" }
  }
  return { ok: true, path: worktreePath }
}

let worktreeListSupportsNul = null

function parseWorktreeRecords(raw, separator) {
  const fields = separator === "\0"
    ? String(raw || "").split("\0")
    : String(raw || "").split(/\r?\n/)
  const records = []
  let current = null

  const flush = () => {
    if (current?.path) records.push(current)
    current = null
  }

  for (const field of fields) {
    if (!field) {
      flush()
      continue
    }
    if (field.startsWith("worktree ")) {
      if (current?.path) flush()
      current = {
        path: field.slice("worktree ".length),
        bare: false,
        locked: false
      }
      continue
    }
    if (!current) continue
    if (field === "bare") current.bare = true
    if (field === "locked" || field.startsWith("locked ")) current.locked = true
  }
  flush()
  return records
}

async function listWorktreeRecords(cwd, timeoutMs = WORKTREE_CLEANUP_TIMEOUT_MS) {
  if (worktreeListSupportsNul !== false) {
    const nulResult = await run(
      ["-c", "core.quotePath=false", "worktree", "list", "--porcelain", "-z"],
      cwd,
      timeoutMs
    )
    if (nulResult.ok) {
      worktreeListSupportsNul = true
      return { ok: true, records: parseWorktreeRecords(nulResult.stdout, "\0") }
    }
    const unsupported = nulResult.code === 129
      || /unknown (?:switch|option).*z/i.test(nulResult.stderr)
    if (!unsupported) {
      return { ok: false, message: nulResult.stderr || "git worktree list failed" }
    }
    worktreeListSupportsNul = false
  }

  const listed = await run(
    ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
    cwd,
    timeoutMs
  )
  return listed.ok
    ? { ok: true, records: parseWorktreeRecords(listed.stdout, "\n") }
    : { ok: false, message: listed.stderr || "git worktree list failed" }
}

async function existingPathIdentity(value, { directory = false } = {}) {
  const raw = String(value || "")
  if (!raw || /[\0\r\n]/.test(raw)) return null
  try {
    const canonicalPath = await realpath(path.resolve(raw))
    const info = await stat(canonicalPath, { bigint: true })
    if (directory && !info.isDirectory()) return null
    return {
      canonicalPath,
      dev: info.dev,
      ino: info.ino
    }
  } catch {
    return null
  }
}

function samePathIdentity(left, right) {
  if (!left || !right) return false
  const hasStableFileId = left.ino !== 0n && right.ino !== 0n
  if (hasStableFileId && left.dev === right.dev && left.ino === right.ino) {
    return true
  }
  return left.canonicalPath === right.canonicalPath
}

async function resolveRegisteredWorktree(worktreePath, cwd) {
  const target = await existingPathIdentity(worktreePath, { directory: true })
  if (!target) {
    return { ok: false, message: `refusing to remove an invalid worktree path: ${worktreePath}` }
  }

  const listed = await listWorktreeRecords(cwd)
  if (!listed.ok || listed.records.length === 0) {
    return { ok: false, message: listed.message || "no registered worktrees found" }
  }

  const records = await Promise.all(listed.records.map(async (record, index) => ({
    ...record,
    index,
    identity: await existingPathIdentity(record.path, { directory: true })
  })))
  const matches = records.filter((record) => samePathIdentity(record.identity, target))
  if (matches.length !== 1) {
    return {
      ok: false,
      message: `refusing to remove an unregistered or ambiguous worktree: ${worktreePath}`
    }
  }

  const matched = matches[0]
  if (matched.index === 0 || matched.bare) {
    return { ok: false, message: `refusing to remove the primary worktree: ${worktreePath}` }
  }
  if (matched.locked) {
    return { ok: false, message: `refusing to remove a locked worktree: ${worktreePath}` }
  }

  const currentResult = await run(
    ["rev-parse", "--show-toplevel"],
    cwd,
    WORKTREE_CLEANUP_TIMEOUT_MS
  )
  if (!currentResult.ok) {
    return { ok: false, message: currentResult.stderr || "failed to resolve the current worktree" }
  }
  const current = await existingPathIdentity(currentResult.stdout, { directory: true })
  if (!current || samePathIdentity(current, target)) {
    return { ok: false, message: `refusing to remove the current worktree: ${worktreePath}` }
  }

  let runtimeCwd
  try {
    runtimeCwd = process.cwd()
  } catch {
    return { ok: false, message: "refusing to remove a worktree while process cwd is unavailable" }
  }
  const runtimeResult = await run(
    ["rev-parse", "--show-toplevel"],
    runtimeCwd,
    WORKTREE_CLEANUP_TIMEOUT_MS
  )
  if (runtimeResult.ok) {
    const runtimeRoot = await existingPathIdentity(runtimeResult.stdout, { directory: true })
    if (!runtimeRoot) {
      return { ok: false, message: "failed to resolve the process current worktree" }
    }
    if (samePathIdentity(runtimeRoot, target)) {
      return {
        ok: false,
        message: `refusing to remove the process current worktree: ${worktreePath}`
      }
    }
  } else if (runtimeResult.code === null) {
    return {
      ok: false,
      message: runtimeResult.stderr || "failed to inspect the process current worktree"
    }
  }

  const targetRootResult = await run(
    ["rev-parse", "--show-toplevel"],
    target.canonicalPath,
    WORKTREE_CLEANUP_TIMEOUT_MS
  )
  const targetRoot = targetRootResult.ok
    ? await existingPathIdentity(targetRootResult.stdout, { directory: true })
    : null
  if (!targetRoot || !samePathIdentity(targetRoot, target)) {
    return {
      ok: false,
      message: `refusing to remove a worktree subdirectory: ${worktreePath}`
    }
  }

  return {
    ok: true,
    worktree: {
      ...matched,
      identity: target,
      canonicalPath: matched.identity.canonicalPath
    }
  }
}

function firstFileLine(content) {
  return String(content || "").split(/\r?\n/, 1)[0]
}

function resolveGitLink(link, baseDir) {
  return path.isAbsolute(link) ? link : path.resolve(baseDir, link)
}

async function resolveWindowsWorktreeMetadata(worktree, cwd) {
  const dotGitPath = path.join(worktree.canonicalPath, ".git")
  let dotGitContent
  try {
    dotGitContent = await readFile(dotGitPath, "utf8")
  } catch {
    return { ok: false, message: "worktree .git link is missing or unreadable" }
  }

  const gitDirMatch = /^gitdir: (.+)$/.exec(firstFileLine(dotGitContent))
  if (!gitDirMatch) {
    return { ok: false, message: "worktree .git link is malformed" }
  }
  const admin = await existingPathIdentity(
    resolveGitLink(gitDirMatch[1], path.dirname(dotGitPath)),
    { directory: true }
  )
  const dotGit = await existingPathIdentity(dotGitPath)
  if (!admin || !dotGit) {
    return { ok: false, message: "worktree administrative path is invalid" }
  }

  let commonDirContent
  let backLinkContent
  try {
    [commonDirContent, backLinkContent] = await Promise.all([
      readFile(path.join(admin.canonicalPath, "commondir"), "utf8"),
      readFile(path.join(admin.canonicalPath, "gitdir"), "utf8")
    ])
  } catch {
    return { ok: false, message: "worktree administrative links are incomplete" }
  }

  const commonDir = await existingPathIdentity(
    resolveGitLink(firstFileLine(commonDirContent), admin.canonicalPath),
    { directory: true }
  )
  const repositoryCommonResult = await run(
    ["rev-parse", "--git-common-dir"],
    cwd,
    WORKTREE_CLEANUP_TIMEOUT_MS
  )
  const repositoryCommonDir = repositoryCommonResult.ok
    ? await existingPathIdentity(
        resolveGitLink(firstFileLine(repositoryCommonResult.stdout), cwd),
        { directory: true }
      )
    : null
  const worktreesDir = commonDir
    ? await existingPathIdentity(path.join(commonDir.canonicalPath, "worktrees"), { directory: true })
    : null
  const adminParent = await existingPathIdentity(path.dirname(admin.canonicalPath), { directory: true })
  const backLink = await existingPathIdentity(
    resolveGitLink(firstFileLine(backLinkContent), admin.canonicalPath)
  )

  if (!commonDir
    || !repositoryCommonDir
    || !samePathIdentity(commonDir, repositoryCommonDir)
    || !worktreesDir
    || !adminParent
    || !samePathIdentity(worktreesDir, adminParent)
    || !backLink
    || !samePathIdentity(backLink, dotGit)
    || path.dirname(admin.canonicalPath) === admin.canonicalPath) {
    return { ok: false, message: "worktree administrative links failed identity validation" }
  }

  return { ok: true, admin, dotGit }
}

async function revalidateIdentity(identity, { directory = false } = {}) {
  const current = await existingPathIdentity(identity?.canonicalPath, { directory })
  return samePathIdentity(identity, current)
}

function lexicalPath(value) {
  return path.resolve(String(value || "")).replaceAll("\\", "/").toLowerCase()
}

function invalidRemovalPath(value) {
  return typeof value !== "string"
    || !value
    || /[\0\r\n]/.test(value)
    || !path.isAbsolute(value)
}

async function removeWindowsWorktree(worktree, cwd) {
  const metadata = await resolveWindowsWorktreeMetadata(worktree, cwd)
  if (!metadata.ok) return metadata

  if (!(await revalidateIdentity(worktree.identity, { directory: true }))
    || !(await revalidateIdentity(metadata.admin, { directory: true }))
    || !(await revalidateIdentity(metadata.dotGit))) {
    return { ok: false, message: "worktree identity changed before removal" }
  }

  try {
    await rm(worktree.canonicalPath, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100
    })
  } catch (error) {
    return {
      ok: false,
      message: `failed to remove worktree directory: ${error?.message || error}`
    }
  }

  if (!(await revalidateIdentity(metadata.admin, { directory: true }))) {
    return {
      ok: false,
      message: "worktree directory removed but its administrative identity changed"
    }
  }
  try {
    await rm(metadata.admin.canonicalPath, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100
    })
  } catch (error) {
    return {
      ok: false,
      message: `worktree directory removed but metadata cleanup failed: ${error?.message || error}`
    }
  }

  const verified = await listWorktreeRecords(cwd)
  const registeredPath = lexicalPath(worktree.path)
  const stillRegistered = verified.ok
    && verified.records.some((record) => lexicalPath(record.path) === registeredPath)
  return {
    ok: verified.ok && !stillRegistered,
    message: !verified.ok
      ? `worktree removed but registration verification failed: ${verified.message}`
      : stillRegistered
        ? "worktree removed but its registration is still present"
        : `removed worktree: ${worktree.canonicalPath}`
  }
}

/** Remove an existing git worktree */
export async function removeWorktree(worktreePath, cwd = process.cwd(), {
  platform = process.platform
} = {}) {
  if (invalidRemovalPath(worktreePath) || invalidRemovalPath(cwd)) {
    return {
      ok: false,
      message: "refusing to remove a worktree with a relative or invalid path"
    }
  }
  const resolved = await resolveRegisteredWorktree(worktreePath, cwd)
  if (!resolved.ok) return resolved
  const worktree = resolved.worktree

  if (platform === "win32") {
    return removeWindowsWorktree(worktree, cwd)
  }

  if (!(await revalidateIdentity(worktree.identity, { directory: true }))) {
    return { ok: false, message: "worktree identity changed before removal" }
  }
  const result = await run(
    ["worktree", "remove", "--force", worktree.canonicalPath],
    cwd,
    WORKTREE_CLEANUP_TIMEOUT_MS
  )
  return {
    ok: result.ok,
    message: result.ok
      ? `removed worktree: ${worktree.canonicalPath}`
      : result.stderr || "git worktree remove failed"
  }
}

/** Inspect a cleanup whose completion receipt was lost, without deleting again. */
export async function inspectWorktreeRemoval(worktreePath, cwd) {
  if (invalidRemovalPath(worktreePath) || invalidRemovalPath(cwd)) return { ok: false, removed: false }
  try {
    await lstat(worktreePath)
    return { ok: true, removed: false }
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, removed: false }
  }
  const listed = await listWorktreeRecords(cwd)
  if (!listed.ok) return { ok: false, removed: false }
  const normalize = value => process.platform === "win32" ? lexicalPath(value) : path.resolve(value)
  return { ok: true, removed: !listed.records.some(record => normalize(record.path) === normalize(worktreePath)) }
}

/**
 * 导出 detached worktree 相对 HEAD 的全部变更（含新文件与二进制）。
 *
 * 使用临时 index 生成 --cached diff，不改变候选的暂存状态（包括 dry-run）。
 * excludePaths 排除 worker 复制进去的工作区配置文件，免得
 * 回收时把它们误当成子智能体的产出带回主 checkout。
 */
export async function exportWorktreePatch(worktreePath, { excludePaths = [] } = {}) {
  if (!(await controlledRun(["rev-parse", "--is-inside-work-tree"], worktreePath)).ok) {
    return { ok: false, error: "not a git repository" }
  }
  const excludes = (Array.isArray(excludePaths) ? excludePaths : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => `:(exclude)${item}`)
  const { temp, env: objectEnv } = await temporaryGitObjects(worktreePath, "kkcode-export-")
  const env = { ...objectEnv, GIT_INDEX_FILE: path.join(temp, "index") }
  try {
    const readTree = await controlledRun(["read-tree", "HEAD"], worktreePath, GIT_TIMEOUT_MS, env)
    if (!readTree.ok) return { ok: false, error: `read-tree failed: ${readTree.stderr}` }
    const addResult = await controlledRun(["add", "-A", "--", ".", ...excludes], worktreePath, GIT_TIMEOUT_MS, env)
    if (!addResult.ok) {
      return { ok: false, error: `git add failed: ${addResult.stderr}` }
    }
    const filesResult = await controlledRun(["diff", "--cached", "--name-only", "-z", "HEAD"], worktreePath, GIT_TIMEOUT_MS, env, true)
    if (!filesResult.ok) {
      return { ok: false, error: `git diff failed: ${filesResult.stderr}` }
    }
    const files = filesResult.stdout.split("\0").filter(Boolean)
    if (files.length === 0) {
      return { ok: true, patch: "", files: [], empty: true }
    }
    const patchResult = await controlledRun(["diff", "--cached", "--binary", "HEAD"], worktreePath, GIT_TIMEOUT_MS, env, true)
    if (!patchResult.ok) {
      return { ok: false, error: `git diff failed: ${patchResult.stderr}` }
    }
    return { ok: true, patch: patchResult.stdout, files, empty: false }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/** Resolve actual checkout/common identities before taking a promotion lock. */
export async function repositoryIdentity(cwd) {
  const root = await controlledRun(["rev-parse", "--show-toplevel"], cwd)
  const common = await controlledRun(["rev-parse", "--git-common-dir"], cwd)
  if (!root.ok || !common.ok) throw new Error("cannot resolve repository identity")
  return {
    root: await realpath(root.stdout),
    commonDir: await realpath(path.resolve(cwd, common.stdout))
  }
}

async function temporaryGitObjects(cwd, prefix) {
  const objects = await controlledRun(["rev-parse", "--git-path", "objects"], cwd)
  if (!objects.ok) throw new Error("cannot resolve Git object directory")
  const originalObjects = await realpath(path.resolve(cwd, objects.stdout))
  const temp = await mkdtemp(path.join(tmpdir(), prefix))
  const objectDir = path.join(temp, "objects")
  await mkdir(objectDir, { mode: 0o700 })
  return { temp, env: {
    GIT_OBJECT_DIRECTORY: objectDir,
    // Git accepts C-style quoting, needed for separators/backslashes in paths.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(originalObjects),
    GIT_OPTIONAL_LOCKS: "0"
  } }
}

async function copyGitIndex(cwd, destination) {
  const result = await controlledRun(["rev-parse", "--git-path", "index"], cwd)
  if (!result.ok) throw new Error("cannot resolve Git index")
  try { await copyFile(path.resolve(cwd, result.stdout), destination) }
  catch (error) { if (error.code !== "ENOENT") throw error }
}

/**
 * Content fingerprints, not only porcelain names: concurrent edits to an already
 * dirty file must invalidate a promotion preflight. Never change the real index.
 * Ignored files are outside this Git snapshot, and unmerged indexes fail closed.
 */
export async function captureWorkingTreeState(cwd) {
  let temp
  try {
    const isolated = await temporaryGitObjects(cwd, "kkcode-tree-state-")
    temp = isolated.temp
    const readIndexTree = async name => {
      const indexPath = path.join(temp, name)
      await copyGitIndex(cwd, indexPath)
      return controlledRun(["write-tree"], cwd, GIT_TIMEOUT_MS, { ...isolated.env, GIT_INDEX_FILE: indexPath })
    }
    const head = await controlledRun(["rev-parse", "HEAD"], cwd)
    const index = await readIndexTree("before-index")
    const status = await controlledRun(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, GIT_TIMEOUT_MS, { GIT_OPTIONAL_LOCKS: "0" }, true)
    if (!head.ok || !index.ok || !status.ok) throw new Error("cannot fingerprint HEAD, index or working tree status")
    const env = { ...isolated.env, GIT_INDEX_FILE: path.join(temp, "index") }
    for (const args of [["read-tree", "HEAD"], ["add", "-A"]]) {
      const result = await controlledRun(args, cwd, GIT_TIMEOUT_MS, env)
      if (!result.ok) throw new Error(`cannot fingerprint working tree: ${result.stderr}`)
    }
    const tree = await controlledRun(["write-tree"], cwd, GIT_TIMEOUT_MS, env)
    const finalHead = await controlledRun(["rev-parse", "HEAD"], cwd)
    const finalIndex = await readIndexTree("after-index")
    const finalStatus = await controlledRun(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, GIT_TIMEOUT_MS, { GIT_OPTIONAL_LOCKS: "0" }, true)
    if (!tree.ok || !finalHead.ok || !finalIndex.ok || !finalStatus.ok
      || head.stdout !== finalHead.stdout || index.stdout !== finalIndex.stdout || status.stdout !== finalStatus.stdout) {
      throw new Error("repository changed while collecting its fingerprint")
    }
    const dirty = []
    const records = status.stdout.split("\0")
    for (let i = 0; i < records.length; i++) {
      const item = records[i]
      if (!item) continue
      dirty.push(item.slice(3))
      if (/[RC]/.test(item.slice(0, 2)) && records[i + 1]) dirty.push(records[++i])
    }
    return {
      ok: true,
      state: {
        head: head.stdout,
        indexTree: index.stdout,
        worktreeTree: tree.stdout,
        dirtyFingerprint: createHash("sha256").update(`${status.stdout}\0${index.stdout}\0${tree.stdout}`).digest("hex")
      },
      dirtyPaths: dirty
    }
  } catch (error) {
    return { ok: false, error: error.message }
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true })
  }
}

/** Predict the exact Git trees without touching either checkout or real index. */
export async function predictPromotionTrees(cwd, before, patch, { threeway = false } = {}) {
  const { temp, env: objectEnv } = await temporaryGitObjects(cwd, "kkcode-promotion-predict-")
  try {
    const patchFile = path.join(temp, "candidate.patch")
    await writeFile(patchFile, patch, { encoding: "utf8", mode: 0o600 })
    const applyTo = async (tree, name) => {
      const indexFile = path.join(temp, name)
      const env = { ...objectEnv, GIT_INDEX_FILE: indexFile }
      if (name === "worktree-index") {
        for (const args of [["read-tree", before.head], ["add", "-A"]]) {
          const result = await controlledRun(args, cwd, GIT_TIMEOUT_MS, env)
          if (!result.ok) throw new Error(result.stderr)
        }
      } else await copyGitIndex(cwd, indexFile)
      const source = await controlledRun(["write-tree"], cwd, GIT_TIMEOUT_MS, env)
      if (!source.ok) throw new Error(source.stderr || "could not inspect source for patch prediction")
      if (source.stdout !== tree) throw Object.assign(new Error("source changed while predicting patch result"), { code: "promotion_baseline_changed" })
      const applied = await controlledRun(["apply", "--cached", "--whitespace=nowarn", ...(threeway ? ["--3way"] : []), patchFile], cwd, GIT_TIMEOUT_MS, env)
      if (!applied.ok) throw new Error(applied.stderr)
      const result = await controlledRun(["write-tree"], cwd, GIT_TIMEOUT_MS, env)
      if (!result.ok) throw new Error(result.stderr)
      return result.stdout
    }
    return {
      ok: true,
      head: before.head,
      worktreeTree: await applyTo(before.worktreeTree, "worktree-index"),
      indexTree: threeway ? await applyTo(before.indexTree, "staging-index") : before.indexTree
    }
  } catch (error) {
    return { ok: false, error: error.message, code: error.code }
  } finally { await rm(temp, { recursive: true, force: true }) }
}

/** Keep recovery objects reachable by Git GC until explicit retention cleanup. */
export async function retainPromotionSnapshot(cwd, operationId, commit, indexTree) {
  if (!/^[a-f0-9]{64}$/.test(operationId)
    || !/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{40,64}$/.test(indexTree)) {
    return { ok: false, error: "invalid promotion recovery reference" }
  }
  // Fingerprinting stores trees only in ephemeral object directories. Now that
  // an actual promotion is authorized, materialize the recovery index tree in
  // the real object store without updating the user's index or staging area.
  const temp = await mkdtemp(path.join(tmpdir(), "kkcode-promote-index-"))
  try {
    const indexPath = path.join(temp, "index")
    await copyGitIndex(cwd, indexPath)
    const materialized = await controlledRun(["write-tree"], cwd, GIT_TIMEOUT_MS, { GIT_INDEX_FILE: indexPath })
    if (!materialized.ok || materialized.stdout !== indexTree) return { ok: false, error: "staging index changed before retaining recovery objects" }
  } finally { await rm(temp, { recursive: true, force: true }) }
  for (const [suffix, object] of [["before", commit], ["index", indexTree]]) {
    const result = await controlledRun(["update-ref", `refs/kkcode/promotions/${operationId}/${suffix}`, object], cwd)
    if (!result.ok) return { ok: false, error: result.stderr }
  }
  return { ok: true }
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
 * @property {string} treeHash - 快照工作树内容指纹
 * @property {string} message - 提交信息
 * @property {number} createdAt - 创建时间戳
 * @property {string[]} files - 包含的文件列表
 * @property {string} [sessionId] - 创建该快照的 KK Code 会话（旧记录可缺省）
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
export async function createGhostCommit(repoPath, message = "kkcode snapshot", paths = [], { controlled = false } = {}) {
  const runner = controlled ? controlledRun : run
  // 检查是否是 Git 仓库
  if (!(await runner(["rev-parse", "--is-inside-work-tree"], repoPath)).ok) {
    return { ok: false, error: "not a git repository" }
  }

  // 获取当前 HEAD
  const headResult = await runner(["rev-parse", "HEAD"], repoPath)
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
    const readTreeResult = await runner(
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
    const addResult = await runner(
      addArgs,
      repoPath,
      GIT_TIMEOUT_MS,
      { GIT_INDEX_FILE: indexPath }
    )
    if (!addResult.ok) {
      return { ok: false, error: `git add failed: ${addResult.stderr}` }
    }

    // 3. 写入树对象
    const writeTreeResult = await runner(
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
    const commitTreeResult = await runner(
      ["commit-tree", treeHash, "-p", parentHash, "-m", message],
      repoPath, GIT_TIMEOUT_MS, controlled ? {
        GIT_AUTHOR_NAME: "KK Code Recovery", GIT_AUTHOR_EMAIL: "recovery@kkcode.local",
        GIT_COMMITTER_NAME: "KK Code Recovery", GIT_COMMITTER_EMAIL: "recovery@kkcode.local"
      } : {}
    )
    if (!commitTreeResult.ok) {
      return { ok: false, error: `commit-tree failed: ${commitTreeResult.stderr}` }
    }
    const commitHash = commitTreeResult.stdout.trim()

    // 5. 获取包含的文件列表
    const diffResult = await runner(
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
        treeHash,
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
        await rm(tmpDir, { recursive: true, force: true })
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
 * @param {boolean} [options.controlled=false] - 禁止宿主执行仓库配置代码
 * @param {boolean} [options.whitespace="nowarn"] - 空白字符处理
 * @returns {Promise<{ok: boolean, applied?: string[], skipped?: string[], conflicts?: string[], error?: string}>}
 */
export async function applyPatch(repoPath, diff, options = {}) {
  const { 
    threeway = true, 
    check = false,
    controlled = false,
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

    const result = await (controlled ? controlledRun : run)(applyArgs, repoPath)

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
        await rm(tmpDir, { recursive: true, force: true })
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
// Conflict Detection Helpers
// ============================================================================

/** Check if an error is a merge conflict */
export function isConflictError(error) {
  const msg = String(error?.message || error || "")
  return msg.includes("CONFLICT") || msg.includes("Merge conflict") || msg.includes("merge conflict")
}

/** Get list of files with merge conflicts */
export async function getConflictFiles(cwd = process.cwd()) {
  const result = await run(["diff", "--name-only", "--diff-filter=U"], cwd)
  if (!result.ok) return []
  return result.stdout.trim().split("\n").filter(Boolean)
}

/** Abort an in-progress merge */
export async function mergeAbort(cwd = process.cwd()) {
  const result = await run(["merge", "--abort"], cwd)
  return { ok: result.ok, message: result.ok ? "merge aborted" : result.stderr }
}

/** Get current HEAD commit hash (for rollback savepoints) */
export async function getHeadHash(cwd = process.cwd()) {
  const result = await run(["rev-parse", "HEAD"], cwd)
  return result.ok ? result.stdout.trim() : null
}

/** Hard reset to a specific commit (rollback) */
export async function resetTo(ref, cwd = process.cwd()) {
  const result = await run(["reset", "--hard", ref], cwd)
  return { ok: result.ok, message: result.ok ? `reset to ${ref}` : result.stderr }
}

/** Check if conflict markers remain in working tree */
export async function hasConflictMarkers(cwd = process.cwd()) {
  const result = await run(["diff", "--check"], cwd)
  return !result.ok
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
