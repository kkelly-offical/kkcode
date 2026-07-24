import test from "node:test"
import assert from "node:assert/strict"
import { createFrameBatcher } from "../src/ui/frame-batcher.mjs"

function createFakeTimers() {
  const timers = new Map()
  const cleared = []
  let sequence = 0

  return {
    cleared,
    setTimer(callback, delay) {
      const id = ++sequence
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer(id) {
      cleared.push(id)
      timers.delete(id)
    },
    runNext() {
      const entry = timers.entries().next().value
      if (!entry) return false
      const [id, timer] = entry
      timers.delete(id)
      timer.callback()
      return true
    },
    entries() {
      return [...timers.entries()]
    }
  }
}

test("createFrameBatcher coalesces repeated invalidations into one frame", () => {
  const clock = createFakeTimers()
  let flushes = 0
  const batcher = createFrameBatcher({
    flush: () => { flushes++ },
    frameMs: 16,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })

  assert.equal(batcher.schedule(), true)
  assert.equal(batcher.schedule(), false)
  assert.equal(batcher.schedule(), false)
  assert.deepEqual(clock.entries().map(([, timer]) => timer.delay), [16])
  assert.equal(flushes, 0)
  assert.equal(batcher.pending, true)

  assert.equal(clock.runNext(), true)
  assert.equal(flushes, 1)
  assert.equal(batcher.pending, false)

  assert.equal(batcher.schedule(), true)
  assert.equal(clock.runNext(), true)
  assert.equal(flushes, 2)
})

test("createFrameBatcher flushNow publishes pending state before finalization", () => {
  const clock = createFakeTimers()
  const snapshots = []
  let state = ""
  const batcher = createFrameBatcher({
    flush: () => snapshots.push(state),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })

  state += "hel"
  batcher.schedule()
  state += "lo"
  batcher.schedule()

  assert.equal(batcher.flushNow(), true)
  assert.deepEqual(snapshots, ["hello"])
  assert.deepEqual(clock.entries(), [])
  assert.deepEqual(clock.cleared, [1])
  assert.equal(batcher.flushNow(), false)
})

test("createFrameBatcher dispose cancels work and ignores later schedules", () => {
  const clock = createFakeTimers()
  let flushes = 0
  const batcher = createFrameBatcher({
    flush: () => { flushes++ },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })

  batcher.schedule()
  batcher.dispose()

  assert.deepEqual(clock.entries(), [])
  assert.equal(batcher.pending, false)
  assert.equal(batcher.schedule(), false)
  assert.equal(batcher.flushNow(), false)
  assert.equal(flushes, 0)
})
