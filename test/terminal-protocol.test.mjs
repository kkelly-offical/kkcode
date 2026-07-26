import test from "node:test"
import assert from "node:assert/strict"
import {
  classifySgrMouseEvent,
  createBracketedPasteDecoder,
  createFocusDecoder,
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

/**
 * 焦点上报（DECSET 1004）。
 *
 * 这一层历来的 bug 全是「跨 chunk 切分」引起的，所以下面几条按切点穷举，而不是
 * 挑一个好切的位置意思一下。漏掉一次，用户切回窗口时输入框里就会多一个 `I`。
 */
test("focus reports are lifted out of the keyboard stream", () => {
  const decoder = createFocusDecoder()
  assert.deepEqual(decoder.feed("\x1b[I"), { events: [{ focused: true }], text: "" })
  assert.deepEqual(decoder.feed("\x1b[O"), { events: [{ focused: false }], text: "" })
})

test("focus reports mixed into typed text leave the text intact", () => {
  const decoder = createFocusDecoder()
  const result = decoder.feed("ab\x1b[Icd\x1b[Oef")
  assert.equal(result.text, "abcdef")
  assert.deepEqual(result.events, [{ focused: true }, { focused: false }])
})

test("a focus report never leaks a stray letter, whichever byte the chunk breaks on", () => {
  // 终端与复用器可以在任意字节处断开。`ESC [ I` 只要有一个字节漏过去，readline
  // 就会把 `I` 当成用户敲的字母插进输入框。
  const stream = "x\x1b[Iy\x1b[Oz"
  for (let cut = 1; cut < stream.length; cut++) {
    const decoder = createFocusDecoder()
    const first = decoder.feed(stream.slice(0, cut))
    const second = decoder.feed(stream.slice(cut))
    const text = first.text + second.text + decoder.flush()
    const events = [...first.events, ...second.events]
    assert.equal(text, "xyz", `切在第 ${cut} 字节时文本被改动了: ${JSON.stringify(text)}`)
    assert.deepEqual(events, [{ focused: true }, { focused: false }],
      `切在第 ${cut} 字节时焦点事件丢了`)
  }
})

test("focus decoder holds an ambiguous Escape until it is flushed", () => {
  // 和鼠标解码器同一条约定：单独一个 ESC 可能是 Esc 键，也可能是序列的开头。
  // 由调用方在转义超时后显式 flush，这里绝不擅自决定。
  const decoder = createFocusDecoder()
  assert.deepEqual(decoder.feed("\x1b"), { events: [], text: "" })
  assert.equal(decoder.hasPending(), true)
  assert.equal(decoder.flush(), "\x1b")
  assert.equal(decoder.hasPending(), false)

  assert.deepEqual(decoder.feed("a\x1b["), { events: [], text: "a" })
  assert.equal(decoder.flush(), "\x1b[")
})

test("focus decoder passes other escape sequences through untouched", () => {
  // 它只认 1004 的两条上报。鼠标上报、光标键、粘贴标记都不归它管，
  // 少一个字节都会让下游解码器错位。
  const decoder = createFocusDecoder()
  const passthrough = "\x1b[<0;4;7M\x1b[200~p\x1b[201~\x1b[A\x1b[2~"
  assert.deepEqual(decoder.feed(passthrough), { events: [], text: passthrough })
  assert.equal(decoder.hasPending(), false)
})

test("focus reports survive being interleaved with mouse reports", () => {
  // repl 里的链是 鼠标 → 焦点 → 括号粘贴。焦点上报可能紧贴着鼠标上报到达。
  const mouse = createSgrMouseDecoder()
  const focus = createFocusDecoder()
  const decoded = focus.feed(mouse.feed("\x1b[<0;4;7M\x1b[Ohi").text)
  assert.equal(decoded.text, "hi")
  assert.deepEqual(decoded.events, [{ focused: false }])
})

test("the full decoder chain survives a byte-at-a-time stream", () => {
  // 逐字节喂是跨 chunk 切分的极端形态：每一个转义序列都被切开了。
  // 这条链的形状必须和 repl.mjs 的 dispatchDecodedInput 一致：鼠标 → 焦点 → 粘贴。
  const mouse = createSgrMouseDecoder()
  const focus = createFocusDecoder()
  const paste = createBracketedPasteDecoder()
  const stream = Buffer.from(
    "你\x1b[<0;4;7M\x1b[Ohi\x1b[200~pasted\nline\x1b[201~\x1b[Iz",
    "utf8"
  )

  let text = ""
  const mouseEvents = []
  const focusEvents = []
  const pastes = []
  for (const byte of stream) {
    const m = mouse.feed(Buffer.from([byte]))
    const f = focus.feed(m.text)
    const p = paste.feed(f.text)
    mouseEvents.push(...m.events)
    focusEvents.push(...f.events)
    pastes.push(...p.pastes)
    text += p.text
  }

  assert.equal(text, "你hiz", "键盘字节被解码器吃掉或改写了")
  assert.deepEqual(pastes, ["pasted\nline"], "粘贴载荷必须原样整块交付")
  assert.equal(mouseEvents.length, 1)
  assert.deepEqual(focusEvents, [{ focused: false }, { focused: true }])
  assert.equal(focus.hasPending(), false)
})

test("focus reporting is on for capable terminals and off for dumb ones", () => {
  const capable = resolveTerminalFeatures({}, { TERM: "xterm-256color" })
  assert.equal(capable.focusReporting, true)
  assert.equal(resolveTerminalFeatures({}, { TERM: "dumb" }).focusReporting, false)
  // 配置能单独关掉它（有些复用器会把 1004 透传成垃圾字节）
  assert.equal(
    resolveTerminalFeatures({ focus_reporting: "never" }, { TERM: "xterm-256color" }).focusReporting,
    false
  )
  assert.equal(
    resolveTerminalFeatures({ focus_reporting: "always" }, { TERM: "dumb" }).focusReporting,
    true
  )
})

test("focus reporting is enabled and disabled together with the rest of the terminal state", () => {
  // 只发 1004h 不发 1004l 的后果落在**用户的 shell 上**：回到 shell 之后每次切
  // 窗口都会收到一串 `^[[I`。
  const features = resolveTerminalFeatures({}, { TERM: "xterm-256color" })
  assert.match(enterTerminalSequence(features), /\x1b\[\?1004h/)
  assert.match(exitTerminalSequence(features), /\x1b\[\?1004l/)
  const off = { ...features, focusReporting: false }
  assert.doesNotMatch(enterTerminalSequence(off), /1004h/)
  assert.doesNotMatch(exitTerminalSequence(off), /1004l/)
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
    copyOnSelect: true,
    focusReporting: true
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
