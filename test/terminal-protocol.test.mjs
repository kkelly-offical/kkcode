import test from "node:test"
import assert from "node:assert/strict"
import {
  classifySgrMouseEvent,
  createBracketedPasteDecoder,
  createSgrMouseDecoder,
  createUtf8TextDecoder,
  enterTerminalSequence,
  exitTerminalSequence,
  isScreenRowWithin,
  normalizeMouseSelection,
  renderTerminalFrame,
  resolveTerminalFeatures
} from "../src/repl/terminal-protocol.mjs"

test("SGR mouse decoder handles one event without RegExp state loss", () => {
  const decoder = createSgrMouseDecoder()
  const result = decoder.feed("\x1b[<64;10;20M")
  assert.equal(result.text, "")
  assert.deepEqual(result.events, [{
    button: 0,
    code: 64,
    x: 10,
    y: 20,
    release: false,
    motion: false,
    wheel: "up",
    shift: false,
    alt: false,
    ctrl: false
  }])
})

test("SGR mouse decoder buffers split reports and preserves keyboard bytes", () => {
  const decoder = createSgrMouseDecoder()
  assert.deepEqual(decoder.feed("a\x1b[<0;4"), { events: [], text: "a" })
  const result = decoder.feed(";7Mb")
  assert.equal(result.text, "b")
  assert.equal(result.events.length, 1)
  assert.deepEqual(result.events[0], {
    button: 0,
    code: 0,
    x: 4,
    y: 7,
    release: false,
    motion: false,
    wheel: null,
    shift: false,
    alt: false,
    ctrl: false
  })
})

test("terminal decoders preserve UTF-8 graphemes split across byte chunks", () => {
  const value = "你🙂"
  const bytes = Buffer.from(value, "utf8")
  const plain = createUtf8TextDecoder()
  const mouse = createSgrMouseDecoder()

  assert.equal(
    plain.feed(bytes.subarray(0, 1)) +
      plain.feed(bytes.subarray(1, 4)) +
      plain.feed(bytes.subarray(4)),
    value
  )
  assert.equal(
    mouse.feed(bytes.subarray(0, 2)).text +
      mouse.feed(bytes.subarray(2, 5)).text +
      mouse.feed(bytes.subarray(5)).text,
    value
  )
})

test("single-line composer rows include their final screen row", () => {
  assert.equal(isScreenRowWithin(9, 9, 9), true)
  assert.equal(isScreenRowWithin(8, 9, 9), false)
  assert.equal(isScreenRowWithin(10, 9, 9), false)
  assert.equal(isScreenRowWithin(11, 9, 11), true)
})

test("bare Escape is retained until explicitly flushed", () => {
  const mouse = createSgrMouseDecoder()
  assert.deepEqual(mouse.feed("\x1b"), { events: [], text: "" })
  assert.equal(mouse.hasPending(), true)
  assert.equal(mouse.flush(), "\x1b")
  assert.equal(mouse.hasPending(), false)

  const paste = createBracketedPasteDecoder()
  assert.deepEqual(paste.feed("\x1b"), {
    text: "",
    pastes: [],
    inPaste: false
  })
  assert.equal(paste.hasPending(), true)
  assert.deepEqual(paste.flush(), {
    text: "\x1b",
    pastes: [],
    inPaste: false
  })
  assert.equal(paste.hasPending(), false)
})

test("SGR mouse decoder accepts a report split immediately after Escape", () => {
  const decoder = createSgrMouseDecoder()
  assert.deepEqual(decoder.feed("a\x1b"), { events: [], text: "a" })
  assert.equal(decoder.hasPending(), true)

  const result = decoder.feed("[<0;4;7Mb")
  assert.equal(result.text, "b")
  assert.equal(result.events.length, 1)
  assert.deepEqual(result.events[0], {
    button: 0,
    code: 0,
    x: 4,
    y: 7,
    release: false,
    motion: false,
    wheel: null,
    shift: false,
    alt: false,
    ctrl: false
  })
  assert.equal(decoder.hasPending(), false)
})

test("primary motion is classified as drag rather than another press", () => {
  const decoder = createSgrMouseDecoder()
  const { events } = decoder.feed("\x1b[<0;4;3M\x1b[<32;8;3M\x1b[<0;8;3m")
  assert.deepEqual(events.map(classifySgrMouseEvent), [
    "primary-press",
    "primary-drag",
    "primary-release"
  ])
})

