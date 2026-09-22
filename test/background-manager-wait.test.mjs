import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BackgroundManager } from "../src/kernel/orchestration/background-manager.mjs"

let testDirectory = "", previousRoot
let launched = [], gates = []
const waitOptions = { timeoutMs: 15000, tickMs: 20 }
function deferred() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}
async function launchControlled(description, reply) {
  const gate = deferred(), started = deferred()
  gates.push(gate)
  const task = await BackgroundManager.launch({
    description, payload: {}, config: {},
    run: async () => { started.release(); await gate.promise; return { reply } }
  })
  launched.push(task.id)
  await started.promise
  return { task, release: gate.release }
}

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "kkcode-bg-wait-"))
  previousRoot = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = testDirectory
  launched = []; gates = []
})

afterEach(async () => {
  // Never delete a fixture root while an inline worker can still write into it
  // or change KKCODE_HOME underneath the previous test's completion path.
  for (const gate of gates) gate.release()
  try {
    for (const id of launched) {
      const task = await BackgroundManager.waitForTask(id, waitOptions)
      assert.equal(task?.status, "completed", "fixture workers must drain before cleanup")
    }
  } finally {
    if (previousRoot === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousRoot
    await rm(testDirectory, { recursive: true, force: true })
  }
})

test("waitForAny ignores unrelated task settlements until a watched task completes", { timeout: 30000 }, async () => {
  const unrelated = await launchControlled("unrelated", "unrelated done")
  const watched = await launchControlled("watched", "watched done")
  let resolved = false
  const waiting = BackgroundManager.waitForAny([watched.task.id], 15000).then(value => { resolved = true; return value })
  unrelated.release()
  assert.equal((await BackgroundManager.waitForTask(unrelated.task.id, waitOptions)).status, "completed")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resolved, false, "unrelated settlement must not resolve the watched wait")
  watched.release()
  assert.deepEqual(await waiting, { id: watched.task.id, status: "completed" })
  const unrelatedTask = await BackgroundManager.get(unrelated.task.id)
  const watchedTask = await BackgroundManager.get(watched.task.id)
  assert.equal(unrelatedTask.status, "completed")
  assert.equal(watchedTask.status, "completed")
})

test("waitForAny returns null when watched tasks do not settle before timeout", { timeout: 30000 }, async () => {
  const pending = await launchControlled("slow watched", "late")
  const settled = await BackgroundManager.waitForAny([pending.task.id], 20)
  assert.equal(settled, null)
  pending.release()
})

test("waitForTask returns the terminal task when it settles", { timeout: 30000 }, async () => {
  const target = await launchControlled("wait target", "done")
  const waiting = BackgroundManager.waitForTask(target.task.id, waitOptions)
  target.release()
  const settled = await waiting
  assert.equal(settled.status, "completed")
  assert.equal(settled.result.reply, "done")
})
