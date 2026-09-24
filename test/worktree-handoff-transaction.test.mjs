import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import * as git from "../src/util/git.mjs"
import { applyWorktreeResult, createWorktreeHandoff, discardWorktreeResult } from "../src/kernel/orchestration/worktree-handoff.mjs"
import { backgroundTaskCheckpointPath } from "../src/storage/paths.mjs"
import { openPromotionJournal, writePromotionJson } from "../src/storage/promotion-journal.mjs"

const originalCwd = process.cwd()
const oldHome = process.env.KKCODE_HOME
let testRoot
const gitRun = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const exists = file => access(file).then(() => true, () => false)
const text = file => readFile(file, "utf8").then(value => value.replaceAll("\r\n", "\n"))

async function fixture(t, { empty = false } = {}) {
  const repo = await mkdtemp(path.join(testRoot, "repo-"))
  gitRun(repo, "init")
  gitRun(repo, "config", "user.email", "handoff@example.invalid")
  gitRun(repo, "config", "user.name", "Handoff Test")
  gitRun(repo, "config", "core.autocrlf", "false")
  await writeFile(path.join(repo, "app.txt"), "before\n")
  gitRun(repo, "add", "-A")
  gitRun(repo, "commit", "-m", "baseline")
  const candidate = await git.createDetachedWorktree(repo, "transaction-test")
  assert.equal(candidate.ok, true, candidate.error)
  if (!empty) await writeFile(path.join(candidate.path, "app.txt"), "after\n")
  const task = {
    id: `promotion-${randomUUID()}`, status: "completed", payload: { cwd: repo },
    result: { worktree_path: candidate.path, worktree_preserved: true }
  }
  await writePromotionJson(backgroundTaskCheckpointPath(task.id), task)
  const journal = openPromotionJournal(await git.repositoryIdentity(repo), task.id)
  t.after(async () => {
    process.chdir(originalCwd)
    if (await exists(candidate.path)) await git.removeWorktree(candidate.path, repo)
    await rm(repo, { recursive: true, force: true })
  })
  return { repo, candidate: candidate.path, task, journal }
}

function failJournalAt(stage) {
  return (repository, taskId) => {
    const journal = openPromotionJournal(repository, taskId)
    return {
      ...journal,
      async write(record) {
        if (record.stage === stage) throw new Error(`injected ${stage} journal failure`)
        await journal.write(record)
      }
    }
  }
}

