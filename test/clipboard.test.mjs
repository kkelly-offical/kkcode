import test from "node:test"
import assert from "node:assert/strict"
import {
  copyTerminalText,
  copyableFrameLine,
  osc52Sequence
} from "../src/repl/clipboard.mjs"

test("OSC 52 payload contains the selected UTF-8 text", () => {
  const sequence = osc52Sequence("你好 KK Code")
  const encoded = sequence.match(/\x1b\]52;c;([^\x07]+)/)?.[1]
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "你好 KK Code")
})

test("clipboard copy uses platform fallback while still emitting OSC 52", () => {
  let written = ""
  const calls = []
  const result = copyTerminalText("selected", {
    output: { write: (value) => { written += value } },
    platform: "darwin",
    env: {},
    spawn(command, args, options) {
      calls.push({ command, args, input: options.input })
      return { status: 0 }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.confirmed, true)
  assert.equal(result.requested, true)
  assert.equal(result.method, "pbcopy")
  assert.match(written, /^\x1b\]52;c;/)
  assert.deepEqual(calls, [{ command: "pbcopy", args: [], input: "selected" }])
})

test("OSC 52 is reported as requested rather than falsely confirmed", () => {
  const result = copyTerminalText("selected", {
    output: { write() {} },
    platform: "linux",
    env: {},
    spawn() {
      return { status: 1 }
    }
  })

  assert.deepEqual(result, {
    ok: false,
    confirmed: false,
    requested: true,
    method: "osc52"
  })
})

test("remote OSC 52 copy remains unconfirmed because terminals do not acknowledge it", () => {
  const result = copyTerminalText("selected", {
    output: { write() {} },
    platform: "linux",
    env: { SSH_CONNECTION: "client server" },
    spawn() {
      throw new Error("native fallback must not run over SSH")
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.confirmed, false)
  assert.equal(result.requested, true)
  assert.equal(result.method, "osc52")
})

test("copyable frame lines exclude padding and transcript scrollbars", () => {
  const lines = [
    "short                         ",
    "entry                    \x1b[2m ┃\x1b[0m"
  ]
  assert.equal(copyableFrameLine(lines, 0), "short")
  assert.equal(copyableFrameLine(lines, 1, {
    logStartRow: 2,
    logEndRow: 2,
    showScrollbar: true
  }), "entry")
})
