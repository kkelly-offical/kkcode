import { describe, it } from "node:test"
import assert from "node:assert"
import { mkdir, writeFile, rmdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"

// 测试 Git 自动化功能
// 注意：这些测试需要在有 Git 环境的系统上运行

import {
  isGitRepo,
  createGhostCommit,
  restoreGhostCommit,
  applyPatch,
  preflightPatch,
  getGitInfo,
  getDiff
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

  // 在所有测试前创建临时 Git 仓库
  async function setupTestRepo() {
    testRepoPath = await mkdtemp(path.join(tmpdir(), "kkcode-test-"))
    
    // 初始化 Git 仓库
    execSync("git init", { cwd: testRepoPath })
    execSync("git config user.email 'test@test.com'", { cwd: testRepoPath })
    execSync("git config user.name 'Test User'", { cwd: testRepoPath })
    
    // 创建初始提交
    await writeFile(path.join(testRepoPath, "initial.txt"), "initial content")
    execSync("git add .", { cwd: testRepoPath })
    execSync("git commit -m 'initial commit'", { cwd: testRepoPath })
    
    return testRepoPath
  }

  // 清理临时仓库
  async function cleanupTestRepo() {
    if (testRepoPath) {
      try {
        await rmdir(testRepoPath, { recursive: true })
      } catch { /* ignore */ }
    }
    process.chdir(originalCwd)
  }

  describe("Git Utilities", () => {
    it("should detect git repository", async () => {
      await setupTestRepo()
      const isRepo = await isGitRepo(testRepoPath)
      assert.strictEqual(isRepo, true)
      await cleanupTestRepo()
    })

    it("should detect non-git directory", async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "non-git-"))
      const isRepo = await isGitRepo(tmpDir)
      assert.strictEqual(isRepo, false)
      await rmdir(tmpDir, { recursive: true })
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
      await rmdir(tmpDir, { recursive: true })
    })
  })

  describe("Patch Application", () => {
    it("should preflight patch successfully", async () => {
      await setupTestRepo()
      
      // 先写入原始内容
      await writeFile(path.join(testRepoPath, "patch.txt"), "hello world\n")
      execSync("git add . && git commit -m 'add file'", { cwd: testRepoPath })
      
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
      execSync("git add . && git commit -m 'add file'", { cwd: testRepoPath })
      
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
