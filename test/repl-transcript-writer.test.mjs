import test from "node:test"
import assert from "node:assert/strict"
import { createTranscriptWriter } from "../src/repl/transcript-writer.mjs"
import { createTranscriptModel } from "../src/ui/transcript-model.mjs"

/**
 * 通道路由与文本消毒的契约。
 *
 * 此前这几个函数在 startTuiRepl 的闭包里，测不到 —— 而它们决定两件要紧的事：
 *
 *   1. 一条消息去哪（进对话记录会被发给模型、被 /clear 清掉；进提示会消失）
 *   2. 模型与工具输出里的终端控制序列有没有被拆掉（一个 \x1b[2J 就能清屏）
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

function makeWriter() {
  const transcript = createTranscriptModel({ maxItems: 100 })
  const toasts = []
  const toastStore = {
    show: (message, options) => {
      toasts.push({ message, ...options })
      return `toast_${toasts.length}`
    }
  }
  const writer = createTranscriptWriter({ transcript, toastStore })
  return { writer, transcript, toasts }
}

test("the default channel is the conversation", () => {
  const { writer, transcript, toasts } = makeWriter()
  const id = writer.print("模型说了点什么")
  assert.ok(id, "对话记录条目应该有 id")
  assert.deepEqual(toasts, [], "默认不该弹提示")
  assert.equal(transcript.getItems().length, 1)
  assert.match(transcript.getItems()[0].summary, /模型说了点什么/)
})

test("the notice channel becomes a toast and never touches the conversation", () => {
  // 「刚发生了什么」进对话记录就会随会话发给模型，而它跟对话内容无关
  const { writer, transcript, toasts } = makeWriter()
  const id = writer.print("new session: ses_x", { channel: "notice", topic: "command" })
  assert.equal(id, null, "提示没有对话记录 id")
  assert.equal(transcript.getItems().length, 0, "提示不该进对话记录")
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].message, "new session: ses_x")
  assert.equal(toasts[0].topic, "command")
})

test("a notice defaults to the success tone but respects an explicit one", () => {
  const { writer, toasts } = makeWriter()
  writer.print("成功了", { channel: "notice" })
  writer.print("失败了", { channel: "notice", tone: "error" })
  assert.equal(toasts[0].tone, "success")
  assert.equal(toasts[1].tone, "error")
})

test("colour codes are stripped from toasts", () => {
  // 提示是单行的，颜色码在里面只会把宽度算错
  const { writer, toasts } = makeWriter()
  writer.print(`${ESC}[31m红色文字${ESC}[0m`, { channel: "notice" })
  assert.equal(toasts[0].message, "红色文字")
})

test("the panel channel folds multi-line output into one expandable entry", () => {
  const { writer, transcript } = makeWriter()
  writer.print("第一行\n第二行\n第三行", { channel: "panel", title: "帮助" })
  const items = transcript.getItems()
  assert.equal(items.length, 1, "折叠面板只占一条")
  assert.equal(items[0].summary, "帮助")
  assert.equal(items[0].collapsible, true)
  assert.deepEqual(items[0].details, ["第一行", "第二行", "第三行"])
})

test("a titleless panel promotes the first line to the summary", () => {
  const { writer, transcript } = makeWriter()
  writer.print("标题行\n内容一\n内容二", { channel: "panel" })
  const item = transcript.getItems()[0]
  assert.equal(item.summary, "标题行")
  assert.deepEqual(item.details, ["内容一", "内容二"], "首行升为摘要后不该在正文里重复")
})

test("a single-line panel is not marked collapsible", () => {
  const { writer, transcript } = makeWriter()
  writer.print("就一行", { channel: "panel" })
  const item = transcript.getItems()[0]
  assert.equal(item.collapsible, false, "只有一行没什么可展开的")
  assert.deepEqual(item.details, [])
})

// --- 消毒：内容有相当一部分来自模型与工具输出 ---
//
// 消毒的做法不是删除，而是把控制字符换成**可见替身字形**（ESC → ␛）。
// 所以要验的性质是「终端收不到可解释的转义序列」，而不是「某几个字面字符没了」——
// `[2J` 这三个字符留下来无害，真正危险的是它前面那个 0x1b。

/** 拆掉允许保留的 SGR 颜色序列后，不该再有任何原始 ESC。 */
function assertNoLiveEscape(text, label) {
  const withoutColour = String(text).replace(/\x1b\[[0-9;:]*m/g, "")
  assert.doesNotMatch(withoutColour, /\x1b/, `${label}：留下了可被终端解释的 ESC`)
}

test("a clear-screen sequence is neutralized into visible text", () => {
  const { writer, transcript } = makeWriter()
  writer.appendLog(`文件名${ESC}[2J被清屏了`)
  const summary = transcript.getItems()[0].summary
  assertNoLiveEscape(summary, "清屏序列")
  assert.match(summary, /\u241b/, "应该换成可见替身字形 ␛，而不是静默丢弃")
  assert.match(summary, /文件名/)
  assert.match(summary, /被清屏了/, "两侧的正常内容都要留下")
})

test("an OSC sequence cannot retitle the window through the transcript", () => {
  const { writer, transcript } = makeWriter()
  writer.appendLog(`${ESC}]0;恶意标题${BEL}正常内容`)
  const summary = transcript.getItems()[0].summary
  assertNoLiveEscape(summary, "OSC 序列")
  assert.match(summary, /正常内容/, "正常内容要留下")
})

test("colour codes survive in the conversation", () => {
  // 与提示相反：对话记录是彩色渲染的，颜色码要保留，只拆危险序列
  const { writer, transcript } = makeWriter()
  writer.appendLog(`${ESC}[32m绿色${ESC}[0m`)
  assert.match(transcript.getItems()[0].summary, new RegExp(`${ESC}\\[32m`))
})

test("structured records keep their fields and split details on newlines", () => {
  const { writer, transcript } = makeWriter()
  writer.appendLog({
    summary: "工具执行",
    details: ["第一条\n第二条", "第三条"],
    kind: "tool",
    collapsible: true
  })
  const item = transcript.getItems()[0]
  assert.equal(item.kind, "tool")
  assert.deepEqual(item.details, ["第一条", "第二条", "第三条"],
    "details 里的换行要拆成独立行，否则折叠面板算不对高度")
})

test("a details string is accepted as well as an array", () => {
  const { writer, transcript } = makeWriter()
  writer.appendLog({ summary: "s", details: "单条\n两行" })
  assert.deepEqual(transcript.getItems()[0].details, ["单条", "两行"])
})

test("carriage returns are removed from plain text", () => {
  // Windows 换行进了对话记录会在渲染时留下一个多余的空行
  const { writer, transcript } = makeWriter()
  writer.appendLog("一行\r\n二行")
  assert.doesNotMatch(transcript.getItems()[0].summary, /\r/)
})

test("updateLog sanitizes its patch too", () => {
  const { writer, transcript } = makeWriter()
  const id = writer.appendLog("原始")
  writer.updateLog(id, { summary: `改过${ESC}[2J的` })
  assertNoLiveEscape(transcript.getItems()[0].summary,
    "更新路径也要消毒 —— 工具执行完的回填走的正是这条路")
})

test("updateLog passes a non-object patch through untouched", () => {
  const { writer } = makeWriter()
  const id = writer.appendLog("原始")
  assert.doesNotThrow(() => writer.updateLog(id, null))
})

test("showToast sanitizes and defaults its topic and tone", () => {
  const { writer, toasts } = makeWriter()
  writer.showToast(`提示${ESC}[2J`)
  assertNoLiveEscape(toasts[0].message, "提示")
  assert.equal(toasts[0].topic, "status")
  assert.equal(toasts[0].tone, "info", "直接调 showToast 的缺省语气是 info，不是 success")
})