describe("durable worktree promotion", () => {
  before(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "kkcode-promotion-tests-"))
    process.env.KKCODE_HOME = path.join(testRoot, "state")
  })
  after(async () => {
    process.chdir(originalCwd)
    if (oldHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = oldHome
    await rm(testRoot, { recursive: true, force: true })
  })

  it("snapshot failure aborts even with force, preserving the candidate", async t => {
    const f = await fixture(t)
    let writes = 0
    const apply = createWorktreeHandoff({ gitApi: {
      ...git,
      createGhostCommit: async () => ({ ok: false, error: "disk unavailable" }),
      applyPatch: async (...args) => { if (!args[2].check) writes++; return git.applyPatch(...args) }
    } })
    const result = await apply(f.task, { force: true })
    assert.equal(result.ok, false)
    assert.match(result.error, /snapshot failed/)
    assert.equal(writes, 0)
    assert.equal(await text(path.join(f.repo, "app.txt")), "before\n")
    assert.equal(await exists(f.candidate), true)
    assert.equal((await f.journal.read()).stage, "planned")
  })

  it("refuses a snapshot that does not represent the preflight baseline", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ gitApi: {
      ...git,
      createGhostCommit: async (...args) => {
        const snapshot = await git.createGhostCommit(...args)
        snapshot.ghostCommit.treeHash = "0".repeat(40)
        return snapshot
      }
    } })
    const result = await apply(f.task)
    assert.equal(result.ok, false)
    assert.match(result.error, /does not match/)
    assert.equal(await text(path.join(f.repo, "app.txt")), "before\n")
  })

  it("will not apply when recovery references cannot be retained", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ gitApi: {
      ...git, retainPromotionSnapshot: async () => ({ ok: false, error: "ref lock" })
    } })
    assert.equal((await apply(f.task)).ok, false)
    assert.equal(await text(path.join(f.repo, "app.txt")), "before\n")
    assert.equal(await exists(f.candidate), true)
  })

  it("a missing durable apply intent prevents the actual write", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ journalFactory: failJournalAt("applying") })
    const result = await apply(f.task)
    assert.equal(result.ok, false)
    assert.equal(await text(path.join(f.repo, "app.txt")), "before\n")
    assert.equal((await f.journal.read()).stage, "planned")
  })

  it("successful apply plus receipt failure keeps the candidate and never blindly repeats", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ journalFactory: failJournalAt("applied") })
    const result = await apply(f.task)
    assert.equal(result.ok, false)
    assert.equal(result.recovery_required, true)
    assert.equal(await text(path.join(f.repo, "app.txt")), "after\n")
    assert.equal(await exists(f.candidate), true)
    assert.equal((await f.journal.read()).stage, "applying")
    const retry = await applyWorktreeResult(f.task, { force: true, threeway: true })
    assert.equal(retry.ok, false)
    assert.equal(retry.recovery_required, true)
    assert.equal(retry.expectedAfterMatched, true)
    assert.match(retry.error, /refusing to replay/)
    assert.equal(await exists(f.candidate), true)
    const discard = await discardWorktreeResult(f.task)
    assert.equal(discard.ok, false)
    assert.equal(await exists(f.candidate), true)
  })

  it("repairs a failed checkpoint from the applied receipt before cleanup", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ patchCheckpoint: async () => { throw new Error("checkpoint full") } })
    const result = await apply(f.task)
    assert.equal(result.ok, false)
    assert.equal((await f.journal.read()).stage, "applied")
    assert.equal(await exists(f.candidate), true)
    const retry = await applyWorktreeResult(f.task)
    assert.equal(retry.ok, true, retry.error)
    assert.equal(retry.recovered, true)
    assert.equal(await exists(f.candidate), false)
    const checkpoint = JSON.parse(await readFile(backgroundTaskCheckpointPath(f.task.id), "utf8"))
    assert.equal(checkpoint.result.worktree_applied, true)
    assert.equal(checkpoint.result.apply_operation_id, retry.operationId)
    assert.equal((await f.journal.read()).stage, "cleanup")
  })

  it("checkpoint alone cannot authorize cleanup without durable receipted transition", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ journalFactory: failJournalAt("receipted") })
    assert.equal((await apply(f.task)).ok, false)
    assert.equal((await f.journal.read()).stage, "applied")
    assert.equal(await exists(f.candidate), true)
    const checkpoint = JSON.parse(await readFile(backgroundTaskCheckpointPath(f.task.id), "utf8"))
    assert.equal(checkpoint.result.worktree_applied, true)
    assert.equal(checkpoint.result.worktree_preserved, true)
    const recovered = await applyWorktreeResult(checkpoint)
    assert.equal(recovered.ok, true, recovered.error)
    assert.equal(await exists(f.candidate), false)
  })

  it("recovers cleanup whose completion receipt was lost without removing twice", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ journalFactory: (repository, taskId) => {
      const journal = openPromotionJournal(repository, taskId)
      return { ...journal, async write(record) {
        if (record.cleanup === "removed") throw new Error("cleanup receipt unavailable")
        await journal.write(record)
      } }
    } })
    const first = await apply(f.task)
    assert.equal(first.ok, false)
    assert.equal(await exists(f.candidate), false)
    assert.equal((await f.journal.read()).cleanup, "pending")
    const retry = await applyWorktreeResult(f.task)
    assert.equal(retry.ok, true, retry.error)
    assert.equal(retry.worktree, "removed")
    assert.equal((await f.journal.read()).cleanup, "removed")
    const checkpoint = JSON.parse(await readFile(backgroundTaskCheckpointPath(f.task.id), "utf8"))
    assert.equal(checkpoint.result.worktree_path, null)
  })

  it("an interrupted apply is inspected but not repeated even if the baseline appears unchanged", async t => {
    const f = await fixture(t)
    let writes = 0
    const apply = createWorktreeHandoff({ gitApi: {
      ...git,
      applyPatch: async (...args) => {
        if (!args[2].check) { writes++; throw new Error("process interrupted before return") }
        return git.applyPatch(...args)
      }
    } })
    assert.equal((await apply(f.task)).recovery_required, true)
    const retry = await apply(f.task)
    assert.equal(retry.recovery_required, true)
    assert.equal(retry.baselineUnchanged, true)
    assert.equal(writes, 1)
  })

  it("an already-dirty file changing during preflight invalidates the baseline", async t => {
    const f = await fixture(t)
    await writeFile(path.join(f.repo, "notes.txt"), "first user draft\n")
    const apply = createWorktreeHandoff({ gitApi: {
      ...git,
      applyPatch: async (...args) => {
        const result = await git.applyPatch(...args)
        if (args[2].check) await writeFile(path.join(f.repo, "notes.txt"), "second user draft\n")
        return result
      }
    } })
    const result = await apply(f.task, { force: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, "promotion_baseline_changed")
    assert.equal(await text(path.join(f.repo, "app.txt")), "before\n")
    assert.equal(await text(path.join(f.repo, "notes.txt")), "second user draft\n")
  })

  it("rechecks content after recovery snapshot creation", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ gitApi: {
      ...git,
      createGhostCommit: async (...args) => {
        const snapshot = await git.createGhostCommit(...args)
        await writeFile(path.join(f.repo, "user.txt"), "concurrent work\n")
        return snapshot
      }
    } })
    const result = await apply(f.task)
    assert.equal(result.ok, false)
    assert.match(result.error, /changed before apply/)
    assert.equal(await text(path.join(f.repo, "app.txt")), "before\n")
    assert.equal(await exists(f.candidate), true)
  })

  it("candidate modification after apply prevents destructive cleanup", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ gitApi: {
      ...git,
      applyPatch: async (...args) => {
        const result = await git.applyPatch(...args)
        if (!args[2].check) await writeFile(path.join(f.candidate, "late.txt"), "late work\n")
        return result
      }
    } })
    const result = await apply(f.task)
    assert.equal(result.ok, true)
    assert.equal(result.worktree, "cleanup-failed")
    assert.match(result.cleanup_error, /candidate changed/)
    assert.equal(await exists(f.candidate), true)
    assert.equal((await f.journal.read()).cleanup, "failed")
  })

  it("unexpected target edits during apply are not acknowledged as the predicted delivery", async t => {
    const f = await fixture(t)
    const apply = createWorktreeHandoff({ gitApi: {
      ...git,
      applyPatch: async (...args) => {
        const result = await git.applyPatch(...args)
        if (!args[2].check) await writeFile(path.join(f.repo, "concurrent.txt"), "concurrent user work\n")
        return result
      }
    } })
    const result = await apply(f.task)
    assert.equal(result.ok, false)
    assert.equal(result.recovery_required, true)
    assert.match(result.error, /differs from the predicted/)
    assert.equal(await exists(f.candidate), true)
    assert.equal(await text(path.join(f.repo, "concurrent.txt")), "concurrent user work\n")
    assert.equal((await f.journal.read()).stage, "applying")
  })

  it("promotion evidence cannot be rewritten after apply intent", async t => {
    const f = await fixture(t)
    const result = await applyWorktreeResult(f.task, { keepWorktree: true })
    assert.equal(result.ok, true, result.error)
    const record = await f.journal.read()
    await assert.rejects(f.journal.write({ ...record, revision: record.revision + 1, force: !record.force }), /evidence is immutable/)
    await assert.rejects(f.journal.write({ ...record, revision: record.revision + 1, after: record.before }), /receipt is immutable/)
    await assert.rejects(f.journal.write({ ...record, revision: record.revision + 1, stage: "applying" }), /invalid or stale/)
  })

  it("duplicate promotion returns the original operation receipt without replay", async t => {
    const f = await fixture(t)
    const first = await applyWorktreeResult(f.task)
    assert.equal(first.ok, true, first.error)
    await writeFile(path.join(f.repo, "app.txt"), "new user work after delivery\n")
    const second = await applyWorktreeResult(f.task)
    assert.equal(second.ok, true, second.error)
    assert.equal(second.alreadyApplied, true)
    assert.equal(first.operationId, second.operationId)
    assert.equal(await text(path.join(f.repo, "app.txt")), "new user work after delivery\n")
    const journal = await f.journal.read()
    assert.notEqual(journal.before.worktreeTree, journal.after.worktreeTree)
    assert.equal(gitRun(f.repo, "rev-parse", `refs/kkcode/promotions/${first.operationId}/before`), first.snapshot)
    assert.equal(gitRun(f.repo, "rev-parse", `refs/kkcode/promotions/${first.operationId}/index`), journal.before.indexTree)
  })

  it("a corrupt journal fails closed instead of treating it as a new operation", async t => {
    const f = await fixture(t)
    const first = await applyWorktreeResult(f.task, { keepWorktree: true })
    assert.equal(first.ok, true, first.error)
    await writeFile(f.journal.file, "{truncated")
    const retry = await applyWorktreeResult(f.task, { force: true })
    assert.equal(retry.ok, false)
    assert.match(retry.error, /journal is corrupt/)
    assert.equal(await exists(f.candidate), true)
    assert.equal(await text(path.join(f.repo, "app.txt")), "after\n")
  })

  it("a corrupted task checkpoint aborts before application", async t => {
    const f = await fixture(t)
    await writeFile(backgroundTaskCheckpointPath(f.task.id), "{")
    assert.equal((await applyWorktreeResult(f.task)).ok, false)
    assert.equal(await text(path.join(f.repo, "app.txt")), "before\n")
    assert.equal(await exists(f.candidate), true)
  })

  it("repository lock excludes a competing promotion", async t => {
    const f = await fixture(t)
    let entered
    let release
    const enteredPromise = new Promise(resolve => { entered = resolve })
    const hold = new Promise(resolve => { release = resolve })
    const apply = createWorktreeHandoff({ gitApi: {
      ...git,
      applyPatch: async (...args) => {
        if (args[2].check) { entered(); await hold }
        return git.applyPatch(...args)
      }
    } })
    const active = apply(f.task, { keepWorktree: true })
    await enteredPromise
    try {
      const competitor = await applyWorktreeResult(f.task)
      assert.equal(competitor.ok, false)
      assert.match(competitor.error, /owns this device state/)
    } finally { release() }
    assert.equal((await active).ok, true)
  })

  it("dry-run keeps both indexes unchanged and writes no operation journal", async t => {
    const f = await fixture(t)
    await writeFile(path.join(f.candidate, "stage.txt"), "staged\n")
    gitRun(f.candidate, "add", "stage.txt")
    const before = gitRun(f.candidate, "write-tree")
    const mainBefore = gitRun(f.repo, "write-tree")
    const result = await applyWorktreeResult(f.task, { dryRun: true })
    assert.equal(result.ok, true, result.error)
    assert.equal(gitRun(f.candidate, "write-tree"), before)
    assert.equal(gitRun(f.repo, "write-tree"), mainBefore)
    assert.equal(await f.journal.read(), null)
    assert.equal(await text(path.join(f.repo, "app.txt")), "before\n")
  })

  it("patch export preserves trailing whitespace exactly", async t => {
    const f = await fixture(t)
    const content = "after   \n\t  \n"
    await writeFile(path.join(f.candidate, "app.txt"), content)
    const exported = await git.exportWorktreePatch(f.candidate)
    assert.equal(exported.ok, true, exported.error)
    assert.match(exported.patch, /\+after   \n/)
    const result = await applyWorktreeResult(f.task)
    assert.equal(result.ok, true, result.error)
    assert.equal(await text(path.join(f.repo, "app.txt")), content)
  })

  it("dry-run fingerprints do not persist untracked user contents in Git objects", async t => {
    const f = await fixture(t)
    const userFile = path.join(f.repo, "private-untracked.txt")
    await writeFile(userFile, `synthetic private content ${randomUUID()}\n`)
    const blob = gitRun(f.repo, "hash-object", userFile)
    assert.throws(() => gitRun(f.repo, "cat-file", "-e", blob))
    const beforeIndex = await readFile(path.join(f.repo, ".git", "index"))
    const result = await applyWorktreeResult(f.task, { dryRun: true })
    assert.equal(result.ok, true, result.error)
    assert.throws(() => gitRun(f.repo, "cat-file", "-e", blob))
    assert.deepEqual(await readFile(path.join(f.repo, ".git", "index")), beforeIndex)
  })

  it("retains a separately staged recovery tree without changing user staging", async t => {
    const f = await fixture(t)
    await writeFile(path.join(f.repo, "user.txt"), "staged version\n")
    gitRun(f.repo, "add", "user.txt")
    await writeFile(path.join(f.repo, "user.txt"), "working version\n")
    const stageBefore = gitRun(f.repo, "diff", "--cached", "--binary")
    const result = await applyWorktreeResult(f.task)
    assert.equal(result.ok, true, result.error)
    assert.equal(gitRun(f.repo, "diff", "--cached", "--binary"), stageBefore)
    assert.equal(await text(path.join(f.repo, "user.txt")), "working version\n")
    const journal = await f.journal.read()
    assert.notEqual(journal.before.indexTree, journal.before.worktreeTree)
    assert.equal(gitRun(f.repo, "show", `refs/kkcode/promotions/${result.operationId}/index:user.txt`), "staged version")
    assert.equal(gitRun(f.repo, "show", `refs/kkcode/promotions/${result.operationId}/before:user.txt`), "working version")
  })

  it("empty candidates obey keepWorktree and retain an empty delivery receipt", async t => {
    const f = await fixture(t, { empty: true })
    const result = await applyWorktreeResult(f.task, { keepWorktree: true })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.empty, true)
    assert.equal(result.worktree, "kept")
    assert.equal(await exists(f.candidate), true)
    const journal = await f.journal.read()
    assert.equal(journal.before.worktreeTree, journal.after.worktreeTree)
    assert.equal(journal.snapshot, null)
  })

  it("explicit three-way applies are receipted and kept on request", async t => {
    const f = await fixture(t)
    const result = await applyWorktreeResult(f.task, { threeway: true, keepWorktree: true })
    assert.equal(result.ok, true, result.error)
    assert.equal(await text(path.join(f.repo, "app.txt")), "after\n")
    assert.equal(await exists(f.candidate), true)
    assert.equal((await f.journal.read()).threeway, true)
  })
})
