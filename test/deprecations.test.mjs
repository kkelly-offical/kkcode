import test from "node:test"
import assert from "node:assert/strict"
import {
  noteDeprecation,
  noteRenamed,
  onDeprecation,
  drainDeprecations,
  listDeprecations,
  formatDeprecation,
  resetDeprecations
} from "../src/core/deprecations.mjs"

test("a deprecation key only fires once per process", (t) => {
  t.after(resetDeprecations)
  resetDeprecations()

  assert.equal(noteDeprecation("mode.longagent", "use /ultra"), true)
  assert.equal(noteDeprecation("mode.longagent", "use /ultra"), false)
  assert.equal(noteDeprecation("mode.longagent", "different message"), false)

  const notices = drainDeprecations()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].key, "mode.longagent")
  assert.equal(notices[0].message, "use /ultra")
  assert.equal(notices[0].removal, "0.5.0")
})

test("distinct keys each get their own one-shot notice", (t) => {
  t.after(resetDeprecations)
  resetDeprecations()

  noteDeprecation("permission.level.full-auto", "a")
  noteDeprecation("permission.mode", "b")
  noteDeprecation("permission.level.full-auto", "a")

  assert.deepEqual(drainDeprecations().map((n) => n.key), [
    "permission.level.full-auto",
    "permission.mode"
  ])
})

test("listeners receive notices synchronously and survive throwing handlers", (t) => {
  t.after(resetDeprecations)
  resetDeprecations()

  const seen = []
  const unsubscribe = onDeprecation(() => { throw new Error("boom") })
  onDeprecation((notice) => seen.push(notice.key))

  noteDeprecation("config.agent.longagent", "renamed")
  assert.deepEqual(seen, ["config.agent.longagent"])

  unsubscribe()
  noteDeprecation("config.four_stage", "removed")
  assert.deepEqual(seen, ["config.agent.longagent", "config.four_stage"])
})

test("draining clears pending notices but listing does not", (t) => {
  t.after(resetDeprecations)
  resetDeprecations()

  noteDeprecation("a", "first")
  assert.equal(listDeprecations().length, 1)
  assert.equal(listDeprecations().length, 1)
  assert.equal(drainDeprecations().length, 1)
  assert.equal(drainDeprecations().length, 0)
})

test("empty keys are ignored", (t) => {
  t.after(resetDeprecations)
  resetDeprecations()

  assert.equal(noteDeprecation("", "nothing"), false)
  assert.equal(noteDeprecation("   ", "nothing"), false)
  assert.equal(drainDeprecations().length, 0)
})

test("renamed helper produces a readable bilingual-safe message", (t) => {
  t.after(resetDeprecations)
  resetDeprecations()

  noteRenamed("config.agent.longagent", {
    from: "agent.longagent",
    to: "agent.ultra"
  })
  const [notice] = drainDeprecations()
  assert.match(notice.message, /配置项 `agent\.longagent` 已更名为 `agent\.ultra`/)
  assert.match(formatDeprecation(notice), /0\.5\.0 移除/)
})
