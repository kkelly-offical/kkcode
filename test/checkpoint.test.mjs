import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  saveCheckpoint, loadCheckpoint, listCheckpoints,
  saveTaskCheckpoint, loadTaskCheckpoints
} from "../src/session/checkpoint.mjs"

let tmpDir

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cp-test-"))
  process.env.KKCODE_HOME = tmpDir
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

describe("checkpoint save/load", () => {
  it("saveCheckpoint and loadCheckpoint roundtrip", async () => {
    const cp = await saveCheckpoint("sess1", { iteration: 3, phase: "coding", model: "gpt-4" })
    assert.equal(cp.sessionId, "sess1")
    assert.equal(cp.phase, "coding")
    assert.ok(cp.savedAt)

    const loaded = await loadCheckpoint("sess1")
    assert.equal(loaded.iteration, 3)
    assert.equal(loaded.phase, "coding")
  })

  it("loadCheckpoint returns null for missing", async () => {
    const loaded = await loadCheckpoint("nonexistent")
    assert.equal(loaded, null)
  })

  it("saveCheckpoint creates numbered copy", async () => {
    await saveCheckpoint("sess2", { iteration: 5 })
    const loaded = await loadCheckpoint("sess2", "cp_5")
    assert.equal(loaded.iteration, 5)
  })
})

describe("listCheckpoints", () => {
  it("lists all checkpoint names sorted", async () => {
    await saveCheckpoint("sess3", { iteration: 0 })
    await saveCheckpoint("sess3", { iteration: 1 })
    const names = await listCheckpoints("sess3")
    assert.ok(names.includes("latest"))
    assert.ok(names.includes("cp_0"))
    assert.ok(names.includes("cp_1"))
  })

  it("returns empty for nonexistent session", async () => {
    const names = await listCheckpoints("nope")
    assert.deepEqual(names, [])
  })
})

describe("task checkpoints", () => {
  it("saveTaskCheckpoint and loadTaskCheckpoints roundtrip", async () => {
    await saveTaskCheckpoint("sess4", "stage1", "taskA", { status: "completed", files: ["a.js"] })
    await saveTaskCheckpoint("sess4", "stage1", "taskB", { status: "error", files: [] })

    const loaded = await loadTaskCheckpoints("sess4", "stage1")
    assert.equal(loaded.taskA.status, "completed")
    assert.equal(loaded.taskB.status, "error")
    assert.deepEqual(loaded.taskA.files, ["a.js"])
  })

  it("loadTaskCheckpoints returns empty for missing stage", async () => {
    const loaded = await loadTaskCheckpoints("sess5", "nope")
    assert.deepEqual(loaded, {})
  })

  it("task checkpoints include metadata", async () => {
    const cp = await saveTaskCheckpoint("sess6", "s1", "t1", { reply: "done" })
    assert.equal(cp.sessionId, "sess6")
    assert.equal(cp.stageId, "s1")
    assert.equal(cp.taskId, "t1")
    assert.ok(cp.savedAt)
  })
})

