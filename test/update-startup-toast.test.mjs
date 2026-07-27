import test from "node:test"
import assert from "node:assert/strict"
import { notifyUpdateToast } from "../src/update/startup-toast.mjs"

test("update toast appears when a newer version exists", async () => {
  const calls = []
  notifyUpdateToast({
    promise: Promise.resolve({ hasUpdate: true, currentVersion: "0.7.3", latestVersion: "0.8.0", channel: "latest" }),
    showToast: (message, options) => calls.push([message, options])
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], /0\.7\.3 -> 0\.8\.0/)
  assert.match(calls[0][0], /kkcode update --install/)
  assert.deepEqual(calls[0][1], { topic: "update", tone: "warning", durationMs: 8000 })
})

test("no toast when up to date, missing pieces, or a rejected check", async () => {
  const calls = []
  const showToast = (...args) => calls.push(args)
  notifyUpdateToast({ promise: Promise.resolve({ hasUpdate: false }), showToast })
  notifyUpdateToast({ promise: Promise.resolve(null), showToast })
  notifyUpdateToast({ promise: Promise.reject(new Error("offline")), showToast })
  notifyUpdateToast({ promise: null, showToast })
  notifyUpdateToast({
    promise: Promise.resolve({ hasUpdate: true, currentVersion: "0.7.3", latestVersion: "0.8.0", channel: "latest" }),
    showToast: null
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0)
})
