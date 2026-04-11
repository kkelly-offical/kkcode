import test from "node:test"
import assert from "node:assert/strict"
import { LongAgentManager } from "../src/orchestration/longagent-manager.mjs"

test("longagent stop contract preserves resumable state until clearStop", async () => {
  const sessionId = `ses_longagent_contract_${Date.now()}`
  await LongAgentManager.update(sessionId, {
    status: "running",
    phase: "L2",
    stageIndex: 1,
    stageCount: 3,
    stopRequested: false,
    lastMessage: "executing stage 2"
  })

  await LongAgentManager.stop(sessionId)
  const stopped = await LongAgentManager.get(sessionId)
  assert.equal(stopped.stopRequested, true)
  assert.equal(stopped.phase, "L2")
  assert.equal(stopped.stageIndex, 1)
  assert.equal(stopped.stageCount, 3)

  await LongAgentManager.clearStop(sessionId)
  const resumed = await LongAgentManager.get(sessionId)
  assert.equal(resumed.stopRequested, false)
  assert.equal(resumed.phase, "L2")
  assert.equal(resumed.lastMessage, "executing stage 2")
})
