import test from "node:test"
import assert from "node:assert/strict"
import { formatLongagentSessionStatus, recommendLongagentRecoveryCommand } from "../src/commands/longagent.mjs"

test("formatLongagentSessionStatus includes recovery and checkpoint hints", () => {
  const lines = formatLongagentSessionStatus(
    {
      sessionId: "sess_123",
      status: "error",
      phase: "H5",
      currentGate: "test",
      providerType: "openai",
      model: "gpt-5.3-codex",
      progress: { percentage: 72, currentStep: 8, totalSteps: 11 },
      recoveryCount: 2,
      updatedAt: Date.now() - 5000,
      heartbeatAt: Date.now() - 2000,
      currentStageId: "stage-api",
      stageIndex: 1,
      stageCount: 3,
      remainingFilesCount: 2,
      iterations: 4,
      maxIterations: 8,
      backgroundTaskId: "bg_123",
      backgroundTaskStatus: "interrupted",
      backgroundTaskAttempt: 2,
      lastMessage: "background worker exited unexpectedly",
      lastStageReport: {
        stageId: "stage-api",
        status: "fail",
        successCount: 3,
        failCount: 1,
        retryCount: 2,
        remainingFilesCount: 2,
        remainingFiles: ["src/api.mjs", "test/api.test.mjs"]
      },
      stageReports: [
        { stageId: "stage-plan", status: "pass", successCount: 2, failCount: 0 },
        { stageId: "stage-api", status: "fail", successCount: 3, failCount: 1 }
      ],
      checkpoints: [
        { id: "cp_1", kind: "phase", phase: "H4", summary: "coding started" },
        { id: "cp_2", kind: "manual_recovery", phase: "H5", summary: "retry from failing test" }
      ],
      recoverySuggestions: ["rerun failed stage with kkcode longagent recover", "inspect last stage report"]
    },
    {
      id: "bg_123",
      status: "interrupted",
      attempt: 2
    }
  )

  const text = lines.join("\n")
  assert.match(text, /timeline:/)
  assert.match(text, /stage stage-plan PASS ok=2 fail=0/)
  assert.match(text, /checkpoint cp_2 H5 manual_recovery retry from failing test/)
  assert.match(text, /background interrupted task=bg_123 attempt=2/)
  assert.match(text, /recovery suggestions:/)
  assert.match(text, /recommended reason: background task is interrupted/)
  assert.match(text, /kkcode longagent recover --session sess_123/)
  assert.match(text, /kkcode longagent recover-checkpoint --session sess_123 --checkpoint cp_2/)
  assert.match(text, /last stage: stage-api FAIL ok=3 fail=1 retry=2/)
})

test("recommendLongagentRecoveryCommand prefers background recover before checkpoint retry", () => {
  const command = recommendLongagentRecoveryCommand({
    sessionId: "sess_123",
    backgroundTaskStatus: "interrupted",
    checkpoints: [
      { id: "cp_2", kind: "manual_recovery", phase: "H5", summary: "retry from failing test" }
    ],
    lastStageReport: {
      status: "fail"
    }
  })

  assert.equal(command, "kkcode longagent recover --session sess_123")
})
