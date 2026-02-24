import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"
import { runStageBarrier } from "../src/orchestration/stage-scheduler.mjs"
import { writeJson } from "../src/storage/json-store.mjs"
import { backgroundTaskCheckpointPath, ensureBackgroundTaskRuntimeDir } from "../src/storage/paths.mjs"

let home = ""
let project = ""
let oldCwd = process.cwd()
let taskCounter = 0

// Mock state: controls how tasks advance
let mockBehaviors = new Map()
let originalLaunch = null
let originalTick = null

function mockTaskId() {
  return `bg_mock_${++taskCounter}`
}

function now() {
  return Date.now()
}

function installMock() {
  originalLaunch = BackgroundManager.launchDelegateTask.bind(BackgroundManager)
  originalTick = BackgroundManager.tick.bind(BackgroundManager)

  BackgroundManager.launchDelegateTask = async ({ description, payload, config }) => {
    const id = mockTaskId()
    await ensureBackgroundTaskRuntimeDir()
    const task = {
      id,
      description,
      payload,
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
      startedAt: null,
      endedAt: null,
      logs: [],
      result: null,
      error: null,
      cancelled: false,
      backgroundMode: "worker_process",
      workerPid: null,
      lastHeartbeatAt: null,
      attempt: Number(payload?.attempt || 1),
      resumeToken: `resume_${now()}`
    }
    await writeJson(backgroundTaskCheckpointPath(id), task)
    // Schedule async advancement
    queueMicrotask(() => advanceTask(id).catch(() => {}))
    return task
  }

  BackgroundManager.tick = async () => {
    // no-op: we advance tasks ourselves
  }
}

function restoreMock() {
  if (originalLaunch) BackgroundManager.launchDelegateTask = originalLaunch
  if (originalTick) BackgroundManager.tick = originalTick
  originalLaunch = null
  originalTick = null
}

async function advanceTask(id) {
  // Small delay to simulate async work
  await new Promise((r) => setTimeout(r, 20))
  const task = await BackgroundManager.get(id)
  if (!task || task.status !== "pending") return

  // Mark running
  await writeJson(backgroundTaskCheckpointPath(id), {
    ...task,
    status: "running",
    startedAt: now(),
    workerPid: process.pid,
    lastHeartbeatAt: now(),
    updatedAt: now()
  })

  await new Promise((r) => setTimeout(r, 20))

  const logicalTaskId = task.payload?.logicalTaskId || ""
  const behavior = mockBehaviors.get(logicalTaskId) || mockBehaviors.get("*") || { type: "success" }

  if (behavior.type === "error") {
    await writeJson(backgroundTaskCheckpointPath(id), {
      ...task,
      status: "error",
      error: behavior.error || "mock error",
      endedAt: now(),
      updatedAt: now()
    })
    return
  }

  if (behavior.type === "silent_error") {
    const result = {
      reply: behavior.reply || "provider error: api timeout 503",
      completed_files: [],
      remaining_files: task.payload?.plannedFiles || [],
      file_changes: [],
      tool_events: 0,
      cost: 0
    }
    await writeJson(backgroundTaskCheckpointPath(id), {
      ...task,
      status: "completed",
      result,
      endedAt: now(),
      updatedAt: now()
    })
    return
  }

  if (behavior.type === "fail_then_succeed") {
    const attempt = Number(task.payload?.attempt || 1)
    if (attempt <= (behavior.failCount || 1)) {
      await writeJson(backgroundTaskCheckpointPath(id), {
        ...task,
        status: "error",
        error: behavior.error || "transient failure",
        endedAt: now(),
        updatedAt: now()
      })
      return
    }
  }

  // Default: success
  const plannedFiles = task.payload?.plannedFiles || []
  const result = {
    reply: behavior.reply || `[TASK_COMPLETE] done with ${plannedFiles.join(", ")}`,
    completed_files: behavior.completedFiles || plannedFiles,
    remaining_files: behavior.remainingFiles || [],
    file_changes: (behavior.completedFiles || plannedFiles).map((f) => ({
      path: f,
      addedLines: 10,
      removedLines: 2,
      stageId: task.payload?.stageId || "",
      taskId: logicalTaskId
    })),
    tool_events: behavior.toolEvents ?? 5,
    cost: 0.01
  }
  await writeJson(backgroundTaskCheckpointPath(id), {
    ...task,
    status: "completed",
    result,
    endedAt: now(),
    updatedAt: now()
  })
}

const baseConfig = {
  agent: { longagent: { parallel: { max_concurrency: 3, task_timeout_ms: 10000, task_max_retries: 2, poll_interval_ms: 50 } } },
  background: { mode: "worker_process", max_parallel: 3 }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-integ-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-integ-proj-"))
  oldCwd = process.cwd()
  process.chdir(project)
  process.env.KKCODE_HOME = home
  taskCounter = 0
  mockBehaviors = new Map()
  installMock()
})

