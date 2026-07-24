import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearGateCache,
  evaluateStoredBranchReviewGate,
  runUsabilityGates
} from "../src/session/usability-gates.mjs"
import { touchSession, flushNow } from "../src/session/store.mjs"
import { captureLocalReview } from "../src/review/branch-review.mjs"

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

test("enabled review gate reports not_applicable explicitly when no review has run", async () => {
  const result = await runUsabilityGates({
    sessionId: "ses_no_review",
    config: {
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
      usage: { budget: { strategy: "warn" } }
    },
    cwd: project
  })
  assert.equal(result.gates.review.status, "not_applicable")
  assert.match(result.gates.review.reason, /has not been run/)
})

test("review gate prefers branchReport and fails closed for stale, incomplete, and unwaived blockers", async () => {
  const sessionId = `ses_branch_gate_${Date.now()}`
  const git = (...args) => execFileSync("git", args, {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
  git("init", "-b", "main")
  git("config", "user.email", "gate@example.com")
  git("config", "user.name", "Gate Test")
  await writeFile(join(project, "app.mjs"), "export const value = 1\n", "utf8")
  git("add", "app.mjs")
  git("commit", "-m", "initial")
  const currentSource = await captureLocalReview({ cwd: project, base: "main" })
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
    usage: { budget: { strategy: "warn" } }
  }
  const reviewDir = join(project, ".kkcode")
  await mkdir(reviewDir, { recursive: true })

  async function runWithReport(branchReport) {
    await writeFile(
      join(reviewDir, "review-state.json"),
      JSON.stringify({
        createdAt: Date.now(),
        sessionId,
        currentIndex: 0,
        files: [{ path: "src/legacy.js", status: "approved" }],
        branchReport
      }, null, 2) + "\n",
      "utf8"
    )
    return runUsabilityGates({ sessionId, config, cwd: project, iteration: 1 })
  }

  const base = {
    schema: "kk.review.v1",
    id: "review-branch",
    diffHash: currentSource.diffHash,
    source: { ...currentSource, diff: undefined },
    stale: false,
    findings: [],
    waivers: [],
    coverage: { complete: true, errors: [] }
  }
  const stale = await runWithReport({
    ...base,
    diffHash: "0".repeat(64),
    stale: true,
    staleReasons: ["diff hash changed"]
  })
  assert.equal(stale.gates.review.status, "fail")
  assert.match(stale.gates.review.reason, /stale/)

  const incomplete = await runWithReport({
    ...base,
    coverage: { complete: false, errors: ["diff exceeded review budget"] }
  })
  assert.equal(incomplete.gates.review.status, "fail")
  assert.match(incomplete.gates.review.reason, /incomplete/)

  const blocked = await runWithReport({
    ...base,
    findings: [{ id: "finding-high", severity: "high", title: "Unsafe change" }]
  })
  assert.equal(blocked.gates.review.status, "fail")
  assert.match(blocked.gates.review.reason, /critical\/high/)

  const waived = await runWithReport({
    ...base,
    findings: [
      { id: "finding-high", severity: "high", title: "Accepted blocker" },
      { id: "finding-medium", severity: "medium", title: "Warning" }
    ],
    waivers: [{ findingId: "finding-high", reason: "Accepted by the release owner." }]
  })
  assert.equal(waived.gates.review.status, "pass")
  assert.equal(waived.allPass, true)

  assert.equal(evaluateStoredBranchReviewGate({
    ...base,
    findings: [{ id: "finding-high", severity: "critical", title: "Unsafe" }],
    waivers: [{ findingId: "finding-high", reason: " " }]
  }).status, "fail")
})

test("review usability gate revalidates the current diff before passing", async () => {
  const git = (...args) => execFileSync("git", args, {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
  git("init", "-b", "main")
  git("config", "user.email", "gate@example.com")
  git("config", "user.name", "Gate Test")
  await writeFile(join(project, "app.mjs"), "export const value = 1\n", "utf8")
  git("add", "app.mjs")
  git("commit", "-m", "initial")
  git("switch", "-c", "feature")
  await writeFile(join(project, "app.mjs"), "export const value = 2\n", "utf8")
  git("add", "app.mjs")
  git("commit", "-m", "feature")

  const source = await captureLocalReview({ cwd: project, base: "main", head: "HEAD", includeWorkingTree: true })
  const reviewDir = join(project, ".kkcode")
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, "review-state.json"), JSON.stringify({
    createdAt: Date.now(),
    files: [],
    branchReport: {
      schema: "kk.review.v1",
      id: "review-current-diff",
      diffHash: source.diffHash,
      source: { ...source, diff: undefined },
      stale: false,
      findings: [],
      waivers: [],
      coverage: { complete: true, errors: [] },
      gate: { status: "passed", blocked: false }
    }
  }, null, 2) + "\n", "utf8")

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
    usage: { budget: { strategy: "warn" } }
  }
  const unchanged = await runUsabilityGates({
    sessionId: "ses_revalidate",
    config,
    cwd: project,
    iteration: 0
  })
  assert.equal(unchanged.gates.review.status, "pass")

  await writeFile(join(project, "app.mjs"), "export const value = 3\n", "utf8")
  const result = await runUsabilityGates({
    sessionId: "ses_revalidate",
    config,
    cwd: project,
    iteration: 1
  })
  assert.equal(result.gates.review.status, "fail")
  assert.match(result.gates.review.reason, /stale/)
})

test("build gate re-runs after project state changes", async () => {
  clearGateCache()
  const config = {
    agent: {
      longagent: {
        usability_gates: {
          build: { enabled: true },
          test: { enabled: false },
          review: { enabled: false },
          health: { enabled: false },
          budget: { enabled: false }
        }
      }
    },
    usage: { budget: { strategy: "warn" } }
  }

  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"' } }),
    "utf8"
  )
  const passed = await runUsabilityGates({
    sessionId: "ses_gate_cache",
    config,
    cwd: project,
    iteration: 1
  })
  assert.equal(passed.gates.build.status, "pass")

  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ scripts: { build: 'node -e "process.exit(1)"' } }),
    "utf8"
  )
  const failed = await runUsabilityGates({
    sessionId: "ses_gate_cache",
    config,
    cwd: project,
    iteration: 1
  })
  assert.equal(failed.gates.build.status, "fail")
})
