import test from "node:test"
import assert from "node:assert/strict"
import { createInputDecoderChain } from "../src/repl/input-decoders.mjs"

/**
 * 输入解码链：鼠标 → 焦点 → 括号粘贴。
 *
 * 这里全部走纯函数，不碰真实 stdin —— e2e 能抓到「按键被吞」，但要三十秒起步，
 * 而且它只告诉你有东西被吞了，不告诉你是哪一层扣着不放。
 */

const ALL_ON = { mouse: true, focusReporting: true, bracketedPaste: true }

function makeChain(features = ALL_ON) {
  const focusEvents = []
  const mouseEvents = []
  const chain = createInputDecoderChain({
    features,
    onMouseEvent: (ev) => mouseEvents.push(ev),
    onFocus: (focused) => focusEvents.push(focused)
  })
  return { chain, focusEvents, mouseEvents }
}

const bytes = (text) => Buffer.from(text, "utf8")

// --- 本次缺陷的最小化 ---

test("a bare Escape is released by the flush instead of eating the next key", () => {
  // 焦点解码器会把孤立的 ESC 当成 `ESC [ I` 的前缀扣住 —— 跨 chunk 切分必须这么做。
  // 但超时兜底必须把它放出来：扣着不放的话，下一个键接在它后面变成一条转义序列
  // （readline 会读成 Meta+key），两个键一起消失。
  const { chain } = makeChain()

  assert.deepEqual(chain.feed(bytes("\x1b")), { text: "", pastes: [], mouseEvents: 0 })
  assert.equal(chain.hasPending(), true, "孤立的 ESC 必须被扣住，否则跨 chunk 的转义序列会碎掉")

  const flushed = chain.flush()
  assert.equal(flushed.text, "\x1b", "超时之后那个 ESC 必须原样出来")
  assert.deepEqual(flushed.pastes, [])
  assert.equal(chain.hasPending(), false, "flush 之后不许还有人扣着东西")

  // 紧跟着的那个键必须单独出来，而不是被拼成 `ESC a`
  assert.equal(chain.feed(bytes("a")).text, "a", "ESC 之后的那个键被吞了")
})

test("flushing twice in a row does not resurrect the Escape", () => {
  const { chain } = makeChain()
  chain.feed(bytes("\x1b"))
  assert.equal(chain.flush().text, "\x1b")
  assert.equal(chain.flush().text, "", "已经放出去的字节不许再出来一次")
})

// --- 焦点上报 ---

test("focus reports are stripped from the text and delivered as callbacks", () => {
  const { chain, focusEvents } = makeChain()
  assert.equal(chain.feed(bytes("\x1b[I")).text, "")
  assert.equal(chain.feed(bytes("\x1b[O")).text, "")
  assert.deepEqual(focusEvents, [true, false])
})

test("a focus report split across chunks is still recognised", () => {
  const { chain, focusEvents } = makeChain()
  assert.equal(chain.feed(bytes("\x1b")).text, "")
  assert.equal(chain.feed(bytes("[I")).text, "")
  assert.deepEqual(focusEvents, [true])
  assert.equal(chain.hasPending(), false)
})

test("a focus report embedded in ordinary text leaves the text intact", () => {
  const { chain, focusEvents } = makeChain()
  assert.equal(chain.feed(bytes("ab\x1b[Icd")).text, "abcd")
  assert.deepEqual(focusEvents, [true])
})

test("a focus report pressed up against a mouse report survives both layers", () => {
  const { chain, focusEvents, mouseEvents } = makeChain()
  const decoded = chain.feed(bytes("\x1b[<0;4;7M\x1b[Ohi"))
  assert.equal(decoded.text, "hi")
  assert.equal(decoded.mouseEvents, 1, "鼠标事件计数要透出来 —— repl 用它决定要不要重绘")
  assert.equal(mouseEvents.length, 1)
  assert.deepEqual(focusEvents, [false])
})

test("the chain survives a byte-at-a-time stream of every protocol at once", () => {
  const { chain, focusEvents, mouseEvents } = makeChain()
  const stream = bytes("你\x1b[<0;4;7M\x1b[Ohi\x1b[200~pasted\nline\x1b[201~\x1b[Iz")
  let text = ""
  const pastes = []
  for (const byte of stream) {
    const decoded = chain.feed(Buffer.from([byte]))
    text += decoded.text
    pastes.push(...decoded.pastes)
  }
  assert.equal(text, "你hiz", "键盘字节被解码器吃掉或改写了")
  assert.deepEqual(pastes, ["pasted\nline"], "粘贴载荷必须原样整块交付")
  assert.equal(mouseEvents.length, 1)
  assert.deepEqual(focusEvents, [false, true])
  assert.equal(chain.hasPending(), false)
})

