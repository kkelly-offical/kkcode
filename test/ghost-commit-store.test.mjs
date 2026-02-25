import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  saveGhostCommit, loadGhostCommit, listGhostCommits,
  deleteGhostCommit, cleanupOldGhostCommits, getLatestGhostCommit,
  countGhostCommits
} from "../src/storage/ghost-commit-store.mjs"

let tmpDir
const REPO = "/fake/repo"

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "gc-test-"))
  process.env.KKCODE_HOME = tmpDir
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

describe("ghost-commit-store", () => {
  it("save and load roundtrip", async () => {
    const gc = {
      id: "gc1", commitHash: "abc123", repoPath: REPO,
      parentHash: "def456", message: "test commit",
      createdAt: Date.now(), files: ["a.js"]
    }
    const result = await saveGhostCommit(gc)
    assert.equal(result.ok, true)

    const loaded = await loadGhostCommit(REPO, "gc1")
    assert.equal(loaded.id, "gc1")
    assert.equal(loaded.commitHash, "abc123")
    assert.ok(loaded.savedAt)
  })

  it("loadGhostCommit returns null for missing", async () => {
    const loaded = await loadGhostCommit(REPO, "nonexistent")
    assert.equal(loaded, null)
  })

  it("listGhostCommits returns sorted by createdAt desc", async () => {
    for (let i = 0; i < 3; i++) {
      await saveGhostCommit({
        id: `gc${i}`, commitHash: `h${i}`, repoPath: REPO,
        parentHash: "p", message: `msg${i}`,
        createdAt: Date.now() - (2 - i) * 1000, files: []
      })
    }
    const list = await listGhostCommits(REPO)
    assert.equal(list.length, 3)
    assert.equal(list[0].id, "gc2") // most recent
  })

  it("deleteGhostCommit removes entry", async () => {
    await saveGhostCommit({
      id: "gc-del", commitHash: "h", repoPath: REPO,
      parentHash: "p", message: "m", createdAt: Date.now(), files: []
    })
    const ok = await deleteGhostCommit(REPO, "gc-del")
    assert.equal(ok, true)
    assert.equal(await loadGhostCommit(REPO, "gc-del"), null)
  })

  it("deleteGhostCommit returns false for missing", async () => {
    assert.equal(await deleteGhostCommit(REPO, "nope"), false)
  })

  it("getLatestGhostCommit returns most recent", async () => {
    await saveGhostCommit({
      id: "old", commitHash: "h1", repoPath: REPO,
      parentHash: "p", message: "old", createdAt: Date.now() - 2000, files: []
    })
    await saveGhostCommit({
      id: "new", commitHash: "h2", repoPath: REPO,
      parentHash: "p", message: "new", createdAt: Date.now(), files: []
    })
    const latest = await getLatestGhostCommit(REPO)
    assert.equal(latest.id, "new")
  })

  it("getLatestGhostCommit returns null for empty repo", async () => {
    assert.equal(await getLatestGhostCommit(REPO), null)
  })

  it("countGhostCommits returns correct counts", async () => {
    await saveGhostCommit({
      id: "gc-count", commitHash: "h", repoPath: REPO,
      parentHash: "p", message: "m", createdAt: Date.now(), files: []
    })
    const counts = await countGhostCommits(REPO)
    assert.equal(counts.total, 1)
    assert.equal(counts.expired, 0)
  })
})
