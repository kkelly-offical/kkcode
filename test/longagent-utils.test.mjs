import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  stripFence, parseJsonLoose, classifyError, ERROR_CATEGORIES,
  isComplete, isLikelyActionableObjective, summarizeGateFailures,
  stageProgressStats, normalizeFileChange, isReadOnlyTool,
  detectExplorationLoop, detectToolCycle, createStuckTracker,
  mergeCappedFileChanges, createSemanticErrorTracker, createDegradationChain,
  generateRecoverySuggestions
} from "../src/session/longagent-utils.mjs"

describe("stripFence", () => {
  it("removes json code fence", () => {
    assert.equal(stripFence("```json\n{\"a\":1}\n```"), '{"a":1}')
  })
  it("removes plain code fence", () => {
    assert.equal(stripFence("```\nhello\n```"), "hello")
  })
  it("returns trimmed text when no fence", () => {
    assert.equal(stripFence("  hello  "), "hello")
  })
  it("handles null/undefined", () => {
    assert.equal(stripFence(null), "")
    assert.equal(stripFence(undefined), "")
  })
})

describe("parseJsonLoose", () => {
  it("parses valid JSON", () => {
    assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
  })
  it("parses JSON inside code fence", () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })
  })
  it("extracts JSON from surrounding text", () => {
    assert.deepEqual(parseJsonLoose('Here is the result: {"x":2} done'), { x: 2 })
  })
  it("returns null for invalid input", () => {
    assert.equal(parseJsonLoose("not json at all"), null)
  })
})

describe("classifyError", () => {
  it("classifies timeout as transient", () => {
    assert.equal(classifyError("request timeout after 30s"), ERROR_CATEGORIES.TRANSIENT)
  })
  it("classifies rate limit as transient", () => {
    assert.equal(classifyError("rate limit exceeded 429"), ERROR_CATEGORIES.TRANSIENT)
  })
  it("classifies ECONNRESET as transient", () => {
    assert.equal(classifyError("ECONNRESET"), ERROR_CATEGORIES.TRANSIENT)
  })
  it("classifies interrupted status as transient", () => {
    assert.equal(classifyError("some error", "interrupted"), ERROR_CATEGORIES.TRANSIENT)
  })
  it("classifies ENOENT as permanent", () => {
    assert.equal(classifyError("ENOENT: no such file"), ERROR_CATEGORIES.PERMANENT)
  })
  it("classifies permission denied as permanent", () => {
    assert.equal(classifyError("EACCES: permission denied"), ERROR_CATEGORIES.PERMANENT)
  })
  it("classifies cancelled as permanent", () => {
    assert.equal(classifyError("task stopped", "cancelled"), ERROR_CATEGORIES.PERMANENT)
  })
  it("classifies TypeError as logic", () => {
    assert.equal(classifyError("TypeError: x is not a function"), ERROR_CATEGORIES.LOGIC)
  })
  it("classifies SyntaxError as logic", () => {
    assert.equal(classifyError("SyntaxError: unexpected token"), ERROR_CATEGORIES.LOGIC)
  })
  it("classifies unknown errors as unknown", () => {
    assert.equal(classifyError("something weird happened"), ERROR_CATEGORIES.UNKNOWN)
  })
  it("handles null/empty input", () => {
    assert.equal(classifyError(null), ERROR_CATEGORIES.UNKNOWN)
    assert.equal(classifyError(""), ERROR_CATEGORIES.UNKNOWN)
  })
})

describe("isComplete", () => {
  it("detects [TASK_COMPLETE] marker", () => {
    assert.equal(isComplete("Done. [TASK_COMPLETE]"), true)
  })
  it("detects task complete phrase", () => {
    assert.equal(isComplete("The task complete now"), true)
  })
  it("returns false for unrelated text", () => {
    assert.equal(isComplete("still working on it"), false)
  })
  it("handles null", () => {
    assert.equal(isComplete(null), false)
  })
})

describe("isLikelyActionableObjective", () => {
  it("detects coding keywords", () => {
    assert.equal(isLikelyActionableObjective("fix the login bug"), true)
    assert.equal(isLikelyActionableObjective("实现用户认证功能"), true)
  })
  it("rejects greetings", () => {
    assert.equal(isLikelyActionableObjective("hello"), false)
    assert.equal(isLikelyActionableObjective("你好"), false)
  })
  it("rejects short non-coding text", () => {
    assert.equal(isLikelyActionableObjective("ok"), false)
  })
  it("handles empty input", () => {
    assert.equal(isLikelyActionableObjective(""), false)
    assert.equal(isLikelyActionableObjective(null), false)
  })
})

