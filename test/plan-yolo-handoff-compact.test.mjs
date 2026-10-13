import test from "node:test"
import assert from "node:assert/strict"
import { continuePlanBuildHandoff } from "../src/repl/commands/session.mjs"

function harness({ onCompact } = {}) {
  const events = []
  const state = {
    modeId: "agent",
    sessionId: "ses_plan_handoff",
    model: "test-model",
    providerType: "test"
  }
  const ctx = {
    configState: { config: {} },
    kernel: {
      sessions: {
        compactSession: async (options) => {
          events.push("compact")
          return onCompact(options)
        }
      }
    }
  }
  const controller = new AbortController()
  return {
    events,
    state,
    ctx,
    controller,
    handoff: { modeId: "agent", compactFirst: true, planPath: "/tmp/plan.md" },
    print: () => {},
    submit: async (prompt) => { events.push({ submit: prompt }) }
  }
}

test("Compact + Build waits for the existing compaction before continuing", async () => {
  let finishCompact
  let receivedSignal = null
  const gate = new Promise((resolve) => { finishCompact = resolve })
  const fixture = harness({
    onCompact: async (options) => {
      receivedSignal = options.signal
      await gate
      return { compacted: true, summarizedCount: 6, keptCount: 2 }
    }
  })

  const pending = continuePlanBuildHandoff({
    handoff: fixture.handoff,
    state: fixture.state,
    ctx: fixture.ctx,
    signal: fixture.controller.signal,
    print: fixture.print,
    submit: fixture.submit
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fixture.events, ["compact"], "build must not start while compaction is pending")

  finishCompact()
  assert.equal(await pending, true)
  assert.equal(receivedSignal, fixture.controller.signal)
  assert.equal(fixture.events[0], "compact")
  assert.deepEqual(fixture.events[1], {
    submit: "Implement the approved plan at /tmp/plan.md. Follow it stage by stage and report what you changed."
  })
})

test("Compact + Build does not run a stale handoff after cancellation", async () => {
  const fixture = harness({
    onCompact: async () => {
      fixture.controller.abort()
      throw Object.assign(new Error("cancelled"), { name: "AbortError" })
    }
  })

  const continued = await continuePlanBuildHandoff({
    handoff: fixture.handoff,
    state: fixture.state,
    ctx: fixture.ctx,
    signal: fixture.controller.signal,
    print: fixture.print,
    submit: fixture.submit
  })

  assert.equal(continued, false)
  assert.deepEqual(fixture.events, ["compact"])
})

test("Compact + Build does not continue after the mode changes during compaction", async () => {
  const fixture = harness({
    onCompact: async () => {
      fixture.state.modeId = "plan"
      return { compacted: true, summarizedCount: 6, keptCount: 2 }
    }
  })

  const continued = await continuePlanBuildHandoff({
    handoff: fixture.handoff,
    state: fixture.state,
    ctx: fixture.ctx,
    signal: fixture.controller.signal,
    print: fixture.print,
    submit: fixture.submit
  })

  assert.equal(continued, false)
  assert.deepEqual(fixture.events, ["compact"])
})

test("Compact + Build does not continue in a different session", async () => {
  const fixture = harness({
    onCompact: async () => {
      fixture.state.sessionId = "ses_new"
      return { compacted: true, summarizedCount: 6, keptCount: 2 }
    }
  })

  const continued = await continuePlanBuildHandoff({
    handoff: fixture.handoff,
    state: fixture.state,
    ctx: fixture.ctx,
    signal: fixture.controller.signal,
    print: fixture.print,
    submit: fixture.submit
  })

  assert.equal(continued, false)
  assert.deepEqual(fixture.events, ["compact"])
})

test("ordinary Build continues without adding a compaction step", async () => {
  const fixture = harness({
    onCompact: async () => { throw new Error("must not compact") }
  })
  fixture.handoff.compactFirst = false

  const continued = await continuePlanBuildHandoff({
    handoff: fixture.handoff,
    state: fixture.state,
    ctx: fixture.ctx,
    signal: fixture.controller.signal,
    print: fixture.print,
    submit: fixture.submit
  })

  assert.equal(continued, true)
  assert.equal(fixture.events.length, 1)
  assert.match(fixture.events[0].submit, /Implement the approved plan at \/tmp\/plan.md/)
})
