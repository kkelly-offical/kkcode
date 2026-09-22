import test from "node:test"
import assert from "node:assert/strict"
import { createAttachmentStore } from "../src/repl/attachments.mjs"
import {
  createAttachmentInput,
  DEFAULT_FOLD_LINES,
  DEFAULT_FOLD_CHARS
} from "../src/repl/attachment-input.mjs"

/**
 * 折叠策略与「粘贴只有一条入口」这两件事的回归网。
 *
 * 它们此前是 startTuiRepl 里的三个闭包函数 —— 那时候测不了，只能靠真实终端手点。
 * 抽成模块的一半理由就是这个。
 */

/** 一个够用的假输入框：只记录文本与光标，行为与 repl.mjs 的 insertAtCursor 一致。 */
function createFakeInput({ store = createAttachmentStore(), input = "", cursor = 0 } = {}) {
  const state = { input, cursor, toasts: [] }
  const api = createAttachmentInput({
    store,
    insertAtCursor: (text) => {
      if (!text) return
      state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor)
      state.cursor += text.length
    },
    showToast: (message, options) => state.toasts.push({ message, options })
  })
  return { state, store, ...api }
}

const linesOf = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

test("短粘贴原样插入，不折叠", () => {
  const { state, insertPastedText } = createFakeInput()
  const message = insertPastedText("just one line")
  assert.equal(state.input, "just one line")
  assert.equal(message, "Text pasted")
  assert.doesNotMatch(state.input, /\[Pasted text/, "短文本不该被折叠")
})

test("恰好在阈值下的粘贴不折叠，到阈值就折叠", () => {
  // 阈值两侧各测一次。只测一侧的话，把比较写成 <= 还是 < 都能过。
  const below = createFakeInput()
  below.insertPastedText(linesOf(DEFAULT_FOLD_LINES - 1))
  assert.doesNotMatch(below.state.input, /\[Pasted text/, `${DEFAULT_FOLD_LINES - 1} 行不该折叠`)

  const at = createFakeInput()
  const eight = linesOf(DEFAULT_FOLD_LINES)
  at.insertPastedText(eight)
  assert.equal(at.state.input, `[Pasted text #1 · ${eight.length} chars]`, `${DEFAULT_FOLD_LINES} 行应折叠成标记`)
})

test("单行但很长的粘贴也折叠 —— 一整段没换行的长文本行数恒为 1", () => {
  // 只按行数判断的话这种形态永远不折，而它恰恰是最常见的粘贴内容（一段说明、
  // 一条日志、一个 JSON）。规模也因此报字符数而不是行数。
  const { state, insertPastedText } = createFakeInput()
  insertPastedText("x".repeat(DEFAULT_FOLD_CHARS))
  assert.equal(state.input, `[Pasted text #1 · ${DEFAULT_FOLD_CHARS} chars]`)
})

test("折叠后提交时逐字还原成原文", async () => {
  const { state, insertPastedText, resolveAttachments } = createFakeInput()
  const original = linesOf(20)
  insertPastedText(original)
  state.input += "\n请解释这段"
  const { line, pendingImages } = await resolveAttachments(state.input)
  assert.equal(line, `${original}\n请解释这段`, "折叠纯粹是显示层的事，模型要收到原文")
  assert.deepEqual(pendingImages, [])
})

test("粘图在光标处插标记，标记就是返回值", async () => {
  const { state, attachImage } = createFakeInput({ input: "看这个：", cursor: 4 })
  const marker = await attachImage({ type: "image", data: "AAAA", mediaType: "image/png" })
  assert.equal(marker, "[Image #1 · 3 B]", "标记带人读的规模标签（AAAA = 3 字节）")
  assert.equal(state.input, `看这个：${marker}`, "标记插在光标处")
  assert.equal(state.cursor, 4 + marker.length, "光标落在标记之后")
})

test("提交时图片按标记在文本里的顺序取出，标记本身留在文本里", async () => {
  const { state, attachImage, resolveAttachments } = createFakeInput()
  await attachImage({ type: "image", data: "FIRST", mediaType: "image/png" })
  state.input += " 和 "
  state.cursor = state.input.length
  await attachImage({ type: "image", data: "SECOND", mediaType: "image/jpeg" })

  const { line, pendingImages } = await resolveAttachments(state.input)
  assert.equal(line, "[Image #1 · 3 B] 和 [Image #2 · 4 B]", "标记留在文本里，模型才知道 #1 指的是哪个位置")
  assert.deepEqual(pendingImages.map((b) => b.data), ["FIRST", "SECOND"], "顺序跟着文本走")
})

test("删掉标记就等于取消这张图 —— 不需要任何额外的取消动作", async () => {
  // 这条守的是整个设计的支点：真相在文本里。
  const { state, attachImage, resolveAttachments } = createFakeInput()
  await attachImage({ type: "image", data: "DROPPED", mediaType: "image/png" })
  await attachImage({ type: "image", data: "KEPT", mediaType: "image/png" })
  assert.equal(state.input, "[Image #1 · 5 B][Image #2 · 3 B]")

  state.input = state.input.replace("[Image #1 · 5 B]", "")
  const { pendingImages } = await resolveAttachments(state.input)
  assert.deepEqual(pendingImages.map((b) => b.data), ["KEPT"], "文本里没有的标记就是没被引用")
})

test("失效标记按普通文字发送，并且提示用户", async () => {
  const { state, resolveAttachments } = createFakeInput()
  state.input = "我手打一个 [Image #99] 试试"
  const { line, pendingImages } = await resolveAttachments(state.input)
  assert.equal(line, state.input, "认不出来的标记就是一句普通话，原样发出去")
  assert.deepEqual(pendingImages, [])
  assert.equal(state.toasts.length, 1, "但要提示，否则用户以为图片发出去了")
  assert.equal(state.toasts[0].options.tone, "warning")
})

test("没有标记时不产生任何提示，也不复制字符串", async () => {
  const { state, resolveAttachments } = createFakeInput()
  const plain = "一句没有附件的话"
  const { line, pendingImages } = await resolveAttachments(plain)
  assert.equal(line, plain)
  assert.deepEqual(pendingImages, [])
  assert.deepEqual(state.toasts, [], "无附件的回合不该弹任何东西")
})

test("空剪贴板不插入任何东西", () => {
  const { state, insertPastedText } = createFakeInput()
  assert.equal(insertPastedText(""), "Clipboard is empty")
  assert.equal(insertPastedText(null), "Clipboard is empty")
  assert.equal(state.input, "")
})

test("折叠判定不随行尾变化 —— Windows 上粘的是 CRLF", () => {
  // 本项目已四次栽在 Windows/POSIX 分歧上，最近一次（0.6.27）就是按 `\n` 切 CRLF。
  // 不归一的话 8 行 CRLF 文本只会被数成 1 行，于是同一段内容在 Windows 上不折叠、
  // 在 Linux 上折叠。这条断言在 Linux 上也会红。
  const lf = linesOf(DEFAULT_FOLD_LINES)
  for (const [label, text] of [
    ["CRLF", lf.replace(/\n/g, "\r\n")],
    ["CR", lf.replace(/\n/g, "\r")]
  ]) {
    const { state } = (() => {
      const harness = createFakeInput()
      harness.insertPastedText(text)
      return harness
    })()
    assert.equal(state.input, `[Pasted text #1 · ${lf.length} chars]`,
      `${label} 行尾下数出的规模必须与 LF 完全一致`)
  }
})

test("折叠存下来的原文行尾也被归一", async () => {
  const { state, insertPastedText, resolveAttachments } = createFakeInput()
  insertPastedText(linesOf(DEFAULT_FOLD_LINES).replace(/\n/g, "\r\n"))
  const { line } = await resolveAttachments(state.input)
  assert.doesNotMatch(line, /\r/, "输入框内部是 LF，还原出来的原文也必须是")
  assert.equal(line.split("\n").length, DEFAULT_FOLD_LINES)
})

test("阈值可以调 —— 它是个旋钮，不是写死的数字", () => {
  const store = createAttachmentStore()
  const state = { input: "", cursor: 0 }
  const api = createAttachmentInput({
    store,
    insertAtCursor: (text) => { state.input += text },
    showToast: () => {},
    foldLines: 2,
    foldChars: 10_000
  })
  api.insertPastedText("a\nb")
  assert.equal(state.input, "[Pasted text #1 · 3 chars]", "阈值调到 2 行后，两行就该折")
})

// --- 1.0.1：媒体附件 + 模型能力门 ---

test("unknown video support refuses attachment without a misleading success marker", async () => {
  const { state, attachMedia } = createFakeInput()
  const marker = await attachMedia({ type: "video", data: "VVJFTw==", mediaType: "video/mp4", bytes: 734003 })
  assert.equal(marker, null)
  assert.equal(state.input, '')
  assert.equal(state.toasts.length, 1, "能力未知要给一句明白话，不是静默挂上")
  assert.equal(state.toasts[0].options.tone, "error")
  assert.match(state.toasts[0].message, /support is unknown/)
})

test("a model that explicitly rejects a medium refuses the attach with a clear error", async () => {
  // 明确不支持 → 不挂标记、报错。「明确提示而不是静默丢弃」
  const { state, attachMedia } = createFakeInput()
  const api = createAttachmentInput({
    store: state.store || createAttachmentStore(),
    insertAtCursor: (text) => { state.input += text },
    showToast: (message, options) => state.toasts.push({ message, options }),
    supportsMedia: (kind) => kind === "video" ? false : kind === "image"
  })
  const marker = await api.attachMedia({ type: "video", data: "VVJFTw==", mediaType: "video/mp4" })
  assert.equal(marker, null)
  assert.equal(state.input, "", "拒绝时不该往输入框里插任何东西")
  assert.match(state.toasts.at(-1).message, /does not accept video/)
  assert.equal(state.toasts.at(-1).options.tone, "error")
})

test("unsupported media is held back at submit time with an explicit note, not silently dropped", async () => {
  const { state, store, attachMedia } = createFakeInputWithSupport(() => true)
  await attachMedia({ type: "video", data: "VVJFTw==", mediaType: "video/mp4" })
  // 挂上时支持；用户切换到不支持的模型后再次检查旧标记。
  const { line, pendingImages } = await resolveWith(state, store, () => false)
  assert.deepEqual(pendingImages, [], "video 块不能进待发数组 —— provider 会静默丢")
  assert.match(line, /not sent/, "文本里要留下一句人话，模型与用户都看得见")
  assert.match(line, /\[Video #1/, "标记本身留在文本里")
})

test("supported media sails through resolve untouched", async () => {
  const { state, attachMedia, resolveAttachments } = createFakeInputWithSupport(() => true)
  await attachMedia({ type: "audio", data: "QVVB", mediaType: "audio/mpeg" })
  const { line, pendingImages } = await resolveAttachments(state.input)
  assert.equal(pendingImages.length, 1)
  assert.equal(pendingImages[0].type, "audio")
  assert.doesNotMatch(line, /not sent/)
})

function resolveWith(state, store, supportsMedia) {
  const api = createAttachmentInput({
    store,
    insertAtCursor: () => {},
    showToast: (message, options) => state.toasts.push({ message, options }),
    supportsMedia
  })
  return api.resolveAttachments(state.input)
}

function createFakeInputWithSupport(supportsMedia) {
  const state = { input: "", cursor: 0, toasts: [] }
  const store = createAttachmentStore()
  const api = createAttachmentInput({
    store,
    insertAtCursor: (text) => { state.input += text; state.cursor += text.length },
    showToast: (message, options) => state.toasts.push({ message, options }),
    supportsMedia
  })
  return { state, store, ...api }
}
