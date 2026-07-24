import test from "node:test"
import assert from "node:assert/strict"
import {
  createGhostPredictor,
  shouldPredict,
  normalizeGhost,
  ghostEnabled,
  GHOST_MAX_LENGTH
} from "../src/repl/ghost-predictor.mjs"
import { layoutInputText, inputIndexAtPosition } from "../src/repl/text-layout.mjs"

function createFakeTimers() {
  let now = 0
  const timers = []
  return {
    setTimer(fn, ms) {
      const timer = { at: now + ms, fn, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cancelled = true
    },
    advance(ms) {
      now += ms
      const due = timers.filter((t) => !t.cancelled && t.at <= now)
      for (const t of due) {
        t.cancelled = true
        t.fn()
      }
    }
  }
}

function configWithFast(fast = "gpt-tiny", ghost_text = "auto") {
  return {
    config: {
      provider: { default: "openai", openai: { default_model: "gpt-main" } },
      models: fast ? { fast } : {},
      ui: { composer: { ghost_text } }
    }
  }
}

test("prediction is skipped for slash commands, short input and trailing spaces", () => {
  assert.equal(shouldPredict("add a login page"), true)
  assert.equal(shouldPredict("/help"), false)
  assert.equal(shouldPredict("$skill"), false)
  assert.equal(shouldPredict("  /mode agent"), false)
  assert.equal(shouldPredict("ab"), false)
  assert.equal(shouldPredict("add a "), false)
  assert.equal(shouldPredict("add a login", { busy: true }), false)
  assert.equal(shouldPredict("add a login", { modal: true }), false)
  assert.equal(shouldPredict("add a login", { enabled: false }), false)
})

test("ghost text is disabled without a fast model or when explicitly off", () => {
  assert.equal(ghostEnabled(configWithFast("gpt-tiny")), true)
  assert.equal(ghostEnabled(configWithFast(null)), false)
  assert.equal(ghostEnabled(configWithFast("gpt-tiny", "off")), false)
})

test("normalizeGhost strips echoes, quotes and control sequences", () => {
  assert.equal(normalizeGhost("page with oauth", "add a login"), " page with oauth")
  // the model sometimes repeats what the user already typed
  assert.equal(normalizeGhost("add a login page", "add a login"), " page")
  assert.equal(normalizeGhost('"quoted"', "abc"), " quoted")
  assert.equal(normalizeGhost("first\nsecond", "abc"), " first")
  assert.equal(normalizeGhost("", "abc"), "")
  assert.equal(normalizeGhost("   ", "abc"), "")
  // an echo with nothing left over must not become a bare space
  assert.equal(normalizeGhost("abc", "abc"), "")
})

test("ghost text can never inject terminal escape sequences", () => {
  const ghost = normalizeGhost("safe[31mred[0m", "abc")
  assert.ok(!ghost.includes(""), `escape leaked: ${JSON.stringify(ghost)}`)
})

test("ghost text is length-capped", () => {
  assert.ok(normalizeGhost("x".repeat(200), "abc").length <= GHOST_MAX_LENGTH)
})

test("prediction is debounced and only the final input is requested", () => {
  const timers = createFakeTimers()
  const asked = []
  const predictor = createGhostPredictor({
    configState: configWithFast(),
    onGhost: () => {},
    debounceMs: 350,
    deps: {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      requestFast: async ({ prompt }) => { asked.push(prompt); return null }
    }
  })

  predictor.schedule("add a")
  timers.advance(100)
  predictor.schedule("add a log")
  timers.advance(100)
  predictor.schedule("add a login")
  timers.advance(350)

  assert.deepEqual(asked, ["add a login"], "only the settled input should be sent")
})

test("a stale response is discarded when the input moved on", async () => {
  const timers = createFakeTimers()
  const delivered = []
  let resolveRequest = null

  const predictor = createGhostPredictor({
    configState: configWithFast(),
    onGhost: (ghost) => delivered.push(ghost),
    debounceMs: 10,
    deps: {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      requestFast: () => new Promise((resolve) => { resolveRequest = resolve })
    }
  })

  predictor.schedule("add a login")
  timers.advance(10)
  // input changes while the request is still in flight
  predictor.schedule("add a logout")
  resolveRequest("page with oauth")
  await new Promise((r) => setImmediate(r))

  assert.deepEqual(delivered, [], "the reply belonged to an input that no longer exists")
})

test("scheduling returns false when the feature is off", () => {
  const timers = createFakeTimers()
  const predictor = createGhostPredictor({
    configState: configWithFast(null),
    onGhost: () => {},
    deps: { setTimer: timers.setTimer, clearTimer: timers.clearTimer, requestFast: async () => "x" }
  })
  assert.equal(predictor.schedule("add a login page"), false)
})

test("dispose cancels pending work and blocks further scheduling", () => {
  const timers = createFakeTimers()
  const asked = []
  const predictor = createGhostPredictor({
    configState: configWithFast(),
    onGhost: () => {},
    debounceMs: 10,
    deps: {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      requestFast: async ({ prompt }) => { asked.push(prompt); return null }
    }
  })

  predictor.schedule("add a login")
  predictor.dispose()
  timers.advance(50)
  assert.deepEqual(asked, [])
  assert.equal(predictor.schedule("another prompt"), false)
})

// --- rendering invariants -------------------------------------------------

test("ghost text does not affect cells, cursor or endIndex", () => {
  const base = layoutInputText({ value: "add a login", cursor: 11, width: 40, maxRows: 5 })
  const withGhost = layoutInputText({ value: "add a login", cursor: 11, width: 40, maxRows: 5, ghost: " page with oauth" })

  assert.deepEqual(withGhost.cursor, base.cursor)
  assert.equal(withGhost.normalizedCursor, base.normalizedCursor)
  assert.equal(withGhost.rows.length, base.rows.length)
  for (let i = 0; i < base.rows.length; i++) {
    assert.deepEqual(withGhost.rows[i].cells, base.rows[i].cells, `row ${i} cells changed`)
    assert.equal(withGhost.rows[i].endIndex, base.rows[i].endIndex, `row ${i} endIndex changed`)
  }
  assert.ok(withGhost.lines[0].includes("page with oauth"))
})

test("clicking into the ghost region maps to the end of the real input", () => {
  const layout = layoutInputText({ value: "hello", cursor: 5, width: 40, maxRows: 5, ghost: " world" })
  // column 8 sits inside the ghost, past the 5 real characters
  assert.equal(inputIndexAtPosition(layout, 0, 8), 5)
})

test("ghost text never adds a row, even when it overflows the width", () => {
  const base = layoutInputText({ value: "abcdefgh", cursor: 8, width: 10, maxRows: 5 })
  const withGhost = layoutInputText({ value: "abcdefgh", cursor: 8, width: 10, maxRows: 5, ghost: " a very long continuation" })
  assert.equal(withGhost.rows.length, base.rows.length)
  assert.deepEqual(withGhost.cursor, base.cursor)
})

test("ghost text is not rendered when the cursor is not at the end", () => {
  const layout = layoutInputText({ value: "hello", cursor: 2, width: 40, maxRows: 5, ghost: " world" })
  assert.ok(!layout.lines.join("").includes("world"))
})

test("CJK and emoji input keeps its cursor position with ghost text present", () => {
  const value = "修复登录🎉"
  const base = layoutInputText({ value, cursor: value.length, width: 40, maxRows: 5 })
  const withGhost = layoutInputText({ value, cursor: value.length, width: 40, maxRows: 5, ghost: " 页面" })
  assert.deepEqual(withGhost.cursor, base.cursor)
  assert.deepEqual(withGhost.rows[0].cells, base.rows[0].cells)
})