describe("summarizeGateFailures", () => {
  it("formats gate failures", () => {
    const result = summarizeGateFailures([
      { gate: "build", reason: "exit code 1" },
      { gate: "test", reason: "3 failures" }
    ])
    assert.ok(result.includes("build:exit code 1"))
    assert.ok(result.includes("test:3 failures"))
  })
  it("returns empty for no failures", () => {
    assert.equal(summarizeGateFailures([]), "")
  })
  it("limits to 5 entries", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ gate: `g${i}`, reason: "fail" }))
    const parts = summarizeGateFailures(many).split(";")
    assert.equal(parts.length, 5)
  })
})

describe("stageProgressStats", () => {
  it("counts completed tasks", () => {
    const stats = stageProgressStats({
      t1: { status: "completed", remainingFiles: [] },
      t2: { status: "error", remainingFiles: ["a.js"] },
      t3: { status: "completed", remainingFiles: [] }
    })
    assert.equal(stats.done, 2)
    assert.equal(stats.total, 3)
    assert.deepEqual(stats.remainingFiles, ["a.js"])
  })
  it("handles null input", () => {
    const stats = stageProgressStats(null)
    assert.equal(stats.done, 0)
    assert.equal(stats.total, 0)
  })
})

describe("normalizeFileChange", () => {
  it("normalizes valid entry", () => {
    const result = normalizeFileChange({ path: " src/a.js ", addedLines: 5, removedLines: "2", stageId: "s1" })
    assert.equal(result.path, "src/a.js")
    assert.equal(result.addedLines, 5)
    assert.equal(result.removedLines, 2)
    assert.equal(result.stageId, "s1")
  })
  it("returns null for empty path", () => {
    assert.equal(normalizeFileChange({ path: "" }), null)
    assert.equal(normalizeFileChange({}), null)
  })
  it("clamps negative numbers to 0", () => {
    const result = normalizeFileChange({ path: "a.js", addedLines: -3 })
    assert.equal(result.addedLines, 0)
  })
})

describe("detectExplorationLoop", () => {
  it("detects config file glob loop", () => {
    const calls = Array.from({ length: 7 }, () =>
      `glob:${JSON.stringify({ pattern: "pyproject.toml" })}`
    )
    // Need at least 4 config patterns matched out of 6+ globs
    const mixed = [
      `glob:${JSON.stringify({ pattern: "pyproject.toml" })}`,
      `glob:${JSON.stringify({ pattern: "setup.py" })}`,
      `glob:${JSON.stringify({ pattern: "Pipfile" })}`,
      `glob:${JSON.stringify({ pattern: "Dockerfile" })}`,
      `glob:${JSON.stringify({ pattern: ".env" })}`,
      `glob:${JSON.stringify({ pattern: "main.py" })}`
    ]
    assert.equal(detectExplorationLoop(mixed).isLoop, true)
  })
  it("returns false for normal calls", () => {
    const calls = ["glob:{}", "read:{}", "grep:{}"]
    assert.equal(detectExplorationLoop(calls).isLoop, false)
  })
})

describe("detectToolCycle", () => {
  it("detects 6 consecutive same read-only tools", () => {
    const calls = Array(6).fill("glob:{}")
    assert.equal(detectToolCycle(calls), true)
  })
  it("detects mirrored halves", () => {
    const calls = ["read:a", "glob:b", "grep:c", "read:a", "glob:b", "grep:c"]
    assert.equal(detectToolCycle(calls), true)
  })
  it("returns false for short sequences", () => {
    assert.equal(detectToolCycle(["read:a", "glob:b"]), false)
  })
})

describe("createStuckTracker", () => {
  it("detects excessive read-only exploration", () => {
    const tracker = createStuckTracker()
    for (let i = 0; i < 3; i++) {
      tracker.track([{ name: "read", args: {} }])
    }
    const result = tracker.track([{ name: "glob", args: {} }])
    assert.equal(result.isStuck, true)
    assert.equal(result.reason, "excessive_read_only_exploration")
  })
  it("resets read-only count on write", () => {
    const tracker = createStuckTracker()
    tracker.track([{ name: "read", args: {} }])
    tracker.track([{ name: "read", args: {} }])
    tracker.track([{ name: "write", args: { path: "a.js" } }])
    const result = tracker.track([{ name: "read", args: {} }])
    assert.equal(result.isStuck, false)
  })
  it("detects write loop on same file", () => {
    const tracker = createStuckTracker()
    for (let i = 0; i < 3; i++) {
      tracker.track([{ name: "edit", args: { path: "a.js", old_string: "x" } }])
    }
    // The write loop detection triggers after 3 edits to same file
    assert.deepEqual(tracker.writeOps.length, 3)
  })
})

