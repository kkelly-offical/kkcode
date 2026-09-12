import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

// 后台 worktree 回收（handoff）测试：apply / discard / clean 的完整生命周期。
// 需要系统上有 git。全程在临时目录里建仓，不碰真实工作区。

const tmpHome = await mkdtemp(path.join(tmpdir(), "kkcode-handoff-home-"))
process.env.KKCODE_HOME = tmpHome

const {
  createDetachedWorktree,
  exportWorktreePatch,
  isGitRepo,
  removeWorktree
} = await import("../src/util/git.mjs")
const {
  applyWorktreeResult,
  discardWorktreeResult
} = await import("../src/orchestration/worktree-handoff.mjs")
const { BackgroundManager } = await import("../src/orchestration/background-manager.mjs")
const {
  ensureBackgroundTaskRuntimeDir,
  backgroundTaskCheckpointPath
} = await import("../src/storage/paths.mjs")
const { writeJson, readJson } = await import("../src/storage/json-store.mjs")

const originalCwd = process.cwd()
let repoCounter = 0

async function pathExists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** 建一个带初始提交的临时仓库 */
async function makeRepo() {
  repoCounter += 1
  const repo = await mkdtemp(path.join(tmpdir(), `kkcode-handoff-repo${repoCounter}-`))
  git(["init"], repo)
  git(["config", "user.email", "test@example.com"], repo)
  git(["config", "user.name", "Test"], repo)
  await writeFile(path.join(repo, "app.txt"), "line1\nline2\nline3\n")
  git(["add", "-A"], repo)
  git(["commit", "-m", "init"], repo)
  return repo
}

/** 登记一个 completed + preserved worktree 的假任务 */
async function makePreservedTask(repo, worktreePath, idSuffix = "") {
  await ensureBackgroundTaskRuntimeDir()
  const id = `handoff-test-${Date.now()}-${repoCounter}${idSuffix}`
  const task = {
    id,
    description: "handoff test task",
    status: "completed",
    attempt: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: { cwd: repo, workerType: "delegate_task" },
    result: {
      reply: "[TASK_COMPLETE] done",
      worktree_preserved: true,
      worktree_path: worktreePath
    }
  }
  await writeJson(backgroundTaskCheckpointPath(id), task)
  return task
}

async function readCheckpoint(id) {
  return readJson(backgroundTaskCheckpointPath(id), null)
}

