import test from "node:test"
import assert from "node:assert/strict"
import { PACKAGE_VERSION } from "../src/version.mjs"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { compareVersions, checkForUpdate, updateMessage, installUpdate, maybeNotifyUpdateOnStartup } from "../src/update/checker.mjs"

function mockFetch(body, status = 200) {
  return async (url) => ({
    ok: status >= 200 && status < 300,
    status,
    url,
    async json() { return body }
  })
}

test("compareVersions handles stable and prerelease ordering", () => {
  assert.equal(compareVersions("0.2.3-preview.1", "0.2.1") > 0, true)
  assert.equal(compareVersions("0.2.3", "0.2.3-preview.9") > 0, true)
  assert.equal(compareVersions("0.2.3-preview.2", "0.2.3-preview.1") > 0, true)
  assert.equal(compareVersions("0.2.3-preview.1", "0.2.3") < 0, true)
})

test("checkForUpdate reads the configured npm dist-tag and writes cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kkcode-update-test-"))
  const stateFile = join(dir, "update-state.json")
  try {
    const result = await checkForUpdate({ update: { channel: "preview", check_interval_hours: 12 } }, {
      force: true,
      currentVersion: "0.2.1",
      stateFile,
      fetchImpl: mockFetch({ "dist-tags": { latest: "0.2.1", preview: "0.2.3-preview.1" } })
    })
    assert.equal(result.hasUpdate, true)
    assert.equal(result.latestVersion, "0.2.3-preview.1")
    assert.match(updateMessage(result), /kkcode 0\.2\.1 -> 0\.2\.3-preview\.1/)
    const saved = JSON.parse(await readFile(stateFile, "utf8"))
    assert.equal(saved.channel, "preview")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("checkForUpdate respects cached interval", async () => {
  const state = { checkedAt: new Date("2026-05-23T00:00:00.000Z").toISOString() }
  const result = await checkForUpdate({ update: { check_interval_hours: 24 } }, {
    now: Date.parse("2026-05-23T01:00:00.000Z"),
    state,
    fetchImpl: async () => { throw new Error("should not fetch") }
  })
  assert.equal(result.skipped, true)
  assert.equal(result.reason, "interval")
})

test("installUpdate shells out to npm global install with selected channel", async () => {
  const calls = []
  const result = await installUpdate({ update: { channel: "preview" } }, {
    npmCommand: "npm",
    runCommand: async (cmd, args) => {
      calls.push([cmd, args])
      return { ok: true, code: 0 }
    }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0], ["npm", ["install", "-g", "@kkelly-offical/kkcode@preview"]])
})

test("startup notifier prints but does not throw on registry failures", async () => {
  const lines = []
  const result = await maybeNotifyUpdateOnStartup({ update: { enabled: true, notify_on_startup: true } }, {
    force: true,
    verbose: true,
    print: (line) => lines.push(line),
    fetchImpl: async () => { throw new Error("offline") }
  })
  assert.equal(result.ok, false)
  assert.match(lines[0], /update check failed: offline/)
})

test("registry update request identifies KK Code instead of Node", async () => {
  let received
  const dir = await mkdtemp(join(tmpdir(), "kkcode-update-header-"))
  try {
    await checkForUpdate({}, {
      force: true,
      stateFile: join(dir, "state.json"),
      fetchImpl: async (_url, options) => {
        received = options.headers
        return {
          ok: true,
          async json() { return { "dist-tags": { latest: "0.3.1" } } }
        }
      }
    })
    assert.match(received["User-Agent"], new RegExp(`^KK-Code/${PACKAGE_VERSION.replaceAll(".", "\\.")} `))
    assert.equal(received["X-KK-Code-Client"], "cli")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