// ---------------------------------------------------------------------------
// 会话快照过滤。旧过滤条件是 `session: <id>` 或 "Auto snapshot" —— 后者
// 使所有自动快照（无论属于哪个会话）都被算进当前会话，restoreLastSessionSnapshot
// 可能恢复到同一仓库下**别的会话**的快照。修复后：新记录按 sessionId 字段
// 精确匹配；老记录（无该字段）退回 message 里的 session 标记。
// ---------------------------------------------------------------------------
describe("getSessionSnapshots session isolation", () => {
  it("excludes other sessions' auto snapshots, keeps legacy records with a session marker", async () => {
    const { execFileSync } = await import("node:child_process")
    const { getSessionSnapshots } = await import("../src/session/checkpoint.mjs")
    const { saveGhostCommit } = await import("../src/storage/ghost-commit-store.mjs")

    const repoDir = path.join(tmpDir, "repo")
    execFileSync("git", ["init", repoDir], { stdio: "ignore" })

    const now = Date.now()
    // 当前会话的新记录（带 sessionId 字段）
    await saveGhostCommit({
      id: "a1", commitHash: "ha", repoPath: repoDir, parentHash: "p",
      sessionId: "sessA", message: "Auto snapshot before AI edit (session: sessA)",
      createdAt: now, files: []
    })
    // 别的会话的自动快照 —— 旧过滤会因 "Auto snapshot" 文案把它算进来
    await saveGhostCommit({
      id: "b1", commitHash: "hb", repoPath: repoDir, parentHash: "p",
      sessionId: "sessB", message: "Auto snapshot before AI edit (session: sessB)",
      createdAt: now - 1000, files: []
    })
    // 新字段优先：即使 message 矛盾地写着 sessA，也不能把 sessB 的记录收进来。
    await saveGhostCommit({
      id: "conflict", commitHash: "hc", repoPath: repoDir, parentHash: "p",
      sessionId: "sessB", message: "Auto snapshot before AI edit (session: sessA)",
      createdAt: now - 1500, files: []
    })
    // 老版本记录：无 sessionId 字段，靠 message 里的 session 标记归属当前会话
    await saveGhostCommit({
      id: "l1", commitHash: "hl", repoPath: repoDir, parentHash: "p",
      message: "Auto snapshot before AI edit (session: sessA)",
      createdAt: now - 2000, files: []
    })
    // 前缀相同仍是另一个会话；includes("session: sessA") 会误收。
    await saveGhostCommit({
      id: "lp1", commitHash: "hlp", repoPath: repoDir, parentHash: "p",
      message: "Auto snapshot before AI edit (session: sessA-child)",
      createdAt: now - 3000, files: []
    })

    const snapshots = await getSessionSnapshots("sessA", repoDir)
    assert.deepEqual(snapshots.map((s) => s.id), ["a1", "l1"])
  })

  it("persists session identity through the real snapshot path and restores only that session", async () => {
    const { execFileSync } = await import("node:child_process")
    const {
      autoSnapshotBeforeEdit,
      getSessionSnapshots,
      restoreLastSessionSnapshot
    } = await import("../src/session/checkpoint.mjs")
    const { listGhostCommits } = await import("../src/storage/ghost-commit-store.mjs")

    const repoDir = path.join(tmpDir, "real-snapshot-repo")
    execFileSync("git", ["init", repoDir], { stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir })
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir })
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repoDir })
    const target = path.join(repoDir, "state.txt")
    await writeFile(target, "base\n")
    execFileSync("git", ["add", "state.txt"], { cwd: repoDir })
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoDir, stdio: "ignore" })

    await writeFile(target, "session-a\n")
    const preexistingUntracked = path.join(repoDir, "preexisting.txt")
    await writeFile(preexistingUntracked, "present-before-snapshot\n")
    const a = await autoSnapshotBeforeEdit("sessA", repoDir, {}, { reason: "custom reason" })
    assert.equal(a.ok, true)

    await writeFile(target, "session-b\n")
    const b = await autoSnapshotBeforeEdit("sessB", repoDir)
    assert.equal(b.ok, true)

    const stored = await listGhostCommits(repoDir)
    assert.equal(stored.find((entry) => entry.id === a.snapshot.id)?.sessionId, "sessA")
    assert.equal(stored.find((entry) => entry.id === b.snapshot.id)?.sessionId, "sessB")
    assert.ok(stored.find((entry) => entry.id === a.snapshot.id)?.message.endsWith("(session: sessA)"),
      "自定义 reason 也必须带会话标记")
    assert.deepEqual((await getSessionSnapshots("sessA", repoDir)).map((entry) => entry.id), [a.snapshot.id])

    await writeFile(target, "after-both\n")
    const createdAfter = path.join(repoDir, "created-after.txt")
    await writeFile(createdAfter, "keep-user-data\n")
    const restored = await restoreLastSessionSnapshot("sessA", repoDir)
    assert.equal(restored.ok, true)
    assert.equal(await readFile(target, "utf8"), "session-a\n",
      "恢复 sessA 时不能拿 sessB 的更新快照")
    assert.equal(await readFile(preexistingUntracked, "utf8"), "present-before-snapshot\n",
      "快照前已有的未跟踪文件必须恢复")
    assert.equal(await readFile(createdAfter, "utf8"), "keep-user-data\n",
      "无法证明来源的未跟踪文件必须保留，/undo 不能冒险删除用户并行创建的数据")
  })

  it("awaits the automatic snapshot before the first edit tool mutates the workspace", async () => {
    const { execFileSync } = await import("node:child_process")
    const { executeTool } = await import("../src/kernel/tool/executor.mjs")
    const { restoreLastSessionSnapshot } = await import("../src/session/checkpoint.mjs")

    const repoDir = path.join(tmpDir, "executor-snapshot-repo")
    execFileSync("git", ["init", repoDir], { stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir })
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir })
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repoDir })
    const target = path.join(repoDir, "state.txt")
    await writeFile(target, "before-tool\n")
    execFileSync("git", ["add", "state.txt"], { cwd: repoDir })
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoDir, stdio: "ignore" })

    const sessionId = "executor-session"
    const result = await executeTool({
      tool: {
        name: "write",
        execute: () => {
          // 同步写确保旧 fire-and-forget 实现稳定复现：isGitRepo 的第一次 await
          // 还没返回，工具就已经把工作区改掉了。
          writeFileSync(target, "after-tool\n")
          return { ok: true, output: "written" }
        }
      },
      args: {},
      sessionId,
      turnId: `turn-${Date.now()}-${Math.random()}`,
      context: { cwd: repoDir, config: {} }
    })
    assert.equal(result.ok, true)
    assert.equal(await readFile(target, "utf8"), "after-tool\n")

    const restored = await restoreLastSessionSnapshot(sessionId, repoDir)
    assert.equal(restored.ok, true)
    assert.equal(await readFile(target, "utf8"), "before-tool\n",
      "快照必须记录工具执行前的状态，而不是竞态中的 after")
  })

  it("retries a failed snapshot before a later edit in the same turn", async () => {
    const { execFileSync } = await import("node:child_process")
    const { executeTool } = await import("../src/kernel/tool/executor.mjs")
    const { getSessionSnapshots, restoreLastSessionSnapshot } = await import("../src/session/checkpoint.mjs")

    const repoDir = path.join(tmpDir, "executor-snapshot-retry-repo")
    execFileSync("git", ["init", repoDir], { stdio: "ignore" })
    const target = path.join(repoDir, "state.txt")
    const sessionId = "executor-retry-session"
    const turnId = `retry-turn-${Date.now()}-${Math.random()}`
    const edit = (value) => executeTool({
      tool: {
        name: "write",
        execute: async () => {
          await writeFile(target, `${value}\n`)
          return { ok: true, output: "written" }
        }
      },
      args: {},
      sessionId,
      turnId,
      context: { cwd: repoDir, config: {} }
    })

    assert.equal((await edit("first")).ok, true)
    assert.deepEqual(await getSessionSnapshots(sessionId, repoDir), [],
      "an unborn repository cannot create a ghost commit")

    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir })
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir })
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repoDir })
    execFileSync("git", ["add", "state.txt"], { cwd: repoDir })
    execFileSync("git", ["commit", "-m", "first edit"], { cwd: repoDir, stdio: "ignore" })

    assert.equal((await edit("second")).ok, true)
    assert.equal((await getSessionSnapshots(sessionId, repoDir)).length, 1,
      "the second edit must retry after the first snapshot failure")
    const restored = await restoreLastSessionSnapshot(sessionId, repoDir)
    assert.equal(restored.ok, true)
    assert.equal(await readFile(target, "utf8"), "first\n")
  })

  it("fails closed instead of offering another session's latest snapshot", async () => {
    const { execFileSync } = await import("node:child_process")
    const { confirmRollback, handleRollbackIfNeeded } = await import("../src/session/rollback.mjs")
    const { saveGhostCommit } = await import("../src/storage/ghost-commit-store.mjs")

    const repoDir = path.join(tmpDir, "rollback-session-repo")
    execFileSync("git", ["init", repoDir], { stdio: "ignore" })
    await saveGhostCommit({
      id: "only-b", commitHash: "hb", repoPath: repoDir, parentHash: "p",
      sessionId: "sessB", message: "Auto snapshot before AI edit (session: sessB)",
      createdAt: Date.now(), files: []
    })

    const direct = await confirmRollback({ cwd: repoDir, sessionId: "sessA", language: "en" })
    assert.equal(direct.confirmed, false)
    assert.equal(direct.snapshotId, null)
    assert.match(direct.message, /No snapshots found/)

    const naturalLanguage = await handleRollbackIfNeeded({
      prompt: "undo", cwd: repoDir, sessionId: "sessA", language: "en"
    })
    assert.equal(naturalLanguage.handled, true)
    assert.match(naturalLanguage.reply, /No snapshots found/)
  })

  it("the real /undo command passes the foreground session identity", async () => {
    const { execFileSync } = await import("node:child_process")
    const { sessionCommands } = await import("../src/repl/commands/session.mjs")
    const { saveGhostCommit } = await import("../src/storage/ghost-commit-store.mjs")
    const repoDir = path.join(tmpDir, "slash-undo-session-repo")
    execFileSync("git", ["init", repoDir], { stdio: "ignore" })
    await saveGhostCommit({
      id: "slash-only-b", commitHash: "hb", repoPath: repoDir, parentHash: "p",
      sessionId: "sessB", message: "Auto snapshot before AI edit (session: sessB)",
      createdAt: Date.now(), files: []
    })
    const undo = sessionCommands.find((command) => command.names.includes("undo"))
    const output = []
    const originalCwd = process.cwd()
    try {
      process.chdir(repoDir)
      await undo.run({
        print: (line) => output.push(String(line)),
        state: { sessionId: "sessA" },
        ctx: { configState: { config: { language: "en" } } }
      })
    } finally {
      process.chdir(originalCwd)
    }
    assert.ok(output.some((line) => /No snapshots found/.test(line)),
      "/undo 不得对其他会话的快照弹确认框")
  })

  it("normalizes relative repository paths at the ghost-commit storage boundary", async () => {
    const { execFileSync } = await import("node:child_process")
    const { saveGhostCommit, listGhostCommits } = await import("../src/storage/ghost-commit-store.mjs")
    const repoDir = path.join(tmpDir, "relative-repo")
    execFileSync("git", ["init", repoDir], { stdio: "ignore" })
    const relativeRepo = path.relative(process.cwd(), repoDir)

    await saveGhostCommit({
      id: "relative", commitHash: "hash", repoPath: relativeRepo, parentHash: "p",
      sessionId: "sess", message: "relative", createdAt: Date.now(), files: []
    })

    assert.deepEqual((await listGhostCommits(relativeRepo)).map((entry) => entry.id), ["relative"])
    assert.deepEqual((await listGhostCommits(path.resolve(relativeRepo))).map((entry) => entry.id), ["relative"])
  })
})
