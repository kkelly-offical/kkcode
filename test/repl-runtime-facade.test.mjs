import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { touchSession, flushNow } from "../src/session/store.mjs"
import { buildReplRuntimeSnapshot } from "../src/repl/runtime-facade.mjs"

let home = ""
let project = ""
let oldCwd = process.cwd()

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-repl-runtime-facade-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-repl-runtime-facade-project-"))
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

test("buildReplRuntimeSnapshot returns session, mcp, skills, background, and runtime summary", async () => {
  await touchSession({
    sessionId: "ses_runtime_view",
    mode: "agent",
    model: "gpt-test",
    providerType: "openai",
    cwd: project,
    status: "active"
  })
  await flushNow()

  const snapshot = await buildReplRuntimeSnapshot({
    cwd: project,
    state: { sessionId: "ses_runtime_view", mode: "agent", providerType: "openai", model: "gpt-test" },
    customCommands: [{ name: "ship" }],
    providers: ["openai"],
    mcpRegistry: {
      healthSnapshot() {
        return [{ name: "alpha", ok: true, transport: "stdio" }]
      },
      listTools() {
        return [{ server: "alpha" }]
      }
    },
    skillRegistry: {
      isReady() {
        return true
      },
      list() {
        return [{ type: "skill_md" }]
      }
    }
  })

  assert.equal(snapshot.customCommandCount, 1)
  assert.equal(snapshot.mcpSummary.healthy, 1)
  assert.equal(snapshot.skillSummary.total, 1)
  assert.equal(snapshot.runtimeSummary.session.id, "ses_runtime_view")
  assert.ok(Array.isArray(snapshot.recentSessions))
})
