import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  verifyCriterion, verifyGoal, commandAllowlist,
  GOAL_MET, GOAL_UNMET, GOAL_UNKNOWN, GOAL_BLOCKED_MANUAL
} from "../src/session/goal-verifier.mjs"
import {
  parseCriterionString, normalizeGoal,
  CRITERION_PASS, CRITERION_FAIL, CRITERION_UNKNOWN, CRITERION_MANUAL
} from "../src/session/goal-model.mjs"
import { makeGateResult } from "./helpers/gate-fixture.mjs"

const tmp = await mkdtemp(path.join(os.tmpdir(), "kkcode-verifier-"))
await writeFile(path.join(tmp, "present.md"), "# Report\nversion 0.5.0 shipped\n")
await writeFile(path.join(tmp, "empty.md"), "")

test.after(async () => { await rm(tmp, { recursive: true, force: true }).catch(() => {}) })

describe("file_exists / content_match", () => {
  it("存在且非空 → pass；空文件与缺失 → fail", async () => {
    const pass = await verifyCriterion(parseCriterionString("present.md"), { cwd: tmp })
    assert.equal(pass.status, CRITERION_PASS)
    assert.ok(pass.evidence.bytes > 0)

    const empty = await verifyCriterion(parseCriterionString("empty.md"), { cwd: tmp })
    assert.equal(empty.status, CRITERION_FAIL)

    const missing = await verifyCriterion(parseCriterionString("nope.md"), { cwd: tmp })
    assert.equal(missing.status, CRITERION_FAIL)
  })

  it("内容匹配与 negate", async () => {
    const hit = await verifyCriterion(parseCriterionString("present.md contains 0.5.0"), { cwd: tmp })
    assert.equal(hit.status, CRITERION_PASS)

    const miss = await verifyCriterion(parseCriterionString("present.md contains 9.9.9"), { cwd: tmp })
    assert.equal(miss.status, CRITERION_FAIL)

    const negate = await verifyCriterion(
      { id: "n1", kind: "content_match", text: "无 TODO", severity: "blocking", spec: { path: "present.md", pattern: "TODO", negate: true } },
      { cwd: tmp })
    assert.equal(negate.status, CRITERION_PASS)
  })

  it("非法正则 → unknown 而非炸掉整个核验", async () => {
    const bad = await verifyCriterion(
      { id: "b1", kind: "content_match", text: "x", severity: "blocking", spec: { path: "present.md", pattern: "([" } },
      { cwd: tmp })
    assert.equal(bad.status, CRITERION_UNKNOWN)
  })
})

describe("command 判据的三层防护", () => {
  it("真实执行：退出码判定 + 证据采集", async () => {
    const ok = await verifyCriterion(parseCriterionString("node -e process.exit(0)"), { cwd: tmp })
    assert.equal(ok.status, CRITERION_PASS)
    assert.equal(ok.evidence.exitCode, 0)

    const fail = await verifyCriterion(parseCriterionString("node -e process.exit(3)"), { cwd: tmp })
    assert.equal(fail.status, CRITERION_FAIL)
    assert.equal(fail.evidence.exitCode, 3)
    assert.match(fail.reason, /期望 0/)
  })

  it("不在 allowlist → 降级为 manual，不是 pass 也不是拒绝", async () => {
    const curl = await verifyCriterion(
      { id: "c1", kind: "command_exit", text: "curl x", severity: "blocking", spec: { command: "curl", args: ["http://x"], expect: 0 } },
      { cwd: tmp })
    assert.equal(curl.status, CRITERION_MANUAL, "降级到 manual 而非 pass 是安全性")
    assert.equal(curl.evidence.downgraded, "not_in_allowlist")
    assert.match(curl.reason, /手动执行/)
  })

  it("exec-policy 拒绝 → fail，被禁的判据命令是计划缺陷，必须让用户看见", async () => {
    // git commit 默认被 exec-policy 禁止（forbid_commit 缺省开）
    const commit = await verifyCriterion(
      { id: "g1", kind: "command_exit", text: "git commit", severity: "blocking", spec: { command: "git", args: ["commit", "-m", "x"], expect: 0 } },
      { cwd: tmp, config: {} })
    assert.equal(commit.status, CRITERION_FAIL, "不是跳过")
    assert.match(commit.reason, /执行策略拒绝/)
  })

  it("allowlist 可配置", () => {
    assert.ok(commandAllowlist({}).includes("node"))
    const custom = commandAllowlist({ agent: { longagent: { ultra: { criteria: { command_allowlist: ["deno"] } } } } })
    assert.deepEqual(custom, ["deno"])
  })
})

describe("gate_pass 判据", () => {
  it("经 readGate 读取，禁用与缺失 → unknown", async () => {
    const criterion = parseCriterionString("build passes")

    const pass = await verifyCriterion(criterion, { gateResult: makeGateResult({ build: "pass" }) })
    assert.equal(pass.status, CRITERION_PASS)

    const fail = await verifyCriterion(criterion, {
      gateResult: makeGateResult({ build: "fail" }, { outputs: { build: "SyntaxError at a.mjs:3" } })
    })
    assert.equal(fail.status, CRITERION_FAIL)
    assert.match(fail.evidence.outputSnippet, /SyntaxError/)

    const disabled = await verifyCriterion(criterion, { gateResult: makeGateResult({ build: "disabled" }) })
    assert.equal(disabled.status, CRITERION_UNKNOWN)

    const absent = await verifyCriterion(criterion, { gateResult: null })
    assert.equal(absent.status, CRITERION_UNKNOWN)
  })

  it("形状漂移 → unknown 且说明原因", async () => {
    const drifted = await verifyCriterion(parseCriterionString("build passes"), { gateResult: { results: {} } })
    assert.equal(drifted.status, CRITERION_UNKNOWN)
    assert.match(drifted.reason, /契约漂移/)
  })
})