describe("mergeCappedFileChanges", () => {
  it("merges and deduplicates by path+stage+task", () => {
    const a = [{ path: "a.js", addedLines: 5, removedLines: 0, stageId: "s1", taskId: "t1" }]
    const b = [{ path: "a.js", addedLines: 3, removedLines: 1, stageId: "s1", taskId: "t1" }]
    const result = mergeCappedFileChanges(a, b)
    assert.equal(result.length, 1)
    assert.equal(result[0].addedLines, 8)
    assert.equal(result[0].removedLines, 1)
  })
  it("respects limit", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.js`, addedLines: 1, removedLines: 0, stageId: "", taskId: ""
    }))
    const result = mergeCappedFileChanges([], items, 5)
    assert.equal(result.length, 5)
  })
  it("handles empty inputs", () => {
    assert.deepEqual(mergeCappedFileChanges([], []), [])
  })
})

describe("createSemanticErrorTracker", () => {
  it("detects repeated same error", () => {
    const tracker = createSemanticErrorTracker(3)
    tracker.track("TypeError: x is not a function")
    tracker.track("TypeError: x is not a function")
    const result = tracker.track("TypeError: x is not a function")
    assert.equal(result.isRepeated, true)
    assert.equal(result.count, 3)
  })
  it("does not trigger for different errors", () => {
    const tracker = createSemanticErrorTracker(3)
    tracker.track("TypeError: x is not a function")
    tracker.track("ReferenceError: y is not defined")
    const result = tracker.track("TypeError: x is not a function")
    assert.equal(result.isRepeated, false)
  })
  it("handles text without errors", () => {
    const tracker = createSemanticErrorTracker(2)
    const result = tracker.track("all good, no errors here")
    assert.equal(result.isRepeated, false)
    assert.equal(result.error, null)
  })
  it("reset clears history", () => {
    const tracker = createSemanticErrorTracker(2)
    tracker.track("TypeError: x is not a function")
    tracker.reset()
    assert.equal(tracker.history.length, 0)
  })
})

describe("createDegradationChain", () => {
  it("applies strategies in order", () => {
    const chain = createDegradationChain({ fallback_model: "small-model", skip_non_critical: true })
    const ctx = { model: "big-model", taskProgress: { t1: { status: "error" } }, configState: { config: { agent: { longagent: { parallel: { max_concurrency: 4 } } } } } }

    const r1 = chain.apply(ctx)
    assert.equal(r1.strategy, "switch_model")
    assert.equal(ctx.model, "small-model")

    const r2 = chain.apply(ctx)
    assert.equal(r2.strategy, "reduce_scope")

    const r3 = chain.apply(ctx)
    assert.equal(r3.strategy, "serial_mode")
    assert.equal(ctx.configState.config.agent.longagent.parallel.max_concurrency, 1)

    const r4 = chain.apply(ctx)
    assert.equal(r4.strategy, "graceful_stop")
    assert.equal(ctx.shouldStop, true)

    assert.equal(chain.canDegrade(), false)
  })
  it("skips switch_model when already on fallback", () => {
    const chain = createDegradationChain({ fallback_model: "same" })
    const ctx = { model: "same" }
    const r = chain.apply(ctx)
    assert.equal(r.applied, false)
  })
})

describe("generateRecoverySuggestions", () => {
  it("generates suggestions for failed tasks", () => {
    const result = generateRecoverySuggestions({
      status: "error",
      taskProgress: {
        t1: { status: "completed" },
        t2: { status: "error", lastError: "ENOENT: no such file" }
      },
      phase: "H4_coding"
    })
    assert.equal(result.completedTasks.length, 1)
    assert.equal(result.failedTasks.length, 1)
    assert.equal(result.failedTasks[0].category, "permanent")
    assert.ok(result.suggestions.length > 0)
    assert.ok(result.resumeHint.includes("从 checkpoint 恢复"))
  })
  it("handles empty input", () => {
    const result = generateRecoverySuggestions({})
    assert.equal(result.completedTasks.length, 0)
    assert.equal(result.failedTasks.length, 0)
  })
})
