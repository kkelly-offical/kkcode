import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  configureEventLog, appendEventLog, eventLogStats
} from "../src/storage/event-log.mjs"

let tmpDir

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "evlog-test-"))
  process.env.KKCODE_HOME = tmpDir
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

describe("event-log", () => {
  it("appendEventLog writes JSON line", async () => {
    await appendEventLog({ type: "test", data: "hello" })
    const content = await readFile(path.join(tmpDir, "events.log"), "utf8")
    const parsed = JSON.parse(content.trim())
    assert.equal(parsed.type, "test")
    assert.equal(parsed.data, "hello")
  })

  it("appendEventLog appends multiple events", async () => {
    await appendEventLog({ seq: 1 })
    await appendEventLog({ seq: 2 })
    const lines = (await readFile(path.join(tmpDir, "events.log"), "utf8"))
      .trim().split("\n")
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).seq, 1)
    assert.equal(JSON.parse(lines[1]).seq, 2)
  })

  it("eventLogStats returns correct counts", async () => {
    await appendEventLog({ x: 1 })
    const stats = await eventLogStats()
    assert.ok(stats.activeBytes > 0)
    assert.equal(stats.rotatedFiles, 0)
  })

  it("configureEventLog accepts valid options", () => {
    configureEventLog({ rotateMb: 16, retainDays: 7 })
    // No assertion needed — just verify no throw
  })

  it("configureEventLog ignores invalid options", () => {
    configureEventLog({ rotateMb: -1, retainDays: 0 })
    // Should not throw
  })
})
