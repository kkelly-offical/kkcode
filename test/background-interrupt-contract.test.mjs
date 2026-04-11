import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"
import { ensureBackgroundTaskRuntimeDir, backgroundTaskCheckpointPath } from "../src/storage/paths.mjs"
import { writeJson } from "../src/storage/json-store.mjs"
import { INTERRUPTION_REASONS, normalizeInterruptionReason } from "../src/orchestration/interruption-reason.mjs"

let home = ""

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-bg-interrupt-"))
  process.env.KKCODE_HOME = home
  await ensureBackgroundTaskRuntimeDir()
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("normalizeInterruptionReason maps worker abort messages onto the release contract", () => {
  assert.equal(normalizeInterruptionReason("cancelled by user"), INTERRUPTION_REASONS.USER_CANCEL)
  assert.equal(normalizeInterruptionReason("worker timeout after 5000ms"), INTERRUPTION_REASONS.TIMEOUT)
  assert.equal(normalizeInterruptionReason("parent process exited, worker orphaned"), INTERRUPTION_REASONS.ORPHANED)
  assert.equal(normalizeInterruptionReason("SIGTERM"), INTERRUPTION_REASONS.INTERRUPT)
})

test("background tick stamps timeout interruptionReason for stale workers", async () => {
  const id = "bg_timeout_contract"
  const now = Date.now()
  await writeJson(backgroundTaskCheckpointPath(id), {
    id,
    description: "stale timeout",
    payload: { workerTimeoutMs: 1000 },
    status: "running",
    createdAt: now - 60000,
    updatedAt: now - 60000,
    startedAt: now - 60000,
    endedAt: null,
    logs: [],
    result: null,
    error: null,
    interruptionReason: null,
    cancelled: false,
    backgroundMode: "worker_process",
    workerPid: null,
    lastHeartbeatAt: now - 60000,
    attempt: 1,
    resumeToken: "resume_timeout"
  })

  await BackgroundManager.tick({ background: { worker_timeout_ms: 1000, max_parallel: 1 } })
  const task = await BackgroundManager.get(id)
  assert.equal(task.status, "interrupted")
  assert.equal(task.interruptionReason, INTERRUPTION_REASONS.TIMEOUT)
})

test("background cancel stamps user_cancel and retry clears interruptionReason", async () => {
  const task = await BackgroundManager.launch({
    description: "cancel me",
    payload: {},
    config: {},
    run: async ({ isCancelled }) => {
      while (!(await isCancelled())) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return { reply: "stopped" }
    }
  })

  await BackgroundManager.cancel(task.id)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const cancelled = await BackgroundManager.get(task.id)
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.interruptionReason, INTERRUPTION_REASONS.USER_CANCEL)

  const interruptedId = "bg_retry_contract"
  const now = Date.now()
  await writeJson(backgroundTaskCheckpointPath(interruptedId), {
    id: interruptedId,
    description: "retry contract",
    payload: {},
    status: "interrupted",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    endedAt: now,
    logs: [],
    result: null,
    error: "worker timeout",
    interruptionReason: INTERRUPTION_REASONS.TIMEOUT,
    cancelled: false,
    backgroundMode: "inline",
    workerPid: null,
    lastHeartbeatAt: null,
    attempt: 1,
    resumeToken: "resume_retry"
  })

  const retried = await BackgroundManager.retry(interruptedId, { background: { max_parallel: 1 } })
  assert.equal(retried.status, "pending")
  assert.equal(retried.interruptionReason, null)
})