test("modified wheel reports retain wheel direction", () => {
  const decoder = createSgrMouseDecoder()
  const { events } = decoder.feed("\x1b[<68;4;3M\x1b[<81;4;3M")
  assert.deepEqual(events.map((event) => ({
    action: classifySgrMouseEvent(event),
    shift: event.shift,
    ctrl: event.ctrl
  })), [
    { action: "wheel-up", shift: true, ctrl: false },
    { action: "wheel-down", shift: false, ctrl: true }
  ])
})

test("mouse drag ranges include the release cell and preserve click semantics", () => {
  assert.deepEqual(normalizeMouseSelection({
    startRow: 2,
    startCol: 1,
    endRow: 2,
    endCol: 2,
    moved: true
  }), {
    startRow: 1,
    startCol: 0,
    endRow: 1,
    endCol: 2,
    isClick: false
  })
  assert.equal(normalizeMouseSelection({
    startRow: 2,
    startCol: 2,
    endRow: 2,
    endCol: 2,
    moved: false
  }).isClick, true)
  assert.deepEqual(normalizeMouseSelection({
    startRow: 3,
    startCol: 4,
    endRow: 2,
    endCol: 2,
    moved: true
  }), {
    startRow: 1,
    startCol: 1,
    endRow: 2,
    endCol: 4,
    isClick: false
  })
})

test("bracketed paste decoder returns multiline text atomically across chunks", () => {
  const decoder = createBracketedPasteDecoder()
  assert.deepEqual(decoder.feed("x\x1b[20"), { text: "x", pastes: [], inPaste: false })
  assert.deepEqual(decoder.feed("0~first\nsec"), { text: "", pastes: [], inPaste: true })
  assert.deepEqual(decoder.feed("ond\x1b[201~y"), {
    text: "y",
    pastes: ["first\nsecond"],
    inPaste: false
  })
})

test("bracketed paste markers may be split immediately after Escape", () => {
  const decoder = createBracketedPasteDecoder()
  assert.deepEqual(decoder.feed("before\x1b"), {
    text: "before",
    pastes: [],
    inPaste: false
  })
  assert.equal(decoder.hasPending(), true)
  assert.deepEqual(decoder.feed("[200~payload\x1b"), {
    text: "",
    pastes: [],
    inPaste: true
  })
  assert.equal(decoder.hasPending(), true)
  assert.deepEqual(decoder.feed("[201~after"), {
    text: "after",
    pastes: ["payload"],
    inPaste: false
  })
  assert.equal(decoder.hasPending(), false)
})

test("bracketed paste flush releases an ambiguous Escape into its current stream", () => {
  const decoder = createBracketedPasteDecoder()
  decoder.feed("\x1b[200~value\x1b")
  assert.equal(decoder.hasPending(), true)
  assert.deepEqual(decoder.flush(), {
    text: "",
    pastes: [],
    inPaste: true
  })
  assert.equal(decoder.hasPending(), false)
  assert.deepEqual(decoder.feed("\x1b[201~"), {
    text: "",
    pastes: ["value\x1b"],
    inPaste: false
  })
})

test("terminal feature modes and enter/exit sequences are symmetric", () => {
  const features = resolveTerminalFeatures({
    alternate_screen: "never",
    mouse: "always",
    bracketed_paste: true,
    copy_on_select: true
  }, { TERM: "xterm-256color" })
  assert.deepEqual(features, {
    alternateScreen: false,
    mouse: true,
    bracketedPaste: true,
    copyOnSelect: true
  })
  assert.doesNotMatch(enterTerminalSequence(features), /1049h/)
  assert.match(enterTerminalSequence(features), /1002h/)
  assert.match(exitTerminalSequence(features), /1002l/)
  assert.doesNotMatch(exitTerminalSequence(features), /1049l/)
  assert.match(exitTerminalSequence(features), /\x1b\[999;1H\x1b\[2K\r\n$/)
})

test("frame renderer paints rows independently and restores hardware cursor", () => {
  const rendered = renderTerminalFrame({
    lines: ["first", "second"],
    previousLines: [],
    width: 80,
    height: 24,
    cursor: { row: 2, col: 5, visible: true },
    force: true
  })
  assert.match(rendered, /\x1b\[2J/)
  assert.match(rendered, /\x1b\[1;1H\x1b\[2Kfirst/)
  assert.match(rendered, /\x1b\[2;1H\x1b\[2Ksecond/)
  assert.match(rendered, /\x1b\[2;5H\x1b\[\?25h$/)
  assert.equal(rendered.includes("\n"), false)
})
