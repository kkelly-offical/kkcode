import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectRollbackIntent } from "../src/kernel/session/rollback.mjs"

describe("detectRollbackIntent", () => {
  it("detects Chinese rollback keywords", () => {
    const cases = ["撤销上次修改", "回退代码", "回滚到之前", "还原文件", "撤回刚才的操作"]
    for (const text of cases) {
      const result = detectRollbackIntent(text)
      assert.ok(result.isRollback, `should detect: "${text}"`)
      assert.ok(result.confidence >= 0.7)
    }
  })

  it("detects English rollback keywords", () => {
    const cases = ["undo", "rollback the changes", "revert last edit", "undo last change"]
    for (const text of cases) {
      const result = detectRollbackIntent(text)
      assert.ok(result.isRollback, `should detect: "${text}"`)
      assert.ok(result.confidence >= 0.8)
    }
  })

  it("detects medium-confidence patterns", () => {
    const cases = ["恢复到之前的版本", "回到之前的状态", "restore previous state", "go back to before"]
    for (const text of cases) {
      const result = detectRollbackIntent(text)
      assert.ok(result.isRollback, `should detect: "${text}"`)
      assert.ok(result.confidence >= 0.7)
    }
  })

  it("does not trigger on normal messages", () => {
    const cases = [
      "请帮我写一个函数",
      "fix the bug in login.js",
      "add a new feature",
      "explain this code",
      "run the tests"
    ]
    for (const text of cases) {
      const result = detectRollbackIntent(text)
      assert.ok(!result.isRollback, `should NOT detect: "${text}"`)
    }
  })

  it("does not turn rollback discussions or questions into file operations", () => {
    const cases = [
      "How does git rollback work?",
      "what is the difference between rollback and revert",
      "explain rollback implementation",
      "rollback semantics",
      "如何回滚到上一版？",
      "解释 rollback 的实现",
      "回滚的原理",
      "undo?"
    ]
    for (const text of cases) {
      const result = detectRollbackIntent(text)
      assert.equal(result.isRollback, false, `discussion must reach the model: "${text}"`)
    }
  })

  it("still detects explicit polite rollback commands without a question form", () => {
    const cases = ["please undo last change", "could you revert the edit", "麻烦你帮我撤销刚才修改"]
    for (const text of cases) {
      assert.equal(detectRollbackIntent(text).isRollback, true, `explicit command should be detected: "${text}"`)
    }
  })

  it("ignores long messages (>200 chars)", () => {
    const longText = "undo ".repeat(50)
    const result = detectRollbackIntent(longText)
    assert.ok(!result.isRollback)
  })

  it("handles null/undefined/empty input", () => {
    assert.ok(!detectRollbackIntent(null).isRollback)
    assert.ok(!detectRollbackIntent(undefined).isRollback)
    assert.ok(!detectRollbackIntent("").isRollback)
    assert.ok(!detectRollbackIntent(123).isRollback)
  })

  it("returns matched pattern", () => {
    const result = detectRollbackIntent("请撤销刚才的修改")
    assert.ok(result.isRollback)
    assert.ok(result.matchedPattern.length > 0)
  })
})