// --- flush 要放出三层 ---

test("flush releases what the mouse layer is holding", () => {
  const { chain } = makeChain()
  assert.equal(chain.feed(bytes("x\x1b[<0;4;7")).text, "x")
  assert.equal(chain.hasPending(), true)
  assert.equal(chain.flush().text, "\x1b[<0;4;7", "半条鼠标上报要原样退回按键流")
})

test("flush releases what the focus layer is holding", () => {
  // 鼠标关掉时焦点层直接面对 chunk 边界，`ESC [` 会扣在它手里。
  const { chain } = makeChain({ mouse: false, focusReporting: true, bracketedPaste: true })
  assert.equal(chain.feed(bytes("hi\x1b[")).text, "hi")
  assert.equal(chain.hasPending(), true)
  assert.equal(chain.flush().text, "\x1b[", "焦点层扣着的字节没有被放出来")
})

test("flush releases what the paste layer is holding", () => {
  const { chain } = makeChain()
  assert.equal(chain.feed(bytes("x\x1b[20")).text, "x", "半条粘贴起始标记不能提前漏给 readline")
  assert.equal(chain.hasPending(), true)
  assert.equal(chain.flush().text, "\x1b[20")
})

test("flush releases the focus and paste layers together, in arrival order", () => {
  const { chain } = makeChain({ mouse: false, focusReporting: true, bracketedPaste: true })
  assert.equal(chain.feed(bytes("\x1b[20")).text, "")   // 粘贴层扣住半条起始标记
  assert.equal(chain.feed(bytes("\x1b[")).text, "")     // 焦点层扣住半条焦点上报
  assert.equal(chain.hasPending(), true)
  // 焦点扣着的那半条是**后**到的，必须排在粘贴扣着的那半条后面 —— 顺序反了就是
  // 用户按键顺序被调换。
  assert.equal(chain.flush().text, "\x1b[20\x1b[")
  assert.equal(chain.hasPending(), false)
})

test("flush does not run the focus layer over its own leftovers", () => {
  // 这条是缺陷的根：把焦点 flush 的结果喂回链首，孤立的 ESC 会被同一个解码器
  // 再次扣住，原地打转。flush 出来的文本只能往**下游**走。
  const { chain, focusEvents } = makeChain({
    mouse: false,
    focusReporting: true,
    bracketedPaste: false
  })
  assert.equal(chain.feed(bytes("\x1b")).text, "")
  assert.equal(chain.flush().text, "\x1b")
  assert.deepEqual(focusEvents, [], "扣着的 ESC 不是一条焦点上报，不许报事件")
  assert.equal(chain.hasPending(), false)
})

test("flush hands back a paste that completed while the layer was holding bytes", () => {
  const { chain } = makeChain()
  const decoded = chain.feed(bytes("\x1b[200~payload\x1b[201~\x1b"))
  assert.deepEqual(decoded.pastes, ["payload"])
  assert.equal(decoded.text, "")
  assert.equal(chain.flush().text, "\x1b")
})

// --- 三个开关各自关掉时是透传 ---

test("mouse reports pass through untouched when the mouse layer is off", () => {
  const { chain, mouseEvents } = makeChain({
    mouse: false,
    focusReporting: true,
    bracketedPaste: true
  })
  assert.equal(chain.feed(bytes("a\x1b[<0;4;7Mb")).text, "a\x1b[<0;4;7Mb")
  assert.deepEqual(mouseEvents, [])
})

test("focus reports pass through untouched when focus reporting is off", () => {
  const { chain, focusEvents } = makeChain({
    mouse: true,
    focusReporting: false,
    bracketedPaste: true
  })
  assert.equal(chain.feed(bytes("a\x1b[Ib")).text, "a\x1b[Ib")
  assert.deepEqual(focusEvents, [])
})

test("paste markers pass through untouched when bracketed paste is off", () => {
  const { chain } = makeChain({ mouse: true, focusReporting: true, bracketedPaste: false })
  const decoded = chain.feed(bytes("\x1b[200~payload\x1b[201~"))
  assert.equal(decoded.text, "\x1b[200~payload\x1b[201~")
  assert.deepEqual(decoded.pastes, [])
})

