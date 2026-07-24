import test from "node:test"
import assert from "node:assert/strict"
import {
  createActivityRenderer,
  formatToolDiffDetails
} from "../src/ui/activity-renderer.mjs"
import { createTranscriptModel } from "../src/ui/transcript-model.mjs"
import { EventBus } from "../src/core/events.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"

test("activity renderer updates one collapsed structured tool block", async () => {
  const transcript = createTranscriptModel()
  const renderer = createActivityRenderer({ output: transcript })
  renderer.start()

  try {
    await EventBus.emit({
      type: EVENT_TYPES.TOOL_START,
      sessionId: "session-1",
      turnId: "turn-1",
      payload: {
        tool: "edit",
        args: {
          path: "src/app.mjs",
          before: "const oldValue = true",
          after: "const newValue = true"
        }
      }
    })

    assert.equal(transcript.getItems().length, 1)
    assert.equal(transcript.getItems()[0].status, "running")

    await EventBus.emit({
      type: EVENT_TYPES.TOOL_FINISH,
      sessionId: "session-1",
      turnId: "turn-1",
      payload: {
        tool: "edit",
        status: "completed",
        durationMs: 42,
        output: "updated src/app.mjs"
      }
    })

    const [block] = transcript.getItems()
    assert.equal(block.status, "completed")
    assert.equal(block.expanded, false)
    assert.match(block.summary, /42ms/)
    assert.ok(block.details.some((line) => line.includes("- const oldValue = true")))
    assert.ok(block.details.some((line) => line.includes("+ const newValue = true")))
    assert.equal(transcript.render().length, 1)
  } finally {
    renderer.stop()
  }
})

test("activity renderer remains compatible with plain appendLog outputs", async () => {
  const logs = []
  const renderer = createActivityRenderer({
    output: { appendLog: (line) => logs.push(line) }
  })
  renderer.start()

  try {
    await EventBus.emit({
      type: EVENT_TYPES.TOOL_START,
      sessionId: "session-plain",
      turnId: "turn-plain",
      payload: {
        tool: "write",
        args: { path: "new.txt", content: "alpha\nbeta" }
      }
    })
    await EventBus.emit({
      type: EVENT_TYPES.TOOL_FINISH,
      sessionId: "session-plain",
      turnId: "turn-plain",
      payload: {
        tool: "write",
        status: "completed",
        durationMs: 5,
        output: "written"
      }
    })

    assert.ok(logs.every((line) => typeof line === "string"))
    assert.ok(logs.some((line) => line.includes("+ alpha")))
    assert.ok(logs.some((line) => line.includes("+ beta")))
  } finally {
    renderer.stop()
  }
})

test("mutation detail previews are bounded", () => {
  const lines = formatToolDiffDetails("write", {
    content: "one\ntwo\nthree\nfour"
  }, { maxLines: 2 })

  assert.equal(lines.length, 3)
  assert.match(lines.at(-1), /truncated/)
})

test("activity renderer can isolate background session events", async () => {
  const transcript = createTranscriptModel()
  const renderer = createActivityRenderer({
    output: transcript,
    eventFilter: (event) => event.sessionId === "foreground"
  })
  renderer.start()

  try {
    await EventBus.emit({
      type: EVENT_TYPES.TOOL_START,
      sessionId: "background",
      turnId: "turn-bg",
      payload: { tool: "bash", args: { command: "hidden" } }
    })
    await EventBus.emit({
      type: EVENT_TYPES.TOOL_START,
      sessionId: "foreground",
      turnId: "turn-fg",
      payload: { tool: "bash", args: { command: "visible" } }
    })
    assert.equal(transcript.getItems().length, 1)
    assert.match(transcript.getItems()[0].summary, /visible/)
  } finally {
    renderer.stop()
  }
})
