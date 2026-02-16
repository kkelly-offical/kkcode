import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runUsabilityGates } from "../src/session/usability-gates.mjs"
import { touchSession, flushNow } from "../src/session/store.mjs"

let home = ""
let project = ""
let oldCwd = process.cwd()

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-gates-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-gates-project-"))
  oldCwd = process.cwd()
  process.chdir(project)
  process.env.KKCODE_HOME = home
})

afterEach(async () => {
  process.chdir(oldCwd)
  await flushNow()
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

test("review gate fails on pending review and passes after approval", async () => {
  const sessionId = `ses_gate_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "agent",
    model: "mock-model",
    providerType: "openai",
    cwd: project
  })

  const config = {
    agent: {
      longagent: {
        usability_gates: {
          build: { enabled: false },
          test: { enabled: false },
          review: { enabled: true },
          health: { enabled: false },
          budget: { enabled: false }
        }
      }
    },
    usage: {
      budget: { strategy: "warn" }
    }
  }

  const reviewDir = join(project, ".kkcode")
  await mkdir(reviewDir, { recursive: true })

  await writeFile(
    join(reviewDir, "review-state.json"),
    JSON.stringify(
      {
        createdAt: Date.now(),
        sessionId,
        currentIndex: 0,
        files: [{ path: "src/a.js", status: "pending" }]
      },
      null,
      2
    ) + "\n",
    "utf8"
  )

  const failed = await runUsabilityGates({
    sessionId,
    config,
    cwd: project,
    iteration: 1
  })
  assert.equal(failed.allPass, false)
  assert.equal(failed.gates.review.status, "fail")

  await writeFile(
    join(reviewDir, "review-state.json"),
    JSON.stringify(
      {
        createdAt: Date.now(),
        sessionId,
        currentIndex: 0,
        files: [{ path: "src/a.js", status: "approved" }]
      },
      null,
      2
    ) + "\n",
    "utf8"
  )

  const passed = await runUsabilityGates({
    sessionId,
    config,
    cwd: project,
    iteration: 2
  })
  assert.equal(passed.allPass, true)
  assert.equal(passed.gates.review.status, "pass")
})