test("a chain with every layer off still decodes utf8 across chunk boundaries", () => {
  // 透传不等于「不处理」：多字节字符被 chunk 切开时仍然要有人缓冲，
  // 否则用户打一个汉字会看到两个替换符。
  const { chain } = makeChain({ mouse: false, focusReporting: false, bracketedPaste: false })
  const split = bytes("好")
  assert.equal(chain.feed(split.subarray(0, 2)).text, "")
  assert.equal(chain.feed(split.subarray(2)).text, "好")
})

// --- reset ---

test("reset drops everything every layer is holding", () => {
  const { chain } = makeChain({ mouse: false, focusReporting: true, bracketedPaste: true })
  chain.feed(bytes("\x1b[20"))
  chain.feed(bytes("\x1b["))
  assert.equal(chain.hasPending(), true)

  chain.reset()
  assert.equal(chain.hasPending(), false)
  assert.equal(chain.flush().text, "", "reset 之后 flush 不许再吐出旧字节")
  assert.equal(chain.feed(bytes("a")).text, "a", "旧的残留不许粘在下一次输入前面")
})

test("reset clears a paste that was still open", () => {
  const { chain } = makeChain()
  chain.feed(bytes("\x1b[200~half"))
  chain.reset()
  const decoded = chain.feed(bytes("done\x1b[201~"))
  assert.equal(decoded.text, "done\x1b[201~", "reset 之后不该还以为自己在粘贴里")
  assert.deepEqual(decoded.pastes, [])
})


// --- OSC 11 背景色响应（0.7.5 主题自动探测） ---

import { createOsc11Decoder } from "../src/repl/terminal-protocol.mjs"

const ESC = "\u001b"
const BEL = "\u0007"

test("OSC 11 响应被摘出，正文原样透传", () => {
  const osc = createOsc11Decoder()
  const fed = osc.feed(`abc${ESC}]11;rgb:1e1e/1e1e/1e1e${BEL}def`)
  assert.deepEqual(fed.responses, ["rgb:1e1e/1e1e/1e1e"])
  assert.equal(fed.text, "abcdef", "响应两侧的正文一个字都不能丢")
})

test("ST 结尾（ESC 反斜杠）与 BEL 结尾都认", () => {
  const osc = createOsc11Decoder()
  const fed = osc.feed(`${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\x`)
  assert.deepEqual(fed.responses, ["rgb:ffff/ffff/ffff"])
  assert.equal(fed.text, "x")
})

test("响应被 chunk 切开时跨块拼合 —— 这是这层存在的全部理由", () => {
  const osc = createOsc11Decoder()
  const first = osc.feed(`hi${ESC}]11;rgb:12`)
  assert.equal(first.text, "hi", "疑似前缀被扣住，正文先放行")
  assert.ok(osc.hasPending())
  const second = osc.feed(`34/5678/9abc${BEL}bye`)
  assert.deepEqual(second.responses, ["rgb:1234/5678/9abc"])
  assert.equal(second.text, "bye")
  assert.equal(osc.hasPending(), false)
})

test("OSC 2（标题）不被这层吃掉 —— 只认 11", () => {
  const osc = createOsc11Decoder()
  const fed = osc.feed(`${ESC}]2;my title${BEL}rest`)
  assert.deepEqual(fed.responses, [])
  assert.equal(fed.text, `${ESC}]2;my title${BEL}rest`)
})

test("flush 放出扣住的疑似前缀 —— 孤立 ESC 不能永远消失", () => {
  const osc = createOsc11Decoder()
  osc.feed(`${ESC}]1`)
  assert.equal(osc.flush(), `${ESC}]1`, "转义超时后要原样放出来")
  assert.equal(osc.hasPending(), false)
})

test("解码链：没有 onOscResponse 时整层透传 —— 关掉的层不改文本", () => {
  const chain = createInputDecoderChain({ features: {} })
  const fed = chain.feed(Buffer.from(`a${ESC}]11;rgb:0000/0000/0000${BEL}b`, "utf8"))
  assert.match(fed.text, /rgb:0000/, "未启用时不做任何摘除")
})

test("解码链：带 onOscResponse 时响应到回调、正文干净", () => {
  const got = []
  const chain = createInputDecoderChain({
    features: {},
    onOscResponse: (payload) => got.push(payload)
  })
  const fed = chain.feed(Buffer.from(`a${ESC}]11;rgb:fdfd/f6f6/e3e3${BEL}b`, "utf8"))
  assert.deepEqual(got, ["rgb:fdfd/f6f6/e3e3"])
  assert.equal(fed.text, "ab", "响应绝不能漏进输入框")
})
