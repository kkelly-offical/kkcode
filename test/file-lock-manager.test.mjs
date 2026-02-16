import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { withFileLock } from "../src/tool/file-lock-manager.mjs"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let home = ""
const target = "locked-file.txt"

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-lock-home-"))
  process.env.KKCODE_HOME = home
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("withFileLock serializes writers for the same file", async () => {
  const order = []
  const first = withFileLock({
    targetPath: target,
    owner: "first",
    waitTimeoutMs: 5000,
    run: async () => {
      order.push("first:start")
      await sleep(120)
      order.push("first:end")
    }
  })

  await sleep(20)
  const second = withFileLock({
    targetPath: target,
    owner: "second",
    waitTimeoutMs: 5000,
    run: async () => {
      order.push("second:start")
      order.push("second:end")
    }
  })

  await Promise.all([first, second])

  const firstEnd = order.indexOf("first:end")
  const secondStart = order.indexOf("second:start")
  assert.ok(firstEnd >= 0)
  assert.ok(secondStart >= 0)
  assert.ok(secondStart > firstEnd)
})