afterEach(async () => {
  restoreMock()
  process.chdir(oldCwd)
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

test("1: multi-stage sequential execution", { timeout: 10000 }, async () => {
  mockBehaviors.set("*", { type: "success" })

  const stage1 = {
    stageId: "stage_1",
    tasks: [{ taskId: "task_a", prompt: "implement A", plannedFiles: ["a.js"], acceptance: [] }]
  }
  const result1 = await runStageBarrier({
    stage: stage1, sessionId: "ses_1", config: baseConfig,
    model: "test", providerType: "local", stageIndex: 0, stageCount: 2
  })
  assert.ok(result1.allSuccess)
  assert.equal(result1.successCount, 1)

  const stage2 = {
    stageId: "stage_2",
    tasks: [{ taskId: "task_b", prompt: "implement B", plannedFiles: ["b.js"], acceptance: [] }]
  }
  const result2 = await runStageBarrier({
    stage: stage2, sessionId: "ses_1", config: baseConfig,
    model: "test", providerType: "local", stageIndex: 1, stageCount: 2,
    priorContext: "stage_1 completed"
  })
  assert.ok(result2.allSuccess)
  assert.equal(result2.successCount, 1)
})

test("2: parallel tasks within a stage", { timeout: 10000 }, async () => {
  mockBehaviors.set("*", { type: "success" })

  const stage = {
    stageId: "stage_par",
    tasks: [
      { taskId: "par_a", prompt: "implement A", plannedFiles: ["a.js"], acceptance: [] },
      { taskId: "par_b", prompt: "implement B", plannedFiles: ["b.js"], acceptance: [] }
    ]
  }
  const result = await runStageBarrier({
    stage, sessionId: "ses_par", config: baseConfig,
    model: "test", providerType: "local"
  })
  assert.ok(result.allSuccess)
  assert.equal(result.successCount, 2)
  assert.equal(result.failCount, 0)
})

test("3: task dependency ordering", { timeout: 10000 }, async () => {
  mockBehaviors.set("*", { type: "success" })

  const stage = {
    stageId: "stage_dep",
    tasks: [
      { taskId: "dep_a", prompt: "implement A", plannedFiles: ["a.js"], acceptance: [] },
      { taskId: "dep_b", prompt: "implement B", plannedFiles: ["b.js"], acceptance: [], dependsOn: ["dep_a"] }
    ]
  }
  const result = await runStageBarrier({
    stage, sessionId: "ses_dep", config: baseConfig,
    model: "test", providerType: "local"
  })
  assert.ok(result.allSuccess)
  assert.equal(result.successCount, 2)
  // dep_b should have started after dep_a completed
  const progA = result.taskProgress.dep_a
  const progB = result.taskProgress.dep_b
  assert.equal(progA.status, "completed")
  assert.equal(progB.status, "completed")
})

test("4: error recovery and retry", { timeout: 10000 }, async () => {
  mockBehaviors.set("retry_task", { type: "fail_then_succeed", failCount: 1, error: "econnreset: connection reset by peer" })

  const stage = {
    stageId: "stage_retry",
    tasks: [
      { taskId: "retry_task", prompt: "implement with retry", plannedFiles: ["r.js"], acceptance: [], maxRetries: 2 }
    ]
  }
  const result = await runStageBarrier({
    stage, sessionId: "ses_retry", config: baseConfig,
    model: "test", providerType: "local"
  })
  assert.ok(result.allSuccess)
  assert.equal(result.retryCount, 1)
  assert.equal(result.taskProgress.retry_task.attempt, 2)
})

test("5: silent error detection", { timeout: 10000 }, async () => {
  mockBehaviors.set("silent_task", {
    type: "silent_error",
    reply: "provider error: api timeout 503 service unavailable"
  })

  const stage = {
    stageId: "stage_silent",
    tasks: [
      { taskId: "silent_task", prompt: "implement", plannedFiles: ["s.js"], acceptance: [], maxRetries: 0 }
    ]
  }
  const result = await runStageBarrier({
    stage, sessionId: "ses_silent", config: baseConfig,
    model: "test", providerType: "local"
  })
  // The mock returns status "completed" but with remaining files,
  // so stage-scheduler should detect incomplete work
  assert.equal(result.allSuccess, false)
  assert.equal(result.taskProgress.silent_task.status, "error")
})

test("6: dependency cascade on failure", { timeout: 10000 }, async () => {
  mockBehaviors.set("cascade_a", { type: "error", error: "permanent failure" })
  mockBehaviors.set("cascade_b", { type: "success" })

  const stage = {
    stageId: "stage_cascade",
    tasks: [
      { taskId: "cascade_a", prompt: "implement A", plannedFiles: ["a.js"], acceptance: [], maxRetries: 0 },
      { taskId: "cascade_b", prompt: "implement B", plannedFiles: ["b.js"], acceptance: [], dependsOn: ["cascade_a"] }
    ]
  }
  const result = await runStageBarrier({
    stage, sessionId: "ses_cascade", config: baseConfig,
    model: "test", providerType: "local"
  })
  assert.equal(result.allSuccess, false)
  assert.equal(result.taskProgress.cascade_a.status, "error")
  assert.equal(result.taskProgress.cascade_b.status, "skipped")
})

test("7: file isolation violation", { timeout: 10000 }, async () => {
  const stage = {
    stageId: "stage_overlap",
    tasks: [
      { taskId: "ov_a", prompt: "implement A", plannedFiles: ["shared.js"], acceptance: [] },
      { taskId: "ov_b", prompt: "implement B", plannedFiles: ["shared.js"], acceptance: [] }
    ]
  }
  await assert.rejects(
    () => runStageBarrier({
      stage, sessionId: "ses_overlap", config: baseConfig,
      model: "test", providerType: "local"
    }),
    (err) => err.message.includes("file isolation violation")
  )
})

test("8: completion marker detection", { timeout: 10000 }, async () => {
  mockBehaviors.set("marker_task", {
    type: "success",
    reply: "All done. [TASK_COMPLETE] Files implemented.",
    toolEvents: 3
  })

  const stage = {
    stageId: "stage_marker",
    tasks: [
      { taskId: "marker_task", prompt: "implement", plannedFiles: ["m.js"], acceptance: [] }
    ]
  }
  const result = await runStageBarrier({
    stage, sessionId: "ses_marker", config: baseConfig,
    model: "test", providerType: "local"
  })
  assert.ok(result.allSuccess)
  assert.ok(result.completionMarkerSeen)
})