describe("manual 永不自动达成（property）", () => {
  it("50 组随机 ctx 下恒为 pending_manual", async () => {
    const criterion = parseCriterionString("looks good to me")
    assert.equal(criterion.kind, "manual")
    let seed = 42
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 50; i++) {
      const ctx = {
        cwd: rand() > 0.5 ? tmp : "/nonexistent",
        config: rand() > 0.5 ? {} : { agent: { longagent: { ultra: { criteria: { command_allowlist: ["node"] } } } } },
        gateResult: rand() > 0.5 ? makeGateResult({ build: "pass", test: "pass" }) : null,
        deps: rand() > 0.5 ? {} : { stat: async () => ({ isFile: () => true, size: 999 }) }
      }
      const result = await verifyCriterion(criterion, ctx)
      assert.equal(result.status, CRITERION_MANUAL, `第 ${i} 组 ctx 让 manual 变成了 ${result.status}`)
    }
  })

  it("唯一出路是用户显式确认", async () => {
    const criterion = parseCriterionString("looks good to me")
    const confirmed = await verifyCriterion(criterion, { manualConfirmed: new Set([criterion.id]) })
    assert.equal(confirmed.status, CRITERION_PASS)
    assert.equal(confirmed.evidence.confirmedBy, "user")
  })
})

describe("verifyGoal 聚合", () => {
  function goalOf(criteria, subGoals = []) {
    const { goal } = normalizeGoal({ objective: "x", criteria, subGoals }, { objective: "x" })
    return goal
  }

  it("全 pass → met；有 fail → unmet；有 unknown 绝不 met", async () => {
    const met = await verifyGoal({ goal: goalOf(["present.md"]), cwd: tmp })
    assert.equal(met.status, GOAL_MET)

    const unmet = await verifyGoal({ goal: goalOf(["present.md", "nope.md"]), cwd: tmp })
    assert.equal(unmet.status, GOAL_UNMET)

    const unknown = await verifyGoal({ goal: goalOf(["present.md", "build passes"]), cwd: tmp, gateResult: null })
    assert.equal(unknown.status, GOAL_UNKNOWN, "无法证明完成 ≠ 完成")
  })

  it("manual 未确认 → blocked_manual，短路一切", async () => {
    const blocked = await verifyGoal({ goal: goalOf(["present.md", "looks right"]), cwd: tmp })
    assert.equal(blocked.status, GOAL_BLOCKED_MANUAL)
    assert.equal(blocked.manual, 1)
  })

  it("advisory 不参与判定", async () => {
    const { goal } = normalizeGoal({
      objective: "x",
      criteria: [
        { kind: "file_exists", spec: { path: "present.md" } },
        { kind: "file_exists", spec: { path: "nope.md" }, severity: "advisory" }
      ]
    }, { objective: "x" })
    const result = await verifyGoal({ goal, cwd: tmp })
    assert.equal(result.status, GOAL_MET, "advisory 的失败不能挡住达成")
  })

  it("子目标：非 optional 全 met 才算，root blocked_manual 一票否决", async () => {
    const treeMet = await verifyGoal({
      goal: goalOf([], [
        { title: "core", criteria: ["present.md"], stageIds: ["s1"] },
        { title: "extra", criteria: ["nope.md"], stageIds: ["s2"], optional: true }
      ]),
      cwd: tmp
    })
    assert.equal(treeMet.status, GOAL_MET, "optional 子目标失败不影响 root")
    assert.equal(treeMet.subGoals[1].status, GOAL_UNMET, "但它的失败必须保留给报告")

    const treeUnmet = await verifyGoal({
      goal: goalOf([], [
        { title: "core", criteria: ["nope.md"], stageIds: ["s1"] }
      ]),
      cwd: tmp
    })
    assert.equal(treeUnmet.status, GOAL_UNMET)

    const treeManual = await verifyGoal({
      goal: goalOf(["present.md"], [
        { title: "core", criteria: ["needs a human eye"], stageIds: ["s1"] }
      ]),
      cwd: tmp
    })
    assert.equal(treeManual.status, GOAL_BLOCKED_MANUAL)
  })

  it("root 有自身判据时子目标全过还不够", async () => {
    const tree = await verifyGoal({
      goal: goalOf(["nope.md"], [{ title: "core", criteria: ["present.md"], stageIds: ["s1"] }]),
      cwd: tmp
    })
    assert.equal(tree.status, GOAL_UNMET, "root 的集成判据失败必须挡住达成")
  })

  it("空目标 → unknown", async () => {
    const empty = await verifyGoal({ goal: null, cwd: tmp })
    assert.equal(empty.status, GOAL_UNKNOWN)
  })
})
