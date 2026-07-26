import test from "node:test"
import assert from "node:assert/strict"
import { buildBlockedReport, renderBlockedReportText, renderBlockedReportMarkdown } from "../src/session/blocked-report.mjs"

/**
 * 直接构造 ledger.data 的替身，不落盘 —— buildBlockedReport 的铁律之一就是
 * 「只读 ledger」，所以它不该需要真实文件。
 */
function fakeLedger({ status = "completed", gates = {}, criteria = [] } = {}) {
  return {
    path: "/tmp/fake-ledger.json",
    data: {
      sessionId: "evidence-test",
      objective: "把工具层做到同行水平",
      finalStatus: status,
      startedAt: "2026-07-26T00:00:00.000Z",
      endedAt: "2026-07-26T00:12:00.000Z",
      blockers: [],
      userInteractions: [],
      planDefects: [],
      goal: { revisions: [] },
      rounds: [{
        round: 1,
        stages: [],
        fileChanges: [{ path: "src/a.mjs", added: 10, removed: 2 }],
        subGoals: [],
        gates,
        criteria
      }]
    }
  }
}

const PASSING_SMOKE = {
  status: "pass",
  reason: "src/index.mjs --version ran clean",
  outputSnippet: "",
  evidence: {
    target: "src/index.mjs --version",
    kind: "bin",
    exitCode: 0,
    timedOut: false,
    crashSignatures: []
  }
}

test("the success path carries runtime evidence, not just static gate results", () => {
  // 成功时最该留档的是「凭什么说做完了」。前五道门禁全过只说明「看起来没坏」，
  // 只有 smoke 能回答「真的跑起来了」。
  const report = buildBlockedReport(fakeLedger({
    gates: {
      build: { status: "pass", reason: "build succeeded" },
      test: { status: "pass", reason: "tests passed" },
      smoke: PASSING_SMOKE
    },
    criteria: [{ id: "c1", text: "read 上限提到 2000 行", status: "pass", reason: "已验证" }]
  }), { status: "completed" })

  assert.equal(report.status, "completed")
  assert.ok(report.runtimeEvidence, "成功路径必须带运行时证据")
  assert.equal(report.runtimeEvidence.ran, true)
  assert.equal(report.runtimeEvidence.exitCode, 0)
  assert.equal(report.runtimeEvidence.target, "src/index.mjs --version")
  assert.deepEqual(report.runtimeEvidence.crashSignatures, [])
})

test("gate results reach the report at all", () => {
  // 0.7.0 之前门禁结果存在 ledger 里却从未被报告读取 —— 于是「六道门禁全过」
  // 这个结论只存在于日志中，报告读者无从确认。
  const report = buildBlockedReport(fakeLedger({
    gates: {
      build: { status: "pass", reason: "build succeeded" },
      test: { status: "fail", reason: "3 tests failed", outputSnippet: "AssertionError | expected 2" },
      review: { status: "disabled", reason: "review gate disabled" }
    }
  }))
  const names = report.gates.map((g) => g.gate)
  assert.deepEqual(names, ["build", "test"], "禁用的门禁不该出现 —— 列出来会被当成通过")
  const failed = report.gates.find((g) => g.gate === "test")
  assert.equal(failed.status, "fail")
  assert.match(failed.outputSnippet, /AssertionError/, "失败输出必须原样保留")
})

test("a failing smoke gate is reported as runtime evidence of failure", () => {
  const report = buildBlockedReport(fakeLedger({
    gates: {
      build: { status: "pass", reason: "build succeeded" },
      smoke: {
        status: "fail",
        reason: "runtime crash signature: missing module (ERR_MODULE_NOT_FOUND)",
        outputSnippet: "Error: Cannot find module './gone.mjs'",
        evidence: {
          target: "src/index.mjs --version",
          kind: "bin",
          exitCode: 1,
          timedOut: false,
          crashSignatures: ["missing module (ERR_MODULE_NOT_FOUND)"]
        }
      }
    }
  }), { status: "partial" })

  assert.equal(report.runtimeEvidence.ran, false)
  assert.equal(report.runtimeEvidence.exitCode, 1)
  assert.deepEqual(report.runtimeEvidence.crashSignatures, ["missing module (ERR_MODULE_NOT_FOUND)"])
})

test("no smoke evidence means no runtime section, rather than a fabricated one", () => {
  // 没跑过就不该说跑过。not_applicable 的 smoke 不带 evidence。
  const report = buildBlockedReport(fakeLedger({
    gates: { smoke: { status: "not_applicable", reason: "no runnable entry point found" } }
  }))
  assert.equal(report.runtimeEvidence, null)
  assert.equal(report.gates.find((g) => g.gate === "smoke").status, "not_applicable")
})

test("both renderers surface the gates and runtime evidence", () => {
  const report = buildBlockedReport(fakeLedger({
    gates: {
      build: { status: "pass", reason: "build succeeded" },
      test: { status: "fail", reason: "3 tests failed", outputSnippet: "AssertionError" },
      smoke: PASSING_SMOKE
    }
  }), { status: "partial" })

  // 字段存在但渲染器不显示，等于没做 —— 这两条断言就是防这个
  const text = renderBlockedReportText(report).join("\n")
  assert.match(text, /门禁/)
  assert.match(text, /build/)
  assert.match(text, /运行时证据/)
  assert.match(text, /src\/index\.mjs --version/)
  assert.match(text, /AssertionError/, "失败门禁的输出要在终端可见")

  const markdown = renderBlockedReportMarkdown(report)
  assert.match(markdown, /## 门禁/)
  assert.match(markdown, /## 运行时证据/)
  assert.match(markdown, /exit 0/)
})

test("a report with no gates at all still renders", () => {
  // 门禁全禁用或早期轮次没有门禁数据时，报告的其余部分必须完整可用
  const report = buildBlockedReport(fakeLedger({ gates: {} }))
  assert.deepEqual(report.gates, [])
  assert.equal(report.runtimeEvidence, null)
  const text = renderBlockedReportText(report).join("\n")
  assert.match(text, /目标: 把工具层做到同行水平/)
  assert.doesNotMatch(text, /运行时证据/)
})
