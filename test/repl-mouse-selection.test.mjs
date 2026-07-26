import test from "node:test"
import assert from "node:assert/strict"
import {
  createMouseSelection,
  autoScrollStep,
  absoluteRowFromScreen,
  screenRowFromAbsolute
} from "../src/repl/mouse-selection.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"
import { layoutInputText } from "../src/repl/text-layout.mjs"

/** 用真实的排版函数生成 inputLayout —— 伪造的形状会漏掉 cells/endIndex 这些字段。 */
function layoutFor(ui, width = 40) {
  ui.inputLayout = layoutInputText({
    value: ui.input,
    cursor: ui.inputCursor,
    width,
    maxRows: 3,
    prefix: "",
    selection: null,
    ghost: ""
  })
}

/**
 * 鼠标交互此前在 startTuiRepl 闭包里，**零测试** —— 而它有两处很容易搞错的地方：
 *
 *   1. 选区记的是 transcript 的**绝对行**，不是屏幕行。边选边滚之后同一个屏幕行
 *      下面的内容已经换了，只有绝对行还指向用户当初框住的那几行。
 *   2. 边缘自动滚动必须由定时器驱动 —— SGR 1002 只在跨 cell 移动时上报，鼠标停在
 *      边缘不动是收不到事件的。而定时器必须在四个地方全部停掉。
 */

const LAYOUT = {
  logStartRow: 5,
  logEndRow: 20,
  inputStartRow: 24,
  inputEndRow: 26,
  inputInnerOffset: 3,
  visibleStartIndex: 100,
  transcriptLines: [],
  transcriptHitRegions: []
}

function fakeClock() {
  let id = 1
  const timeouts = new Map()
  const intervals = new Map()
  return {
    setTimer: (fn) => { const k = id++; timeouts.set(k, fn); return k },
    clearTimer: (k) => timeouts.delete(k),
    setRepeating: (fn) => { const k = id++; intervals.set(k, fn); return k },
    clearRepeating: (k) => intervals.delete(k),
    flushTimeouts() { const p = [...timeouts.values()]; timeouts.clear(); p.forEach((f) => f()) },
    tick() { [...intervals.values()].forEach((f) => f()) },
    timeouts: () => timeouts.size,
    intervals: () => intervals.size
  }
}

function harness({ autoCopy = true, frame = { lines: ["x"] } } = {}) {
  const clock = fakeClock()
  const calls = []
  const ui = createReplUiState()
  ui.autoCopy = autoCopy
  ui.layoutMeta = { ...LAYOUT }
  const mouse = createMouseSelection({
    ui,
    transcript: { toggleLog: (id) => calls.push(`toggle(${id})`) },
    requestRender: () => {},
    scrollBy: (n) => { calls.push(`scrollBy(${n})`); ui.scrollOffset = Math.max(0, ui.scrollOffset + n) },
    copyToClipboard: (text) => { calls.push(`copy(${text})`) },
    onInputChanged: () => calls.push("inputChanged"),
    lastPaintedFrame: () => frame,
    isDisposed: () => false,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setRepeating: clock.setRepeating,
    clearRepeating: clock.clearRepeating
  })
  return { mouse, ui, calls, clock }
}

/**
 * SGR 鼠标事件的真实形状（见 terminal-protocol.mjs 的 classifySgrMouseEvent）：
 * 按下/拖拽/释放靠 motion 与 release 两个标志区分，滚轮走 wheel 字段。
 */
const press = (x, y) => ({ button: 0, x, y })
const drag = (x, y) => ({ button: 0, motion: true, x, y })
const release = (x, y) => ({ button: 0, release: true, x, y })
const rightPress = (x, y) => ({ button: 2, x, y })
const wheelUp = () => ({ wheel: "up", x: 1, y: 1 })
const wheelDown = () => ({ wheel: "down", x: 1, y: 1 })

// --- 坐标换算 ---

test("screen rows map to absolute transcript rows and back", () => {
  const abs = absoluteRowFromScreen(8, LAYOUT)
  assert.equal(abs, 103, "视口第 3 行 + 起点 100")
  assert.equal(screenRowFromAbsolute(abs, LAYOUT), 8, "换回去要对得上")
})

test("a row scrolled out of the viewport maps back to null", () => {
  // 这是「边选边滚之后那一行还在不在屏幕上」的判定
  assert.equal(screenRowFromAbsolute(99, LAYOUT), null, "滚到视口上方")
  assert.equal(screenRowFromAbsolute(200, LAYOUT), null, "滚到视口下方")
})

test("a click above the log area does not produce a negative viewport row", () => {
  assert.equal(absoluteRowFromScreen(1, LAYOUT), 100, "越界要钳到视口起点")
})

