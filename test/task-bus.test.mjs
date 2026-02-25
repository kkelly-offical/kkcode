import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { TaskBus } from "../src/session/longagent-task-bus.mjs"

describe("TaskBus", () => {
  it("publish and get", () => {
    const bus = new TaskBus()
    bus.publish("t1", "api_url", "http://localhost:3000")
    assert.equal(bus.get("api_url"), "http://localhost:3000")
  })

  it("get returns null for missing key", () => {
    const bus = new TaskBus()
    assert.equal(bus.get("nonexistent"), null)
  })

  it("snapshot returns all shared entries", () => {
    const bus = new TaskBus()
    bus.publish("t1", "key1", "val1")
    bus.publish("t2", "key2", "val2")
    const snap = bus.snapshot()
    assert.equal(snap.key1.value, "val1")
    assert.equal(snap.key2.value, "val2")
  })

  it("latest publish overwrites previous value", () => {
    const bus = new TaskBus()
    bus.publish("t1", "key", "old")
    bus.publish("t2", "key", "new")
    assert.equal(bus.get("key"), "new")
    assert.equal(bus.snapshot().key.from, "t2")
  })

  it("toContextString formats output", () => {
    const bus = new TaskBus()
    bus.publish("t1", "db_schema", "users table")
    const ctx = bus.toContextString()
    assert.ok(ctx.includes("Task Bus"))
    assert.ok(ctx.includes("[t1] db_schema: users table"))
  })

  it("toContextString returns empty for no entries", () => {
    const bus = new TaskBus()
    assert.equal(bus.toContextString(), "")
  })

  it("toContextString truncates at maxLen", () => {
    const bus = new TaskBus()
    bus.publish("t1", "big", "x".repeat(500))
    const ctx = bus.toContextString(100)
    assert.ok(ctx.length <= 104) // 100 + "..."
  })

  it("parseTaskOutput extracts broadcast markers", () => {
    const bus = new TaskBus()
    bus.parseTaskOutput("t1", "Done. [TASK_BROADCAST: api_port = 8080] and [TASK_BROADCAST: db_host = localhost]")
    assert.equal(bus.get("api_port"), "8080")
    assert.equal(bus.get("db_host"), "localhost")
  })

  it("parseTaskOutput ignores text without markers", () => {
    const bus = new TaskBus()
    bus.parseTaskOutput("t1", "no broadcasts here")
    assert.deepEqual(bus.snapshot(), {})
  })

  it("evicts old messages when exceeding capacity", () => {
    const bus = new TaskBus({ maxMessages: 10 })
    for (let i = 0; i < 15; i++) {
      bus.publish("t1", `key${i}`, `val${i}`)
    }
    // After eviction, messages should be trimmed to ~80% of max
    assert.ok(bus._messages.length <= 10)
  })

  it("clear resets all state", () => {
    const bus = new TaskBus()
    bus.publish("t1", "key", "val")
    bus.clear()
    assert.equal(bus.get("key"), null)
    assert.deepEqual(bus.snapshot(), {})
    assert.equal(bus._messages.length, 0)
  })
})
