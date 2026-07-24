import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import {
  copyTerminalText,
  copyableFrameLine,
  osc52Sequence
} from "../src/repl/clipboard.mjs"

function clipboardChild({ code = 0, signal = null, onInput } = {}) {
  const child = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.end = (input) => {
    onInput?.(input)
    queueMicrotask(() => child.emit("close", code, signal))
  }
  child.kill = () => {}
  return child
}

test("OSC 52 payload contains the selected UTF-8 text", () => {
  const sequence = osc52Sequence("你好 KK Code")
  const encoded = sequence.match(/\x1b\]52;c;([^\x07]+)/)?.[1]
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "你好 KK Code")
})

test("clipboard copy uses an async platform fallback while immediately emitting OSC 52", async () => {
  let written = ""
  const calls = []
  let releaseClipboard
  const clipboardReleased = new Promise((resolve) => {
    releaseClipboard = resolve
  })
  const resultPromise = copyTerminalText("selected", {
    output: { write: (value) => { written += value } },
    platform: "darwin",
    env: {},
    spawn(command, args) {
      const child = new EventEmitter()
      child.stdin = new EventEmitter()
      child.stdin.end = (input) => {
        calls.push({ command, args, input })
        clipboardReleased.then(() => child.emit("close", 0, null))
      }
      child.kill = () => {}
      return child
    }
  })
  assert.match(written, /^\x1b\]52;c;/)
  releaseClipboard()
  const result = await resultPromise
  assert.equal(result.ok, true)
  assert.equal(result.confirmed, true)
  assert.equal(result.requested, true)
  assert.equal(result.method, "pbcopy")
  assert.deepEqual(calls, [{ command: "pbcopy", args: [], input: "selected" }])
})

test("OSC 52 is reported as requested rather than falsely confirmed", async () => {
  const result = await copyTerminalText("selected", {
    output: { write() {} },
    platform: "linux",
    env: {},
    spawn() {
      return clipboardChild({ code: 1 })
    }
  })

  assert.deepEqual(result, {
    ok: false,
    confirmed: false,
    requested: true,
    method: "osc52"
  })
})

test("remote OSC 52 copy remains unconfirmed because terminals do not acknowledge it", async () => {
  const result = await copyTerminalText("selected", {
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

test("Windows clipboard fallback prefers pwsh and preserves UTF-8 through base64", async () => {
  const calls = []
  const selected = "中文🙂 KK Code"
  const result = await copyTerminalText(selected, {
    output: { write() {} },
    platform: "win32",
    env: {},
    spawn(command, args) {
      let input = ""
      const child = clipboardChild({
        code: command === "pwsh.exe" ? 1 : 0,
        onInput(value) {
          input = value
          calls.push({ command, args, input })
        }
      })
      return child
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.method, "powershell.exe")
  assert.deepEqual(calls.map(({ command }) => command), ["pwsh.exe", "powershell.exe"])
  for (const { args, input } of calls) {
    assert.equal(Buffer.from(input, "base64").toString("utf8"), selected)
    assert.match(args.at(-1), /FromBase64String/)
    assert.match(args.at(-1), /Encoding\]::UTF8/)
  }
})

test("missing native process exit code is not treated as clipboard success", async () => {
  const result = await copyTerminalText("selected", {
    output: { write() {} },
    platform: "darwin",
    env: {},
    spawn() {
      return clipboardChild({ code: null, signal: "SIGTERM" })
    }
  })

  assert.deepEqual(result, {
    ok: false,
    confirmed: false,
    requested: true,
    method: "osc52"
  })
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
