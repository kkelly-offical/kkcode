import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { touchSession, flushNow } from "../src/session/store.mjs"
import { summarizeSessionRuntimeState } from "../src/session/runtime-state.mjs"

let home = ""
let project = ""
let oldCwd = process.cwd()

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-session-state-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-session-state-project-"))
  oldCwd = process.cwd()
  process.chdir(project)
  process.env.KKCODE_HOME = home
})

test.afterEach(async () => {
  process.chdir(oldCwd)
  delete process.env.KKCODE_HOME
  await flushNow()
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

test("summarizeSessionRuntimeState aggregates session, background, and audit information", async () => {
  await touchSession({
    sessionId: "ses_runtime_1",
    mode: "agent",
    model: "gpt-test",
    providerType: "local",
    cwd: project,
    status: "active"
  })
  await flushNow()

  const summary = await summarizeSessionRuntimeState({ sessionId: "ses_runtime_1", cwd: project, recoveryEnabled: true })
  assert.equal(summary.session.id, "ses_runtime_1")
  assert.equal(summary.session.mode, "agent")
  assert.equal(typeof summary.background.total, "number")
  assert.equal(typeof summary.audit.total, "number")
})