// --- 自动滚动的速度分档 ---

test("the further past the edge, the faster it scrolls", () => {
  const near = autoScrollStep(1)
  const mid = autoScrollStep(4)
  const far = autoScrollStep(9)
  assert.ok(far.lines > mid.lines && mid.lines > near.lines, "越界越远滚得越多")
  assert.ok(far.intervalMs < mid.intervalMs && mid.intervalMs < near.intervalMs, "也滚得越快")
  assert.deepEqual(autoScrollStep(-9), far, "方向不影响速度分档")
})

// --- 选区 ---

test("pressing in the log area anchors a selection on the absolute row", () => {
  const { mouse, ui } = harness()
  mouse.handleMouseEvent(press(10, 8))
  assert.ok(ui.mouseSelection?.active)
  assert.equal(ui.mouseSelection.startAbs, 103, "锚点记的是绝对行")
  assert.equal(ui.mouseSelection.moved, false)
})

test("pressing outside the log area starts no selection", () => {
  // 落在状态栏上时如果建了选区，自动滚动会把状态栏一起选进去
  const { mouse, ui } = harness()
  mouse.handleMouseEvent(press(10, 22))
  assert.equal(ui.mouseSelection, null)
})

test("a drag past the edge clamps the row and keeps extending", () => {
  const { mouse, ui } = harness()
  mouse.handleMouseEvent(press(10, 8))
  mouse.handleMouseEvent(drag(12, 30))   // 远在日志区下方
  assert.equal(ui.mouseSelection.endRow, LAYOUT.logEndRow, "行钳回边界")
  assert.equal(ui.mouseSelection.moved, true)
})

test("dragging past the edge starts auto-scroll, releasing stops it", () => {
  const { mouse, ui, clock } = harness()
  mouse.handleMouseEvent(press(10, 8))
  mouse.handleMouseEvent(drag(12, 30))
  assert.equal(mouse.isAutoScrolling(), true, "越出边缘要靠定时器继续滚")
  assert.equal(clock.intervals(), 1)
  mouse.handleMouseEvent(release(12, 30))
  assert.equal(mouse.isAutoScrolling(), false, "松手必须停")
  assert.equal(clock.intervals(), 0)
})

test("auto-scroll stops when the transcript cannot scroll further", () => {
  // 已经到顶/到底还继续跑定时器，就是一个永远不停的空转
  const { mouse, ui, clock } = harness()
  mouse.handleMouseEvent(press(10, 8))
  mouse.handleMouseEvent(drag(12, 30))
  ui.scrollOffset = 0
  clock.tick()   // scrollBy 之后 offset 没变
  assert.equal(mouse.isAutoScrolling(), false)
})

test("a drag back inside the log area stops auto-scroll", () => {
  const { mouse } = harness()
  mouse.handleMouseEvent(press(10, 8))
  mouse.handleMouseEvent(drag(12, 30))
  assert.equal(mouse.isAutoScrolling(), true)
  mouse.handleMouseEvent(drag(12, 10))
  assert.equal(mouse.isAutoScrolling(), false)
})

test("releasing copies the selection when auto-copy is on", () => {
  const { mouse, ui, calls } = harness({ autoCopy: true })
  ui.layoutMeta.transcriptLines = []
  ui.layoutMeta.transcriptLines[101] = "第一行内容"
  ui.layoutMeta.transcriptLines[102] = "第二行内容"
  mouse.handleMouseEvent(press(1, 5))     // abs 100 -> normalize 后 101
  mouse.handleMouseEvent(drag(6, 6))
  mouse.handleMouseEvent(release(6, 6))
  assert.ok(calls.some((c) => c.startsWith("copy(")), `应当复制，实际: ${calls.join(",")}`)
})

test("with auto-copy off the highlight stays and nothing is copied", () => {
  const { mouse, ui, calls } = harness({ autoCopy: false })
  ui.layoutMeta.transcriptLines = []
  ui.layoutMeta.transcriptLines[101] = "内容"
  mouse.handleMouseEvent(press(1, 5))
  mouse.handleMouseEvent(drag(4, 6))
  mouse.handleMouseEvent(release(4, 6))
  assert.ok(!calls.some((c) => c.startsWith("copy(")), "关掉自动复制就不该复制")
  assert.ok(ui.mouseSelection, "高亮要留着，等下次点击或按键清除")
})

test("right-click copies even with auto-copy off", () => {
  const { mouse, ui, calls } = harness({ autoCopy: false })
  ui.layoutMeta.transcriptLines = []
  ui.layoutMeta.transcriptLines[101] = "内容"
  mouse.handleMouseEvent(press(1, 5))
  mouse.handleMouseEvent(drag(4, 6))
  mouse.handleMouseEvent(release(4, 6))
  calls.length = 0
  mouse.handleMouseEvent(rightPress(4, 6))
  assert.ok(calls.some((c) => c.startsWith("copy(")), "终端把鼠标交给应用后，右键复制得我们自己实现")
})

