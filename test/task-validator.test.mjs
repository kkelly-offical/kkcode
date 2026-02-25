import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { TaskValidator } from "../src/session/task-validator.mjs"

const validator = new TaskValidator({ cwd: process.cwd(), configState: {} })

describe("TaskValidator.checkTodoCompletion", () => {
  it("passes when no todo list", async () => {
    const r = await validator.checkTodoCompletion(null)
    assert.equal(r.passed, true)
  })

  it("passes when all completed", async () => {
    const r = await validator.checkTodoCompletion([
      { status: "completed", content: "task1" },
      { status: "completed", content: "task2" }
    ])
    assert.equal(r.passed, true)
  })

  it("fails with incomplete items", async () => {
    const r = await validator.checkTodoCompletion([
      { status: "completed", content: "done" },
      { status: "pending", content: "not done" }
    ])
    assert.equal(r.passed, false)
    assert.ok(r.message.includes("not done"))
  })

  it("handles non-array input", async () => {
    const r = await validator.checkTodoCompletion("invalid")
    assert.equal(r.passed, true)
  })
})
