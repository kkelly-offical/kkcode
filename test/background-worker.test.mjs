import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"
import { ensureBackgroundTaskRuntimeDir, backgroundTaskCheckpointPath } from "../src/storage/paths.mjs"
import { writeJson } from "../src/storage/json-store.mjs"

let home = ""

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-bg-worker-"))
  process.env.KKCODE_HOME = home
  await ensureBackgroundTaskRuntimeDir()
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("background tick marks stale running task as interrupted", async () => {
  const id = "bg_stale_task"
  const now = Date.now()
  await writeJson(backgroundTaskCheckpointPath(id), {
    id,
    description: "stale",
    payload: { workerTimeoutMs: 1000 },
    status: "running",
    createdAt: now - 60000,
    updatedAt: now - 60000,
    startedAt: now - 60000,
    endedAt: null,
    logs: [],
    result: null,
    error: null,
    cancelled: false,
    backgroundMode: "worker_process",
    workerPid: 999999,
    lastHeartbeatAt: now - 60000,
    attempt: 1,
    resumeToken: "resume_1"
  })

  await BackgroundManager.tick({ background: { worker_timeout_ms: 1000, max_parallel: 1 } })
  const task = await BackgroundManager.get(id)
  assert.equal(task.status, "interrupted")
  assert.ok(task.error)
})

test("background retry increases attempt for interrupted task", async () => {
  const id = "bg_retry_task"
  const now = Date.now()
  await writeJson(backgroundTaskCheckpointPath(id), {
    id,
    description: "retry me",
    payload: {},
    status: "interrupted",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    endedAt: now,
    logs: [],
    result: null,
    error: "worker timeout",
    cancelled: false,
    backgroundMode: "inline",
    workerPid: null,
    lastHeartbeatAt: null,
    attempt: 1,
    resumeToken: "resume_1"
  })

  const retried = await BackgroundManager.retry(id, { background: { max_parallel: 1 } })
  assert.ok(retried)
  assert.equal(retried.status, "pending")
  assert.equal(retried.attempt, 2)
  assert.equal(retried.cancelled, false)
  assert.equal(retried.error, null)
})