describe("worktree handoff", () => {
  before(async () => {
    await ensureBackgroundTaskRuntimeDir()
  })

  after(async () => {
    process.chdir(originalCwd)
    delete process.env.KKCODE_HOME
    await rm(tmpHome, { recursive: true, force: true })
  })

  it("exportWorktreePatch 含改动与新文件，排除 worker 复制的配置文件", async () => {
    const repo = await makeRepo()
    // 主仓里有一个未跟踪的项目配置，worker 会把同样的副本带进 worktree
    await writeFile(path.join(repo, "kkcode.config.yaml"), "provider: {}\n")
    const created = await createDetachedWorktree(repo, "export")
    assert.ok(created.ok, created.error)
    try {
      await writeFile(path.join(created.path, "kkcode.config.yaml"), "provider: {}\n")
      await writeFile(path.join(created.path, "app.txt"), "line1\nCHANGED\nline3\n")
      await mkdir(path.join(created.path, "src"), { recursive: true })
      await writeFile(path.join(created.path, "src", "new.mjs"), "export const x = 1\n")

      const exported = await exportWorktreePatch(created.path, {
        excludePaths: ["kkcode.config.yaml"]
      })
      assert.ok(exported.ok, exported.error)
      assert.strictEqual(exported.empty, false)
      assert.ok(exported.files.includes("app.txt"))
      assert.ok(exported.files.includes("src/new.mjs"))
      assert.ok(!exported.files.includes("kkcode.config.yaml"), "config copy must be excluded")
      assert.ok(exported.patch.includes("CHANGED"))
    } finally {
      await removeWorktree(created.path, repo)
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("apply 成功：变更落进主 checkout、worktree 被移除、checkpoint 字段齐全", async () => {
    const repo = await makeRepo()
    const created = await createDetachedWorktree(repo, "apply")
    assert.ok(created.ok, created.error)
    await writeFile(path.join(created.path, "app.txt"), "line1\nAPPLIED\nline3\n")
    await writeFile(path.join(created.path, "added.txt"), "new file\n")
    const task = await makePreservedTask(repo, created.path)

    const outcome = await applyWorktreeResult(task)
    process.chdir(originalCwd)
    assert.ok(outcome.ok, outcome.error)
    assert.strictEqual(outcome.worktree, "removed")
    assert.ok(outcome.snapshot, "ghost snapshot hash recorded")

    assert.strictEqual(await readFile(path.join(repo, "app.txt"), "utf8"), "line1\nAPPLIED\nline3\n")
    assert.strictEqual(await readFile(path.join(repo, "added.txt"), "utf8"), "new file\n")
    assert.ok(!(await pathExists(created.path)), "worktree directory removed")
    const listed = git(["worktree", "list", "--porcelain"], repo)
    assert.ok(!listed.includes(created.path), "worktree registration removed")

    const checkpoint = await readCheckpoint(task.id)
    assert.strictEqual(checkpoint.result.worktree_applied, true)
    assert.strictEqual(checkpoint.result.worktree_preserved, false)
    assert.strictEqual(checkpoint.result.worktree_path, null)
    assert.deepStrictEqual([...checkpoint.result.applied_files].sort(), ["added.txt", "app.txt"])
    assert.strictEqual(checkpoint.result.apply_snapshot, outcome.snapshot)

    await rm(repo, { recursive: true, force: true })
  })

  it("主 checkout 有重叠脏改动时默认拒绝，--force 放行", async () => {
    const repo = await makeRepo()
    // 20 行的文件：worktree 改第 2 行，用户在主 checkout 改第 20 行 ——
    // 同一文件（触发重叠拒绝），但两处互不干扰（force 后上下文仍能匹配）。
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
    await writeFile(path.join(repo, "app.txt"), `${lines.join("\n")}\n`)
    git(["add", "-A"], repo)
    git(["commit", "-m", "expand app.txt"], repo)

    const created = await createDetachedWorktree(repo, "overlap")
    assert.ok(created.ok, created.error)
    const wtLines = [...lines]
    wtLines[1] = "FROM-WORKTREE"
    await writeFile(path.join(created.path, "app.txt"), `${wtLines.join("\n")}\n`)
    const task = await makePreservedTask(repo, created.path)

    // 用户在主 checkout 里对同一个文件有未提交改动（文件末尾）
    const userLines = [...lines]
    userLines[19] = "USER-LOCAL"
    await writeFile(path.join(repo, "app.txt"), `${userLines.join("\n")}\n`)

    const refused = await applyWorktreeResult(task)
    process.chdir(originalCwd)
    assert.strictEqual(refused.ok, false)
    assert.ok(refused.overlaps.includes("app.txt"))
    assert.ok(await pathExists(created.path), "worktree preserved after refusal")

    const forced = await applyWorktreeResult(task, { force: true })
    process.chdir(originalCwd)
    assert.ok(forced.ok, forced.error)
    const merged = await readFile(path.join(repo, "app.txt"), "utf8")
    assert.ok(merged.includes("FROM-WORKTREE"), "worktree change applied")
    assert.ok(merged.includes("USER-LOCAL"), "user change kept")

    await rm(repo, { recursive: true, force: true })
  })

  it("上下文冲突时整体中止，worktree 保留", async () => {
    const repo = await makeRepo()
    const created = await createDetachedWorktree(repo, "conflict")
    assert.ok(created.ok, created.error)
    await writeFile(path.join(created.path, "app.txt"), "line1\nWORKTREE-EDIT\nline3\n")
    const task = await makePreservedTask(repo, created.path)

    // 主仓同一区域被另一笔提交改掉，patch 上下文对不上
    await writeFile(path.join(repo, "app.txt"), "line1\nUPSTREAM-EDIT\nline3\n")
    git(["add", "-A"], repo)
    git(["commit", "-m", "upstream edit"], repo)

    const outcome = await applyWorktreeResult(task)
    process.chdir(originalCwd)
    assert.strictEqual(outcome.ok, false)
    assert.ok(String(outcome.error).includes("patch") || String(outcome.error).includes("apply"))
    assert.ok(await pathExists(created.path), "worktree preserved after conflict")
    // 主 checkout 不被部分写入
    assert.strictEqual(await readFile(path.join(repo, "app.txt"), "utf8"), "line1\nUPSTREAM-EDIT\nline3\n")

    await removeWorktree(created.path, repo)
    await rm(repo, { recursive: true, force: true })
  })

  it("--dry-run 只检查不落地", async () => {
    const repo = await makeRepo()
    const created = await createDetachedWorktree(repo, "dryrun")
    assert.ok(created.ok, created.error)
    await writeFile(path.join(created.path, "app.txt"), "line1\nDRYRUN\nline3\n")
    const task = await makePreservedTask(repo, created.path)

    const outcome = await applyWorktreeResult(task, { dryRun: true })
    assert.strictEqual(outcome.ok, true)
    assert.strictEqual(outcome.dryRun, true)
    assert.ok(outcome.files.includes("app.txt"))
    assert.strictEqual(await readFile(path.join(repo, "app.txt"), "utf8"), "line1\nline2\nline3\n")
    assert.ok(await pathExists(created.path), "worktree kept after dry-run")

    await removeWorktree(created.path, repo)
    await rm(repo, { recursive: true, force: true })
  })

  it("空 worktree 直接清理，不产生变更", async () => {
    const repo = await makeRepo()
    const created = await createDetachedWorktree(repo, "empty")
    assert.ok(created.ok, created.error)
    const task = await makePreservedTask(repo, created.path)

    const outcome = await applyWorktreeResult(task)
    process.chdir(originalCwd)
    assert.strictEqual(outcome.empty, true)
    assert.ok(!(await pathExists(created.path)), "empty worktree removed")
    const checkpoint = await readCheckpoint(task.id)
    assert.strictEqual(checkpoint.result.worktree_preserved, false)

    await rm(repo, { recursive: true, force: true })
  })

  it("discard 移除 worktree 并标记，不碰主 checkout", async () => {
    const repo = await makeRepo()
    const created = await createDetachedWorktree(repo, "discard")
    assert.ok(created.ok, created.error)
    await writeFile(path.join(created.path, "app.txt"), "line1\nDISCARDED\nline3\n")
    const task = await makePreservedTask(repo, created.path)

    const outcome = await discardWorktreeResult(task)
    process.chdir(originalCwd)
    assert.ok(outcome.ok, outcome.error)
    assert.ok(!(await pathExists(created.path)))
    assert.strictEqual(await readFile(path.join(repo, "app.txt"), "utf8"), "line1\nline2\nline3\n")

    const checkpoint = await readCheckpoint(task.id)
    assert.strictEqual(checkpoint.result.worktree_discarded, true)
    assert.strictEqual(checkpoint.result.worktree_preserved, false)

    await rm(repo, { recursive: true, force: true })
  })

  it("已应用/已丢弃/无 worktree 的任务拒绝重复处置", async () => {
    const repo = await makeRepo()
    const task = await makePreservedTask(repo, path.join(repo, "nowhere"))
    task.result = {
      ...task.result,
      worktree_preserved: false,
      worktree_path: null
    }
    const outcome = await applyWorktreeResult(task)
    assert.strictEqual(outcome.ok, false)
    assert.ok(String(outcome.error).includes("no preserved worktree"))
    await rm(repo, { recursive: true, force: true })
  })

  it("background clean 跳过保留 worktree 的任务", async () => {
    const repo = await makeRepo()
    const created = await createDetachedWorktree(repo, "clean")
    assert.ok(created.ok, created.error)
    const preservedTask = await makePreservedTask(repo, created.path, "-preserved")

    const plainId = `handoff-test-plain-${Date.now()}`
    await writeJson(backgroundTaskCheckpointPath(plainId), {
      id: plainId,
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      payload: { cwd: repo },
      result: { reply: "done" }
    })

    const result = await BackgroundManager.clean({ maxAge: 0 })
    assert.ok(result.removed.includes(plainId))
    assert.ok(result.skipped_preserved.includes(preservedTask.id))
    assert.ok(await pathExists(backgroundTaskCheckpointPath(preservedTask.id)))
    assert.ok(await pathExists(created.path), "preserved worktree untouched by clean")

    await removeWorktree(created.path, repo)
    await rm(repo, { recursive: true, force: true })
  })

  it("exportWorktreePatch 拒绝非 git 目录", async () => {
    const notRepo = await mkdtemp(path.join(tmpdir(), "kkcode-handoff-notrepo-"))
    assert.strictEqual(await isGitRepo(notRepo), false)
    const exported = await exportWorktreePatch(notRepo)
    assert.strictEqual(exported.ok, false)
    await rm(notRepo, { recursive: true, force: true })
  })
})
