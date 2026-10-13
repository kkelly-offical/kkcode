import test from "node:test"
import assert from "node:assert/strict"
import { continuePlanBuildHandoff } from "../src/repl/commands/session.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"
import { createKeyDispatcher } from "../src/repl/key-dispatch.mjs"
import { createLifecycleKeyScope, createScrollKeyScope } from "../src/repl/keys/global-keys.mjs"
import { resetTurnRuntime } from "../src/ui/turn-runtime.mjs"
import { shouldSubmitInput } from "../src/repl/input-engine.mjs"

function keyScope(kind, state) {
  if (kind === "escape") {
    return createScrollKeyScope({
      requestRender: () => {},
      scrollBy: () => {},
      scrollToTop: () => {},
      scrollToBottom: () => {},
      pageSize: (rows) => rows,
      appendLog: () => {},
      state
    })
  }
  return createLifecycleKeyScope({
    requestRender: () => {},
    appendLog: () => {},
    showToast: () => {},
    finishSelection: () => {},
    copyToClipboard: async () => {},
    suspendForJobControl: () => {},
    requestExit: () => {},
    state
  })
}

async function cancelCompactionWithKey(kind) {
  let finishCompact
  const gate = new Promise((resolve) => { finishCompact = resolve })
  const events = []
  const state = {
    modeId: "agent",
    sessionId: "ses_ui_cancel",
    model: "test-model",
    providerType: "test"
  }
  const ctx = {
    configState: { config: {} },
    kernel: {
      sessions: {
        compactSession: async () => {
          events.push("compact")
          await gate
          return { compacted: true, summarizedCount: 6, keptCount: 2 }
        }
      }
    }
  }
  const ui = createReplUiState()
  // This is the exact order used by submitCurrentInput's finally block.
  resetTurnRuntime(ui)
  const dispatchKey = createKeyDispatcher({ scopes: [keyScope(kind, state)] }).dispatchKey

  const pending = continuePlanBuildHandoff({
    handoff: { modeId: "agent", compactFirst: true, planPath: "/tmp/plan.md" },
    state,
    ctx,
    ui,
    signal: new AbortController().signal,
    print: () => {},
    submit: async () => { events.push("submit") },
    startBusySpinner: () => {},
    stopBusySpinner: () => {},
    requestRender: () => {}
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(ui.busy, true, "compaction must remain an active, cancellable turn")
  const controller = ui.turnAbortController
  assert.ok(controller, "the active compaction must register its controller with the UI")

  const outcome = await dispatchKey({
    ui,
    key: kind === "escape" ? { name: "escape" } : { name: "c", ctrl: true },
    str: ""
  })
  assert.equal(outcome.handled, true)
  assert.equal(controller.signal.aborted, true, `${kind} must abort the registered compaction`)

  finishCompact()
  assert.equal(await pending, false)
  assert.deepEqual(events, ["compact"], "a cancelled compaction must not submit the stale Build")
  assert.equal(ui.busy, false)
}

test("Esc cancels an in-flight Compact + Build through the real TUI key dispatcher", async () => {
  await cancelCompactionWithKey("escape")
})

test("Ctrl+C cancels an in-flight Compact + Build through the real TUI key dispatcher", async () => {
  await cancelCompactionWithKey("ctrl-c")
})

test("successful Compact + Build passes the real submit guard exactly once", async () => {
  const events = []
  const state = {
    modeId: "agent",
    sessionId: "ses_ui_success",
    model: "test-model",
    providerType: "test"
  }
  const ctx = {
    configState: { config: {} },
    kernel: {
      sessions: {
        compactSession: async () => {
          events.push("compact")
          return { compacted: true, summarizedCount: 6, keptCount: 2 }
        }
      }
    }
  }
  const ui = createReplUiState()
  resetTurnRuntime(ui)
  let submissions = 0
  let busyAtSubmit = null
  let controllerAtSubmit = null

  const continued = await continuePlanBuildHandoff({
    handoff: { modeId: "agent", compactFirst: true, planPath: "/tmp/plan.md" },
    state,
    ctx,
    ui,
    signal: new AbortController().signal,
    print: () => {},
    submit: async (prompt) => {
      busyAtSubmit = ui.busy
      controllerAtSubmit = ui.turnAbortController
      if (!shouldSubmitInput(prompt, ui.busy)) {
        events.push("swallowed")
        return
      }
      submissions += 1
      events.push(prompt)
    },
    startBusySpinner: () => {},
    stopBusySpinner: () => {},
    requestRender: () => {}
  })

  assert.equal(continued, true)
  assert.equal(submissions, 1)
  assert.equal(busyAtSubmit, false)
  assert.equal(controllerAtSubmit, null)
  assert.deepEqual(events, [
    "compact",
    "Implement the approved plan at /tmp/plan.md. Follow it stage by stage and report what you changed."
  ])
})
