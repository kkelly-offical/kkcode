import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createRenderStream, registerStreamByteRenderer } from "../src/kernel/session/render-stream.mjs"
import { setColorEnabled } from "../src/theme/color.mjs"
import { createStreamByteRenderer } from "../src/theme/stream-byte-renderer.mjs"

beforeEach(() => {
  setColorEnabled(false)
  registerStreamByteRenderer(createStreamByteRenderer)
})

afterEach(() => {
  registerStreamByteRenderer(null)
  setColorEnabled(null)
})

function captureWrites(renderMarkdown = false) {
  const writes = []
  const render = createRenderStream({
    output: { write: chunk => writes.push(chunk) },
    renderMarkdown,
    eventBus: { emit: async event => event },
    sessionId: "ses_semantic_chunks",
    turnId: "turn_semantic_chunks"
  })
  return { render, writes }
}

test("render stream preserves semantic tags and exact bytes for text and control chunks", async () => {
  const { render, writes } = captureWrites()
  render.beginStep()
  await render.thinkingDelta(1, "考虑\n")
  await render.textDelta(1, "答案")
  await render.providerCompaction(1)
  await render.autoContinue(1, { continueCount: 1, maxContinues: 8 })
  await render.validationSkipped(1, "skip")
  await render.streamEnd(1)

  assert.deepEqual(writes.map(chunk => [Buffer.isBuffer(chunk), chunk.semanticKind, String(chunk)]), [
    [true, "thinking", "● Thinking ∨\n"],
    [true, "thinking", "  考虑\n"],
    [true, "thinking", "\n"],
    [false, undefined, "答案"],
    [true, "notice", "\n  ↻ context compacted by provider\n"],
    [true, "notice", "\n  ↳ output truncated, auto-continuing (1/8)...\n"],
    [true, "notice", "\n  ⚠ Task validation skipped: skip\n"],
    [true, "separator", "\n"]
  ])
  assert.equal(writes.map(chunk => String(chunk)).join(""),
    "● Thinking ∨\n  考虑\n\n答案\n  ↻ context compacted by provider\n\n" +
    "  ↳ output truncated, auto-continuing (1/8)...\n\n" +
    "  ⚠ Task validation skipped: skip\n\n")
})

test("stream end keeps flushed markdown text distinct from the final separator", async () => {
  const { render, writes } = captureWrites(true)
  render.beginStep()
  await render.textDelta(1, "正文")
  await render.streamEnd(1)

  assert.deepEqual(writes.map(chunk => [Buffer.isBuffer(chunk), chunk.semanticKind, String(chunk)]), [
    [true, "text", "正文"],
    [true, "separator", "\n"]
  ])
  assert.equal(writes.map(chunk => String(chunk)).join(""), "正文\n")
})

test("stream end without text keeps its control chunk tagged as thinking", async () => {
  const { render, writes } = captureWrites()
  render.beginStep()
  await render.thinkingDelta(1, "思考")
  await render.streamEnd(1)

  assert.deepEqual(writes.map(chunk => [Buffer.isBuffer(chunk), chunk.semanticKind, String(chunk)]), [
    [true, "thinking", "● Thinking ∨\n"],
    [true, "thinking", "  思考"],
    [true, "thinking", "\n"]
  ])
  assert.equal(writes.map(chunk => String(chunk)).join(""), "● Thinking ∨\n  思考\n")
})
