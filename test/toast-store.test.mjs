import test from "node:test"
import assert from "node:assert/strict"
import { createToastStore } from "../src/ui/toast-store.mjs"

function fakeTimers() {
  const timers = []
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  }
}

test("toast topics replace in place and refresh their TTL", () => {
  let clock = 1000
  const timers = fakeTimers()
  const store = createToastStore({
    durationMs: 100,
    now: () => clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })

  const firstId = store.show("model: kimi-k3", { topic: "model" })
  clock = 1050
  const replacementId = store.show("model: kimi-code", { topic: "model", tone: "success" })

  assert.equal(replacementId, firstId)
  assert.equal(store.getToasts({ pruneExpired: false }).length, 1)
  assert.equal(store.getToasts({ pruneExpired: false })[0].message, "model: kimi-code")
  assert.equal(store.getToasts({ pruneExpired: false })[0].expiresAt, 1150)

  clock = 1149
  assert.equal(store.prune(), 0)
  clock = 1150
  assert.equal(store.prune(), 1)
  assert.deepEqual(store.getToasts({ pruneExpired: false }), [])
  store.dispose()
})

test("zero-duration toasts are persistent until dismissed", () => {
  const store = createToastStore({ durationMs: 0 })
  const id = store.push({ message: "offline", topic: "connection", tone: "error" })

  assert.equal(store.getNextExpiryAt(), null)
  assert.equal(store.prune(Number.MAX_SAFE_INTEGER), 0)
  assert.equal(store.dismiss(id), true)
  assert.equal(store.getToasts({ pruneExpired: false }).length, 0)
  store.dispose()
})

test("toast topics can be dismissed without clearing unrelated notices", () => {
  const store = createToastStore()
  store.show("retry", { topic: "provider-retry", durationMs: 0 })
  store.show("mode", { topic: "mode", durationMs: 0 })
  assert.equal(store.dismissTopic("provider-retry"), 1)
  assert.deepEqual(store.getToasts().map((toast) => toast.topic), ["mode"])
  store.dispose()
})

test("replacing an older topic makes it the newest visible toast", () => {
  const store = createToastStore({ durationMs: 1000 })
  store.show("mode one", { topic: "mode" })
  store.show("provider one", { topic: "provider" })
  store.show("mode two", { topic: "mode" })
  assert.deepEqual(
    store.getToasts().map((toast) => toast.message),
    ["provider one", "mode two"]
  )
  store.dispose()
})