test("a click without movement toggles a collapsible block instead of selecting", () => {
  const { mouse, ui, calls } = harness()
  ui.layoutMeta.transcriptHitRegions = [
    { row: 8, columnStart: 1, columnEnd: 40, itemId: "log_7", action: "toggle" }
  ]
  mouse.handleMouseEvent(press(10, 8))
  mouse.handleMouseEvent(release(10, 8))
  assert.deepEqual(calls, ["toggle(log_7)"])
  assert.equal(ui.mouseSelection, null)
})

test("selection is dropped when there is no painted frame to measure against", () => {
  const { mouse, ui } = harness({ frame: null })
  mouse.handleMouseEvent(press(10, 8))
  mouse.handleMouseEvent(release(10, 8))
  assert.equal(ui.mouseSelection, null, "没有帧就没有布局元数据，只能放弃")
})

// --- 输入框 ---

test("clicking the input box positions the cursor and clears any selection", () => {
  const { mouse, ui } = harness()
  ui.input = "abcdefgh"
  layoutFor(ui)
  ui.inputSelection = { start: 1, end: 3 }
  mouse.handleMouseEvent(press(6, 24))
  assert.equal(ui.inputSelection, null)
  assert.ok(ui.inputDragAnchor >= 0, "按下即成为拖选锚点")
})

test("clicking the input box does nothing while busy", () => {
  const { mouse, ui } = harness()
  ui.busy = true
  ui.input = "abc"
  ui.inputCursor = 0
  mouse.handleMouseEvent(press(6, 24))
  assert.equal(ui.inputCursor, 0, "生成中不该改动输入框")
})

test("a zero-width input drag does not leave a phantom selection", () => {
  // 留着的话下一次退格会误删
  const { mouse, ui } = harness()
  ui.input = "abc"
  layoutFor(ui)
  mouse.handleMouseEvent(press(4, 24))
  mouse.handleMouseEvent(release(4, 24))
  assert.equal(ui.inputSelection, null)
  assert.equal(ui.inputDragAnchor, -1)
})

test("deleteInputSelection removes the range and reports whether it did", () => {
  const { mouse, ui, calls } = harness()
  ui.input = "一二三四五"
  ui.inputSelection = { start: 1, end: 3 }
  assert.equal(mouse.deleteInputSelection(), true)
  assert.equal(ui.input, "一四五")
  assert.equal(ui.inputCursor, 1)
  assert.equal(ui.inputSelection, null)
  assert.ok(calls.includes("inputChanged"))

  assert.equal(mouse.deleteInputSelection(), false, "没有选区时要如实返回 false")
})

test("an empty range is not a selection", () => {
  const { mouse, ui } = harness()
  ui.input = "abc"
  ui.inputSelection = { start: 2, end: 2 }
  assert.equal(mouse.deleteInputSelection(), false)
  assert.equal(ui.input, "abc")
})

// --- 滚轮与清理 ---

test("the wheel scrolls without touching the selection", () => {
  const { mouse, calls } = harness()
  mouse.handleMouseEvent(wheelUp())
  mouse.handleMouseEvent(wheelDown())
  assert.deepEqual(calls, ["scrollBy(3)", "scrollBy(-3)"])
})

test("clearSelections stops auto-scroll and drops every selection state", () => {
  const { mouse, ui } = harness()
  mouse.handleMouseEvent(press(10, 8))
  mouse.handleMouseEvent(drag(12, 30))
  ui.inputSelection = { start: 0, end: 2 }
  ui.inputDragAnchor = 3
  mouse.clearSelections()
  assert.equal(ui.mouseSelection, null)
  assert.equal(ui.inputSelection, null)
  assert.equal(ui.inputDragAnchor, -1)
  assert.equal(mouse.isAutoScrolling(), false)
})

test("dispose stops both timers", () => {
  // 退出与挂起路径都要调 —— 漏掉的话定时器拖着进程不退出
  const { mouse, ui, clock } = harness()
  ui.layoutMeta.transcriptLines = []
  ui.layoutMeta.transcriptLines[101] = "内容"
  mouse.handleMouseEvent(press(1, 5))
  mouse.handleMouseEvent(drag(4, 30))    // 起自动滚动
  mouse.handleMouseEvent(release(4, 6))   // 起高亮清除定时器
  mouse.dispose()
  assert.equal(clock.intervals(), 0, "自动滚动定时器要停")
  assert.equal(clock.timeouts(), 0, "高亮清除定时器也要停")
})
