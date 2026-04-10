import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"

let home = ""

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-bg-wait-"))
  process.env.KKCODE_HOME = home
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("waitForAny ignores unrelated task settlements until a watched task completes", async () => {
  const unrelated = await BackgroundManager.launch({
    description: "unrelated",
    payload: {},
    config: {},
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { reply: "unrelated done" }
    }
  })

  const watched = await BackgroundManager.launch({
    description: "watched",
    payload: {},
    config: {},
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      return { reply: "watched done" }
    }
  })

  const settled = await BackgroundManager.waitForAny([watched.id], 500)
  assert.deepEqual(settled, { id: watched.id, status: "completed" })

  const unrelatedTask = await BackgroundManager.get(unrelated.id)
  const watchedTask = await BackgroundManager.get(watched.id)
  assert.equal(unrelatedTask.status, "completed")
  assert.equal(watchedTask.status, "completed")
})

test("waitForAny returns null when watched tasks do not settle before timeout", async () => {
  const pending = await BackgroundManager.launch({
    description: "slow watched",
    payload: {},
    config: {},
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return { reply: "late" }
    }
  })

  const settled = await BackgroundManager.waitForAny([pending.id], 20)
  assert.equal(settled, null)
})
