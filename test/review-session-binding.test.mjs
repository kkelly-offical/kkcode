import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { touchSession, flushNow } from "../src/session/store.mjs"

const CLI = resolve("src/index.mjs")
const NODE = process.execPath

let home = ""
let project = ""
let oldCwd = process.cwd()

function runCli(args) {
  return execFileSync(NODE, [CLI, ...args], {
    cwd: project,
    env: { ...process.env, KKCODE_HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-review-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-review-project-"))
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

test("review approve writes decision to bound real session id", async () => {
  const sessionId = `ses_review_${Date.now()}`
  await touchSession({
    sessionId,
    mode: "agent",
    model: "mock",
    providerType: "openai",
    cwd: project
  })
  await flushNow()

  const diffText = [
    "diff --git a/src/a.js b/src/a.js",
    "index 1111111..2222222 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,1 +1,2 @@",
    "-const a = 1;",
    "+const a = 1;",
    "+const b = 2;"
  ].join("\n")
  const diffFile = join(project, "sample.diff")
  await writeFile(diffFile, diffText + "\n", "utf8")

  runCli(["review", "open", "--diff-file", diffFile, "--session", sessionId])
  runCli(["review", "approve", "--index", "0"])

  const shown = JSON.parse(runCli(["session", "show", "--id", sessionId]))
  assert.ok(Array.isArray(shown.session.reviewDecisions))
  assert.equal(shown.session.reviewDecisions.length > 0, true)
  assert.equal(shown.session.reviewDecisions[0].status, "approved")
  assert.equal(shown.session.reviewDecisions[0].file, "src/a.js")
})
