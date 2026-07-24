import { describe, it } from "node:test"
import assert from "node:assert"
import { mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

// 测试 Git 自动化功能
// 注意：这些测试需要在有 Git 环境的系统上运行

import {
  isGitRepo,
  isClean,
  createDetachedWorktree,
  createGhostCommit,
  restoreGhostCommit,
  applyPatch,
  preflightPatch,
  getGitInfo,
  getDiff,
  removeWorktree
} from "../src/util/git.mjs"

import {
  saveGhostCommit,
  loadGhostCommit,
  listGhostCommits,
  deleteGhostCommit,
  cleanupAllExpired
} from "../src/storage/ghost-commit-store.mjs"

import {
  checkBashAllowed,
  evaluateCommand,
  Decision
} from "../src/permission/exec-policy.mjs"

describe("Git Auto - Unit Tests", () => {
  describe("Execution Policy", () => {
    it("should forbid git commit", () => {
      const result = evaluateCommand("git commit -m 'test'")
      assert.strictEqual(result.decision, Decision.FORBID)
      assert.ok(result.reason.includes("git commit"))
    })

    it("should forbid git push", () => {
      const result = evaluateCommand("git push origin main")
      assert.strictEqual(result.decision, Decision.FORBID)
      assert.ok(result.reason.includes("push"))
    })

    it("should forbid git push --force", () => {
      const result = evaluateCommand("git push origin main --force")
      assert.strictEqual(result.decision, Decision.FORBID)
    })

    it("should forbid git reset --hard", () => {
      const result = evaluateCommand("git reset --hard HEAD~1")
      assert.strictEqual(result.decision, Decision.FORBID)
    })

    it("should allow git status", () => {
      const result = evaluateCommand("git status")
      assert.strictEqual(result.decision, Decision.ALLOW)
    })

    it("should allow git log", () => {
      const result = evaluateCommand("git log --oneline")
      assert.strictEqual(result.decision, Decision.ALLOW)
    })

    it("should check bash allowed with config", () => {
      const result = checkBashAllowed("git commit -m 'test'", {
        git_auto: { forbid_commit: true }
      })
      assert.strictEqual(result.allowed, false)
      assert.ok(result.reason.includes("forbidden"))
    })
  })
})

describe("Git Auto - Integration Tests", () => {
  let testRepoPath = null
  let originalCwd = process.cwd()

  function git(...args) {
    return execFileSync("git", args, {
      cwd: testRepoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
  }

  // 在所有测试前创建临时 Git 仓库
  async function setupTestRepo() {
    testRepoPath = await mkdtemp(path.join(tmpdir(), "kkcode-test-"))
    
    // 初始化 Git 仓库
    git("init")
    git("config", "user.email", "test@test.com")
    git("config", "user.name", "Test User")
    git("config", "core.autocrlf", "false")
    
    // 创建初始提交
    await writeFile(path.join(testRepoPath, "initial.txt"), "initial content")
    git("add", ".")
    git("commit", "-m", "initial commit")
    
    return testRepoPath
  }

  // 清理临时仓库
  async function cleanupTestRepo() {
    if (testRepoPath) {
      try {
        await rm(testRepoPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch { /* ignore */ }
    }
    process.chdir(originalCwd)
  }

  describe("Git Utilities", () => {
    it("should detect git repository", async () => {
      await setupTestRepo()
      const isRepo = await isGitRepo(testRepoPath)
      assert.strictEqual(isRepo, true)
      assert.strictEqual(await isClean(testRepoPath, 5000), true)
      await cleanupTestRepo()
    })

    it("should detect non-git directory", async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "non-git-"))
      const isRepo = await isGitRepo(tmpDir)
      assert.strictEqual(isRepo, false)
      await rm(tmpDir, { recursive: true, force: true })
    })

    it("should get git info", async () => {
      await setupTestRepo()
      const result = await getGitInfo(testRepoPath)
      assert.strictEqual(result.ok, true)
      assert.ok(result.info.currentBranch)
      assert.ok(result.info.currentCommit)
      assert.strictEqual(result.info.hasUncommittedChanges, false)
      await cleanupTestRepo()
    })

    it("should detect uncommitted changes", async () => {
      await setupTestRepo()
      
      // 创建未提交的更改
      await writeFile(path.join(testRepoPath, "newfile.txt"), "new content")
      
      const result = await getGitInfo(testRepoPath)
      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.info.hasUncommittedChanges, true)
      assert.ok(result.info.changedFiles.length > 0)
      
      await cleanupTestRepo()
    })

    it("should create and remove a detached local worktree", async () => {
      await setupTestRepo()

      const created = await createDetachedWorktree(testRepoPath, "worker-test")
      assert.strictEqual(created.ok, true)
      assert.ok(created.path)
      assert.strictEqual(await isGitRepo(created.path), true)

      const removed = await removeWorktree(created.path, testRepoPath)
      assert.strictEqual(removed.ok, true)

      await cleanupTestRepo()
    })

    it("should remove a detached worktree with the Windows-safe metadata strategy", async () => {
      await setupTestRepo()
      let created = null
      try {
        const refusedPrimary = await removeWorktree(testRepoPath, testRepoPath, { platform: "win32" })
        assert.strictEqual(refusedPrimary.ok, false)
        assert.strictEqual(await isGitRepo(testRepoPath), true)

        created = await createDetachedWorktree(testRepoPath, "worker-windows")
        assert.strictEqual(created.ok, true)

        const removed = await removeWorktree(created.path, testRepoPath, { platform: "win32" })
        assert.strictEqual(removed.ok, true)
        assert.strictEqual(await isGitRepo(created.path), false)

        const listed = git("worktree", "list", "--porcelain")
          .replaceAll("\\", "/")
          .toLowerCase()
        assert.strictEqual(listed.includes(created.path.replaceAll("\\", "/").toLowerCase()), false)
      } finally {
        if (created?.path) {
          await removeWorktree(created.path, testRepoPath).catch(() => {})
        }
        await cleanupTestRepo()
      }
    })

    it("should resolve a registered worktree through a filesystem alias before removal", async () => {
      await setupTestRepo()
      let created = null
      let aliasRoot = null
      try {
        created = await createDetachedWorktree(testRepoPath, "worker-alias")
        assert.strictEqual(created.ok, true)

        aliasRoot = await mkdtemp(path.join(tmpdir(), "kkcode-worktree-alias-"))
        const aliasPath = path.join(aliasRoot, "linked-worktree")
        await symlink(created.path, aliasPath, process.platform === "win32" ? "junction" : "dir")

        const removed = await removeWorktree(aliasPath, testRepoPath, { platform: "win32" })
        assert.strictEqual(removed.ok, true)
        assert.strictEqual(await isGitRepo(created.path), false)
      } finally {
        if (created?.path) {
          await removeWorktree(created.path, testRepoPath).catch(() => {})
        }
        if (aliasRoot) {
          await rm(aliasRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
        await cleanupTestRepo()
      }
    })

    it("should refuse primary, current, child, locked, and unregistered removal targets", async () => {
      await setupTestRepo()
      let created = null
      let safetyRoot = null
      try {
        safetyRoot = await mkdtemp(path.join(tmpdir(), "kkcode-worktree-safety-"))
        const primaryAlias = path.join(safetyRoot, "primary-alias")
        await symlink(testRepoPath, primaryAlias, process.platform === "win32" ? "junction" : "dir")

        const refusedPrimary = await removeWorktree(primaryAlias, testRepoPath, { platform: "win32" })
        assert.strictEqual(refusedPrimary.ok, false)
        assert.match(refusedPrimary.message, /primary worktree/)
        assert.strictEqual(await isGitRepo(testRepoPath), true)

        created = await createDetachedWorktree(testRepoPath, "worker-safety")
        assert.strictEqual(created.ok, true)

        const relativeTarget = path.relative(process.cwd(), created.path)
        for (const invalidTarget of [
          relativeTarget,
          `${created.path}\0suffix`,
          `${created.path}\rsuffix`,
          `${created.path}\nsuffix`
        ]) {
          const refusedInvalid = await removeWorktree(invalidTarget, testRepoPath)
          assert.strictEqual(refusedInvalid.ok, false)
          assert.match(refusedInvalid.message, /relative or invalid path/)
        }
        const refusedRelativeCwd = await removeWorktree(created.path, "relative-repository")
        assert.strictEqual(refusedRelativeCwd.ok, false)
        assert.match(refusedRelativeCwd.message, /relative or invalid path/)
        assert.strictEqual(await isGitRepo(created.path), true)

        const refusedCurrent = await removeWorktree(created.path, created.path, { platform: "win32" })
        assert.strictEqual(refusedCurrent.ok, false)
        assert.match(refusedCurrent.message, /current worktree/)

        const childPath = path.join(created.path, "nested")
        await mkdir(childPath)
        await writeFile(path.join(childPath, "keep.txt"), "keep\n")
        const refusedChild = await removeWorktree(childPath, testRepoPath)
        assert.strictEqual(refusedChild.ok, false)
        assert.strictEqual(await readFile(path.join(childPath, "keep.txt"), "utf8"), "keep\n")

        process.chdir(childPath)
        try {
          const refusedProcessCurrent = await removeWorktree(
            created.path,
            testRepoPath,
            { platform: "win32" }
          )
          assert.strictEqual(refusedProcessCurrent.ok, false)
          assert.match(refusedProcessCurrent.message, /process current worktree/)
        } finally {
          process.chdir(testRepoPath)
        }

        const unregistered = path.join(safetyRoot, "unregistered")
        await mkdir(unregistered)
        await writeFile(path.join(unregistered, "keep.txt"), "keep\n")
        const refusedUnregistered = await removeWorktree(unregistered, testRepoPath)
        assert.strictEqual(refusedUnregistered.ok, false)
        assert.strictEqual(await readFile(path.join(unregistered, "keep.txt"), "utf8"), "keep\n")

        git("worktree", "lock", created.path)
        const refusedLocked = await removeWorktree(created.path, testRepoPath, { platform: "win32" })
        assert.strictEqual(refusedLocked.ok, false)
        assert.match(refusedLocked.message, /locked worktree/)
        git("worktree", "unlock", created.path)

        const removed = await removeWorktree(created.path, testRepoPath, { platform: "win32" })
        assert.strictEqual(removed.ok, true)
      } finally {
        if (created?.path) {
          try {
            git("worktree", "unlock", created.path)
          } catch { /* already unlocked or removed */ }
          await removeWorktree(created.path, testRepoPath).catch(() => {})
        }
        if (safetyRoot) {
          await rm(safetyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
        await cleanupTestRepo()
      }
    })
  })

  describe("Ghost Commit", () => {
    it("should create ghost commit", async () => {
      await setupTestRepo()
      
      // 创建一些更改
      await writeFile(path.join(testRepoPath, "test.txt"), "test content")
      
      const result = await createGhostCommit(testRepoPath, "test snapshot")
      assert.strictEqual(result.ok, true)
      assert.ok(result.ghostCommit)
      assert.ok(result.ghostCommit.id)
      assert.ok(result.ghostCommit.commitHash)
      assert.strictEqual(result.ghostCommit.message, "test snapshot")
      assert.ok(result.ghostCommit.files.includes("test.txt"))
      
      await cleanupTestRepo()
    })

    it("should fail ghost commit for non-git directory", async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "non-git-"))
      const result = await createGhostCommit(tmpDir, "test")
      assert.strictEqual(result.ok, false)
      assert.ok(result.error.includes("not a git"))
      await rm(tmpDir, { recursive: true, force: true })
    })
  })

  describe("Patch Application", () => {
    it("should preflight patch successfully", async () => {
      await setupTestRepo()
      
      // 先写入原始内容
      await writeFile(path.join(testRepoPath, "patch.txt"), "hello world\n")
      git("add", ".")
      git("commit", "-m", "add file")
      
      // 创建一个可以应用的 patch
      const diff = `diff --git a/patch.txt b/patch.txt
--- a/patch.txt
+++ b/patch.txt
@@ -1 +1 @@
-hello world
+hello kkcode
`
      
      const result = await preflightPatch(testRepoPath, diff)
      assert.strictEqual(result.applicable, true)
      
      await cleanupTestRepo()
    })

    it("should detect non-applicable patch", async () => {
      await setupTestRepo()
      
      // 创建一个无法应用的 patch（文件不存在）
      const diff = `diff --git a/nonexistent.txt b/nonexistent.txt
--- a/nonexistent.txt
+++ b/nonexistent.txt
@@ -1 +1 @@
-old content
+new content
`
      
      const result = await preflightPatch(testRepoPath, diff)
      assert.strictEqual(result.applicable, false)
      
      await cleanupTestRepo()
    })

    it("should apply patch successfully", async () => {
      await setupTestRepo()
      
      // 写入原始内容
      const filePath = path.join(testRepoPath, "apply.txt")
      await writeFile(filePath, "original content\n")
      git("add", ".")
      git("commit", "-m", "add file")
      
      // 创建 patch
      const diff = `diff --git a/apply.txt b/apply.txt
--- a/apply.txt
+++ b/apply.txt
@@ -1 +1 @@
-original content
+patched content
`
      
      const result = await applyPatch(testRepoPath, diff)
      assert.strictEqual(result.ok, true)
      
      // 验证文件内容
      const content = await readFile(filePath, "utf8")
      assert.strictEqual(content.trim(), "patched content")
      
      await cleanupTestRepo()
    })
  })

  describe("Ghost Commit Storage", () => {
    it("should save and load ghost commit", async () => {
      await setupTestRepo()
      
      const ghostCommit = {
        id: "gc_test_123",
        commitHash: "abc123def456",
        repoPath: testRepoPath,
        parentHash: "parent789",
        message: "test ghost commit",
        createdAt: Date.now(),
        files: ["test.js"]
      }
      
      const saveResult = await saveGhostCommit(ghostCommit)
      assert.strictEqual(saveResult.ok, true)
      
      const loaded = await loadGhostCommit(testRepoPath, "gc_test_123")
      assert.ok(loaded)
      assert.strictEqual(loaded.id, "gc_test_123")
      assert.strictEqual(loaded.message, "test ghost commit")
      
      // 清理
      await deleteGhostCommit(testRepoPath, "gc_test_123")
      await cleanupTestRepo()
    })

    it("should list ghost commits", async () => {
      await setupTestRepo()
      
      // 保存几个测试提交
      for (let i = 0; i < 3; i++) {
        await saveGhostCommit({
          id: `gc_test_${i}`,
          commitHash: `hash${i}`,
          repoPath: testRepoPath,
          parentHash: "parent",
          message: `test ${i}`,
          createdAt: Date.now() - i * 1000,
          files: []
        })
      }
      
      const commits = await listGhostCommits(testRepoPath)
      assert.ok(commits.length >= 3)
      
      // 验证按时间排序（最新的在前）
      assert.ok(commits[0].createdAt >= commits[1].createdAt)
      
      // 清理
      for (let i = 0; i < 3; i++) {
        await deleteGhostCommit(testRepoPath, `gc_test_${i}`)
      }
      await cleanupTestRepo()
    })

    it("should cleanup expired commits", async () => {
      await setupTestRepo()
      
      // 保存一个已过期的提交
      const expiredCommit = {
        id: "gc_expired",
        commitHash: "expired123",
        repoPath: testRepoPath,
        parentHash: "parent",
        message: "expired",
        createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10天前
        files: []
      }
      
      await saveGhostCommit(expiredCommit)
      
      // 列出（不包含过期）
      const activeCommits = await listGhostCommits(testRepoPath, { includeExpired: false })
      const hasExpired = activeCommits.some(c => c.id === "gc_expired")
      assert.strictEqual(hasExpired, false)
      
      // 列出（包含过期）
      const allCommits = await listGhostCommits(testRepoPath, { includeExpired: true })
      const hasExpiredInAll = allCommits.some(c => c.id === "gc_expired")
      assert.strictEqual(hasExpiredInAll, true)
      
      await cleanupTestRepo()
    })
  })
})

// 辅助函数
async function mkdtemp(prefix) {
  const { mkdtemp: realMkdtemp } = await import("node:fs/promises")
  return realMkdtemp(prefix)
}

async function readFile(path, encoding) {
  const { readFile: realReadFile } = await import("node:fs/promises")
  return realReadFile(path, encoding)
}
