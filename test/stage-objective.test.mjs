import test from "node:test"
import assert from "node:assert/strict"
import {
  verifyStageObjective,
  stagePlannedFiles,
  OBJECTIVE_MET,
  OBJECTIVE_UNMET,
  OBJECTIVE_UNKNOWN
} from "../src/session/stage-objective.mjs"

const stage = {
  stageId: "stage_1",
  tasks: [
    { taskId: "t1", plannedFiles: ["src/a.mjs", "src/b.mjs"] },
    { taskId: "t2", plannedFiles: ["src/b.mjs", "test/a.test.mjs"] }
  ]
}

function statFor(existing) {
  return async (abs) => {
    const hit = existing.find((f) => abs.endsWith(f))
    if (!hit) throw new Error("ENOENT")
    return { isFile: () => true, size: 10 }
  }
}

const passingGates = async () => ({ results: { build: { status: "pass" }, test: { status: "pass" } } })

test("planned files are collected across tasks and de-duplicated", () => {
  assert.deepEqual(stagePlannedFiles(stage), ["src/a.mjs", "src/b.mjs", "test/a.test.mjs"])
  assert.deepEqual(stagePlannedFiles({ tasks: [] }), [])
  assert.deepEqual(stagePlannedFiles(null), [])
})

test("all files present and gates passing means the objective is met", async () => {
  const result = await verifyStageObjective({
    stage,
    deps: { stat: statFor(["src/a.mjs", "src/b.mjs", "test/a.test.mjs"]), runUsabilityGates: passingGates }
  })
  assert.equal(result.status, OBJECTIVE_MET)
  assert.match(result.reason, /3 planned files/)
})

test("a missing planned file means unmet, and gates are not even run", async () => {
  let gatesRan = false
  const result = await verifyStageObjective({
    stage,
    deps: {
      stat: statFor(["src/a.mjs"]),
      runUsabilityGates: async () => { gatesRan = true; return passingGates() }
    }
  })
  assert.equal(result.status, OBJECTIVE_UNMET)
  assert.deepEqual(result.missing, ["src/b.mjs", "test/a.test.mjs"])
  assert.equal(gatesRan, false, "no point running gates when the output is not there")
})

test("an empty file counts as missing", async () => {
  const result = await verifyStageObjective({
    stage: { tasks: [{ plannedFiles: ["src/a.mjs"] }] },
    deps: {
      stat: async () => ({ isFile: () => true, size: 0 }),
      runUsabilityGates: passingGates
    }
  })
  assert.equal(result.status, OBJECTIVE_UNMET)
})

test("failing build or test keeps the objective unmet", async () => {
  const result = await verifyStageObjective({
    stage,
    deps: {
      stat: statFor(["src/a.mjs", "src/b.mjs", "test/a.test.mjs"]),
      runUsabilityGates: async () => ({
        results: { build: { status: "pass" }, test: { status: "fail", reason: "2 tests failing" } }
      })
    }
  })
  assert.equal(result.status, OBJECTIVE_UNMET)
  assert.match(result.reason, /2 tests failing/)
})

test("no declared files means unknown, never a false completion", async () => {
  const result = await verifyStageObjective({
    stage: { stageId: "s", tasks: [{ taskId: "t" }] },
    deps: { stat: statFor([]), runUsabilityGates: passingGates }
  })
  assert.equal(result.status, OBJECTIVE_UNKNOWN)
})

test("disabled or unavailable gates yield unknown rather than met", async () => {
  const files = statFor(["src/a.mjs", "src/b.mjs", "test/a.test.mjs"])

  const disabled = await verifyStageObjective({
    stage,
    deps: {
      stat: files,
      runUsabilityGates: async () => ({ results: { build: { status: "disabled" }, test: { enabled: false } } })
    }
  })
  assert.equal(disabled.status, OBJECTIVE_UNKNOWN)

  const noRunner = await verifyStageObjective({ stage, deps: { stat: files } })
  assert.equal(noRunner.status, OBJECTIVE_UNKNOWN)

  const threw = await verifyStageObjective({
    stage,
    deps: { stat: files, runUsabilityGates: async () => { throw new Error("gate blew up") } }
  })
  assert.equal(threw.status, OBJECTIVE_UNKNOWN)
})

test("not_applicable gates still count as satisfied", async () => {
  const result = await verifyStageObjective({
    stage,
    deps: {
      stat: statFor(["src/a.mjs", "src/b.mjs", "test/a.test.mjs"]),
      runUsabilityGates: async () => ({
        results: { build: { status: "not_applicable" }, test: { status: "pass" } }
      })
    }
  })
  assert.equal(result.status, OBJECTIVE_MET)
})
