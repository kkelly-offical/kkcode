import test from "node:test"
import assert from "node:assert/strict"
import { LongAgentManager } from "../src/orchestration/longagent-manager.mjs"

test("longagent manager stop and clear flow", async () => {
  const sessionId = `ses_test_${Date.now()}`
  await LongAgentManager.update(sessionId, { status: "running", stopRequested: false })
  const created = await LongAgentManager.get(sessionId)
  assert.equal(created.phase, "L0")
  assert.equal(typeof created.gateStatus, "object")
  assert.equal(created.currentGate, "execution")
  assert.equal(created.recoveryCount, 0)
  await LongAgentManager.stop(sessionId)
  const stopped = await LongAgentManager.get(sessionId)
  assert.equal(stopped.stopRequested, true)
  await LongAgentManager.clearStop(sessionId)
  const resumed = await LongAgentManager.get(sessionId)
  assert.equal(resumed.stopRequested, false)
})
