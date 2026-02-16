import test from "node:test"
import assert from "node:assert/strict"
import {
  clearRejections,
  enqueueRejection,
  listRejections,
  markRejectionsConsumed,
  pendingRejections
} from "../src/review/rejection-queue.mjs"

test("rejection queue enqueue and consume flow", async () => {
  await clearRejections(process.cwd())
  const entry = await enqueueRejection({ file: "src/a.ts", reason: "missing check", riskScore: 7 }, process.cwd())
  const pending = await pendingRejections(process.cwd())
  assert.equal(pending.some((item) => item.id === entry.id), true)
  await markRejectionsConsumed([entry.id], "ses_x", process.cwd())
  const pendingAfter = await pendingRejections(process.cwd())
  assert.equal(pendingAfter.some((item) => item.id === entry.id), false)
  const all = await listRejections(process.cwd())
  assert.equal(all.length >= 1, true)
})
