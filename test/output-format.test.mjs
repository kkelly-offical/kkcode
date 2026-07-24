import test from "node:test"
import assert from "node:assert/strict"
import { createOutputReporter, resolveOutputFormat, toPublicResult } from "../src/cli/output-format.mjs"

function sink() {
  let value = ""
  return { write(chunk) { value += chunk }, read() { return value } }
}

test("non-TTY defaults to stable text while TTY keeps legacy display", () => {
  assert.equal(resolveOutputFormat(null, { stdoutIsTTY: false }), "text")
  assert.equal(resolveOutputFormat(null, { stdoutIsTTY: true }), "legacy")
  assert.throws(() => resolveOutputFormat("xml"), /invalid output format/)
})

test("text output keeps progress off stdout", () => {
  const stdout = sink()
  const stderr = sink()
  const reporter = createOutputReporter("text", { stdout, stderr })
  reporter.progress("thinking")
  reporter.finish({ reply: "done", sessionId: "s", turnId: "t" })
  assert.equal(stdout.read(), "done\n")
  assert.equal(stderr.read(), "thinking\n")
})

test("public JSON result has a versioned stable shape", () => {
  assert.deepEqual(toPublicResult({
    reply: "ok",
    sessionId: "s",
    turnId: "t",
    mode: "agent",
    model: "k3",
    tokenMeter: { turn: { input: 2, output: 3 }, estimated: false }
  }), {
    schemaVersion: "1",
    sessionId: "s",
    turnId: "t",
    status: "succeeded",
    mode: "agent",
    model: "k3",
    content: "ok",
    usage: { input: 2, output: 3, estimated: false },
    cost: 0,
    toolResults: [],
    warnings: [],
    error: null
  })
})
