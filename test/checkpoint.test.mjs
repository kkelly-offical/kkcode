import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
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
