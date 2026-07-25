import test from "node:test"
import assert from "node:assert/strict"
import {
  verifyStageObjective,
  stagePlannedFiles,
  OBJECTIVE_MET,
  OBJECTIVE_UNMET,
  OBJECTIVE_UNKNOWN
} from "../src/session/stage-objective.mjs"
import { makeGateResult, makeGateRunner } from "./helpers/gate-fixture.mjs"

// 门禁替身一律走 makeGateResult()。0.4.2 这里每个用例各自手写了一个
// `{ results: { build: {...} } }`，那个形状在生产中从不存在，于是被测代码
// 读错字段、判据全程失效，八个用例照样全绿。契约由
// test/usability-gates-contract.test.mjs 锁死。

const stage = {
  stageId: "stage_1",
  tasks: [
    { taskId: "t1", plannedFiles: ["src/a.mjs", "src/b.mjs"] },
    { taskId: "t2", plannedFiles: ["src/b.mjs", "test/a.test.mjs"] }
  ]
}

const ALL_FILES = ["src/a.mjs", "src/b.mjs", "test/a.test.mjs"]

function statFor(existing) {
  return async (abs) => {
    // Windows 的 path.resolve 产生反斜杠路径 —— 正斜杠的 endsWith 永不匹配，
    // 这一个字符让 verify 矩阵的 Windows job 从 0.4.2 红到 0.5.3。
    const normalized = String(abs).replaceAll("\\", "/")
    const hit = existing.find((f) => normalized.endsWith(f))
    if (!hit) throw new Error("ENOENT")
    return { isFile: () => true, size: 10 }
  }
}

const passingGates = makeGateRunner({ build: "pass", test: "pass" })

test("planned files are collected across tasks and de-duplicated", () => {
  assert.deepEqual(stagePlannedFiles(stage), ALL_FILES)
  assert.deepEqual(stagePlannedFiles({ tasks: [] }), [])
  assert.deepEqual(stagePlannedFiles(null), [])
})

test("all files present and gates passing means the objective is met", async () => {
  const result = await verifyStageObjective({
    stage,
    deps: { stat: statFor(ALL_FILES), runUsabilityGates: passingGates }
  })
  assert.equal(result.status, OBJECTIVE_MET)
  assert.match(result.reason, /3 planned files/)
})

test("regression: the real gate shape reaches OBJECTIVE_MET", async () => {
  // 0.4.2 在这条路径上必然返回 unmet（理由是无意义的 "gates failed: ; "），
  // 因为门禁结果读的是 gates.results.build 而实际在 gates.gates.build。
  // 这个用例专门锁住修复：真实形状 + 全 pass + 文件齐备 → met。
  const real = makeGateResult({ build: "pass", test: "pass" })
  assert.deepEqual(Object.keys(real).sort(), ["allPass", "failures", "gates"])
  assert.equal(real.allPass, true)

  const result = await verifyStageObjective({
    stage,
    deps: { stat: statFor(ALL_FILES), runUsabilityGates: async () => real }
  })
  assert.equal(result.status, OBJECTIVE_MET)
  assert.doesNotMatch(result.reason, /gates failed/)
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
      stat: statFor(ALL_FILES),
      runUsabilityGates: makeGateRunner(
        { build: "pass", test: "fail" },
        { reasons: { test: "2 tests failing" } }
      )
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
  const files = statFor(ALL_FILES)

  const disabled = await verifyStageObjective({
    stage,
    deps: { stat: files, runUsabilityGates: makeGateRunner({ build: "disabled", test: "disabled" }) }
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

test("a drifted gate shape yields unknown and says so, never met", async () => {
  const result = await verifyStageObjective({
    stage,
    deps: {
      stat: statFor(ALL_FILES),
      // 0.4.2 单测里那个虚构的形状。现在它会让 readGate 抛，被捕获为 unknown。
      runUsabilityGates: async () => ({ results: { build: { status: "pass" }, test: { status: "pass" } } })
    }
  })
  assert.equal(result.status, OBJECTIVE_UNKNOWN)
  assert.match(result.reason, /gate contract drift/)
  assert.ok(result.contractError)
})

test("not_applicable gates still count as satisfied", async () => {
  const result = await verifyStageObjective({
    stage,
    deps: {
      stat: statFor(ALL_FILES),
      runUsabilityGates: makeGateRunner({ build: "not_applicable", test: "pass" })
    }
  })
  assert.equal(result.status, OBJECTIVE_MET)
})
