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
  assert.equal(created.objective, "")
  assert.equal(created.stagePlan, null)
  assert.equal(created.lastStageReport, null)
  assert.deepEqual(created.stageReports, [])
  assert.deepEqual(created.checkpoints, [])
  await Promise.race([
    LongAgentManager.stop(sessionId),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stop timed out")), 500))
  ])
  const stopped = await LongAgentManager.get(sessionId)
  assert.equal(stopped.stopRequested, true)
  await Promise.race([
    LongAgentManager.clearStop(sessionId),
    new Promise((_, reject) => setTimeout(() => reject(new Error("clearStop timed out")), 500))
  ])
  const resumed = await LongAgentManager.get(sessionId)
  assert.equal(resumed.stopRequested, false)
})

test("longagent manager stores compact stage reports", async () => {
  const sessionId = `ses_stage_${Date.now()}`
  await LongAgentManager.update(sessionId, { status: "running" })
  await LongAgentManager.pushStageReport(sessionId, {
    stageId: "api-wiring",
    stageName: "API Wiring",
    stageIndex: 1,
    stageCount: 4,
    successCount: 3,
    failCount: 1,
    retryCount: 2,
    remainingFiles: ["src/a.mjs", "src/b.mjs", "src/a.mjs"],
    fileChanges: [{ path: "src/a.mjs" }, { path: "src/b.mjs" }],
    totalCost: 0.1234
  })
  const updated = await LongAgentManager.get(sessionId)
  assert.equal(updated.lastStageReport.stageId, "api-wiring")
  assert.equal(updated.lastStageReport.status, "fail")
  assert.equal(updated.lastStageReport.remainingFilesCount, 2)
  assert.equal(updated.lastStageReport.fileChangesCount, 2)
  assert.equal(updated.stageReports.length, 1)
})

test("longagent manager stores capped checkpoints", async () => {
  const sessionId = `ses_checkpoint_${Date.now()}`
  await LongAgentManager.update(sessionId, {
    status: "running",
    objective: "wire provider runtime",
    stagePlan: { planId: "plan_1", stages: [{ stageId: "catalog" }] }
  })
  await LongAgentManager.checkpoint(sessionId, {
    phase: "H1",
    kind: "phase",
    summary: "entered phase H1"
  })
  const updated = await LongAgentManager.get(sessionId)
  assert.equal(updated.objective, "wire provider runtime")
  assert.equal(updated.stagePlan.planId, "plan_1")
  assert.equal(updated.checkpoints.length, 1)
  assert.equal(updated.checkpoints[0].phase, "H1")
  assert.equal(updated.checkpoints[0].summary, "entered phase H1")
})

test("longagent manager links background task metadata", async () => {
  const sessionId = `ses_bg_${Date.now()}`
  await LongAgentManager.update(sessionId, { status: "pending", objective: "run in background" })
  await LongAgentManager.linkBackgroundTask(sessionId, {
    id: "bg_long_1",
    status: "running",
    attempt: 2,
    updatedAt: 1234567890
  })
  const linked = await LongAgentManager.get(sessionId)
  assert.equal(linked.backgroundTaskId, "bg_long_1")
  assert.equal(linked.backgroundTaskStatus, "running")
  assert.equal(linked.backgroundTaskAttempt, 2)
  assert.equal(linked.backgroundTaskUpdatedAt, 1234567890)
})
