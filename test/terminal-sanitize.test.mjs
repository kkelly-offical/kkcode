import test from "node:test"
import assert from "node:assert/strict"
import {
  sanitizeTerminalStyledText,
  sanitizeTerminalText,
  sanitizeTerminalValue
} from "../src/theme/terminal-sanitize.mjs"

test("terminal sanitizer neutralizes CSI, OSC, C1, and bidi controls", () => {
  const source = "ok\x1b[2J\x1b[Howned\x1b]52;c;SGFja2Vk\x07\x9b31m\u202E"
  const safe = sanitizeTerminalText(source)
  assert.doesNotMatch(safe, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  assert.doesNotMatch(safe, /\x1b\[2J|\x1b\]52/)
  assert.match(safe, /␛\[2J/)
  assert.match(safe, /\\u202E/)
})

test("terminal sanitizer preserves useful line and tab structure", () => {
  assert.equal(sanitizeTerminalText("a\r\nb\tc\rd"), "a\nb\tc\nd")
})

test("terminal value sanitizer recursively copies model and tool payloads", () => {
  const source = { args: { command: "echo\x1b[2J" }, rows: ["safe", "\x07bell"] }
  const safe = sanitizeTerminalValue(source)
  assert.notEqual(safe, source)
  assert.equal(safe.args.command, "echo␛[2J")
  assert.equal(safe.rows[1], "␇bell")
})

test("styled terminal sanitizer preserves only SGR formatting", () => {
  const source = "\x1b[32mgreen\x1b[0m\x1b[2J\x1b]52;c;SGFja2Vk\x07"
  const safe = sanitizeTerminalStyledText(source)
  assert.match(safe, /^\x1b\[32mgreen\x1b\[0m/)
  assert.doesNotMatch(safe, /\x1b\[2J|\x1b\]52/)
  assert.match(safe, /␛\[2J␛\]52;c;SGFja2Vk␇$/)
})

test("terminal value sanitizer replaces recursive references", () => {
  const source = { text: "safe" }
  source.self = source
  assert.deepEqual(sanitizeTerminalValue(source), {
    text: "safe",
    self: "[CIRCULAR]"
  })
})
