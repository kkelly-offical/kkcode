import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executeTool } from "../src/kernel/tool/executor.mjs"
import { isToolSuccess, makeToolResult, toolStatusKind } from "../src/kernel/core/types.mjs"

async function run(raw, signal = null) {
  const auditDir = await mkdtemp(join(tmpdir(), "kkcode-result-contract-"))
  const previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = auditDir
  try {
    return await executeTool({
      tool: { name: "contract-test", execute: async () => raw },
      args: {},
      sessionId: "session-test",
      turnId: `turn-${Date.now()}-${Math.random()}`,
      context: { cwd: auditDir, config: {} },
      signal
    })
  } finally {
    if (previousHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousHome
    await rm(auditDir, { recursive: true, force: true })
  }
}

test("makeToolResult exposes a backward-compatible success contract", () => {
  const result = makeToolResult({ name: "read", status: "completed", output: "ok" })
  assert.equal(result.ok, true)
  assert.equal(result.code, null)
  assert.deepEqual(result.evidence, {})
  assert.equal(isToolSuccess(result), true)
  assert.equal(toolStatusKind(result), "completed")

  assert.equal(isToolSuccess({ status: "completed" }), true)
  assert.equal(isToolSuccess({ status: "completed", ok: false }), false)
  assert.equal(toolStatusKind({ status: "completed", ok: false }), "error")
  assert.equal(makeToolResult({ name: "bad", status: "completed", ok: false }).status, "error")
})

test("executeTool does not report raw ok=false as completed", async () => {
  const result = await run({
    ok: false,
    error: "execution_policy_violation",
    message: "command denied"
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, "error")
  assert.equal(result.code, "execution_policy_violation")
  assert.equal(result.output, "command denied")
})

test("executeTool preserves blocked and cancelled terminal states", async () => {
  const blocked = await run({
    output: "write was not executed",
    metadata: { blocked: true, reason: "stale_read" }
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, "blocked")

  const cancelled = await run({ cancelled: true, output: "stopped" })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.status, "cancelled")
})

test("executeTool recognizes legacy string failures", async () => {
  const error = await run("error: invalid input")
  assert.equal(error.status, "error")
  assert.equal(error.ok, false)

  const blocked = await run("[blocked] long-running command")
  assert.equal(blocked.status, "blocked")
  assert.equal(blocked.ok, false)
})

test("an already-aborted signal cancels before tool execution", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await run("must not run", controller.signal)
  assert.equal(result.status, "cancelled")
  assert.equal(result.ok, false)
})

test('structured process failure flags cannot be overridden by a claimed successful status', async () => {
  for (const fields of [{ exitCode: 8 }, { timedOut: true }, { captureIncomplete: true }, { terminationIncomplete: true }]) {
    for (const raw of [{ ...fields }, { metadata: fields }]) {
      const result = await run({ ...raw, ok: true, status: 'completed', output: 'partial' })
      assert.equal(result.ok, false)
      assert.equal(result.status, 'error')
    }
  }
  const cancelled = await run({ ok: true, status: 'completed', output: 'partial', metadata: { cancelled: true } })
  assert.equal(cancelled.status, 'cancelled')
})

test('incomplete and unknown child results remain non-success while launch acknowledgments keep child receipts', async () => {
  const incomplete = await run({ status: 'incomplete', session_id: 'child', stop_reason: 'budget', reply: 'partial' })
  assert.equal(incomplete.ok, false)
  assert.equal(incomplete.status, 'blocked')
  assert.deepEqual(incomplete.metadata.childOutcome, { status: 'incomplete', sessionId: 'child', stopReason: 'budget' })
  const unknown = await run({ status: 'unknown', session_id: 'child', reply: 'inspect prior effects' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.metadata.outcomeUnknown, true)
  assert.equal(unknown.code, 'tool_outcome_unknown')
  assert.equal((await run({ status: 'partial_error', tasks: [{ error: 'not launched' }] })).ok, false)
  for (const status of ['pending', 'running']) {
    const launched = await run({ status, session_id: 'child', background_task_id: 'bg-child' })
    assert.equal(launched.ok, true, 'acknowledging submission does not complete the child')
    assert.deepEqual(launched.metadata.childOutcome, { status, sessionId: 'child', backgroundTaskId: 'bg-child' })
  }
})
