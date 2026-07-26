import test from "node:test"
import assert from "node:assert/strict"
import { createRenderScheduler } from "../src/repl/render-scheduler.mjs"

/**
 * 帧调度此前是 startTuiRepl 里的六个裸 `let` 加五个函数，**没有任何测试**。
 * 它决定的是差分绘制：`lastFrame` 记错会画出残影，`forceFullPaint` 漏置会让
 * 浮层打开时留着上一帧的碎片。这些以前只能靠人眼在真实终端里发现。
 *
 * 定时器全部注入，所以测试不用等真实的 16ms。
 */

/** 手动推进的假定时器 —— 让「合并」这件事可以被精确断言。 */
function fakeClock() {
  let nextId = 1
  const timeouts = new Map()
  const intervals = new Map()
  return {
    setTimer: (fn) => { const id = nextId++; timeouts.set(id, fn); return id },
    clearTimer: (id) => { timeouts.delete(id) },
    setRepeating: (fn) => { const id = nextId++; intervals.set(id, fn); return id },
    clearRepeating: (id) => { intervals.delete(id) },
    /** 触发所有待执行的一次性定时器 */
    flush() {
      const pending = [...timeouts.entries()]
      timeouts.clear()
      for (const [, fn] of pending) fn()
      return pending.length
    },
    tickIntervals() {
      for (const [, fn] of [...intervals.entries()]) fn()
    },
    pendingTimeouts: () => timeouts.size,
    pendingIntervals: () => intervals.size
  }
}

function makeScheduler(patch = {}) {
  const clock = fakeClock()
  const painted = []
  const frames = []
  let frameNo = 0
  const scheduler = createRenderScheduler({
    buildFrame: () => {
      frameNo += 1
      const frame = { lines: [`帧 ${frameNo}`], width: 80, height: 24, cursor: { row: 1, col: 1 } }
      frames.push(frame)
      return frame
    },
    write: (text) => painted.push(text),
    renderFrame: ({ lines, previousLines, force }) =>
      `[${force ? "full" : "diff"}] prev=${previousLines.length} lines=${lines.length}`,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setRepeating: clock.setRepeating,
    clearRepeating: clock.clearRepeating,
    ...patch
  })
  return { scheduler, clock, painted, frames }
}

test("a burst of render requests coalesces into a single paint", () => {
  // 一个回合里 requestRender 会被调上百次（每个流式 chunk、每次按键、
  // 每个工具事件）。不合并的话终端会被刷爆。
  const { scheduler, clock, painted } = makeScheduler()
  for (let i = 0; i < 100; i++) scheduler.requestRender()
  assert.equal(painted.length, 0, "还没到帧时间，不该画")
  assert.equal(clock.pendingTimeouts(), 1, "100 次请求只该排一个定时器")
  clock.flush()
  assert.equal(painted.length, 1, "100 次请求合并成一次绘制")
})

test("the first paint is a full paint", () => {
  const { scheduler, clock, painted } = makeScheduler()
  scheduler.requestRender()
  clock.flush()
  assert.match(painted[0], /^\[full\]/, "首帧没有可比对的上一帧，必须全量")
})

test("a steady frame paints as a diff", () => {
  const { scheduler, clock, painted } = makeScheduler()
  scheduler.requestRender()
  clock.flush()
  scheduler.requestRender()
  clock.flush()
  assert.match(painted[1], /^\[diff\]/, "尺寸与行数都没变，应走差分")
  assert.match(painted[1], /prev=1/, "差分要拿到上一帧内容")
})

test("force makes the next paint full again", () => {
  // 浮层打开/关闭时必须强制全量：差分只改动过的行，浮层边框覆盖的区域
  // 在上一帧里是别的内容，不全量就会留下碎片。
  const { scheduler, clock, painted } = makeScheduler()
  scheduler.requestRender()
  clock.flush()
  scheduler.requestRender({ force: true })
  clock.flush()
  assert.match(painted[1], /^\[full\]/)
})

test("force survives coalescing", () => {
  // 关键：force 和普通请求在同一帧窗口里合并时，force 不能被吃掉。
  const { scheduler, clock, painted } = makeScheduler()
  scheduler.requestRender()
  clock.flush()
  scheduler.requestRender()             // 先排普通请求
  scheduler.requestRender({ force: true })  // 同一窗口里再来一次强制
  clock.flush()
  assert.match(painted[1], /^\[full\]/, "同窗口内的 force 必须生效，否则浮层会留碎片")
})

test("a width change forces a full paint even without force", () => {
  const clock = fakeClock()
  const painted = []
  let width = 80
  const scheduler = createRenderScheduler({
    buildFrame: () => ({ lines: ["x"], width, height: 24, cursor: null }),
    write: (t) => painted.push(t),
    renderFrame: ({ force }) => (force ? "[full]" : "[diff]"),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setRepeating: clock.setRepeating,
    clearRepeating: clock.clearRepeating
  })
  scheduler.requestRender(); clock.flush()
  scheduler.requestRender(); clock.flush()
  assert.equal(painted[1], "[diff]")
  width = 120
  scheduler.requestRender(); clock.flush()
  assert.equal(painted[2], "[full]", "宽度变了差分算法对不上位，必须全量")
})

test("a line-count change forces a full paint", () => {
  const clock = fakeClock()
  const painted = []
  let lines = ["a", "b"]
  const scheduler = createRenderScheduler({
    buildFrame: () => ({ lines, width: 80, height: 24, cursor: null }),
    write: (t) => painted.push(t),
    renderFrame: ({ force }) => (force ? "[full]" : "[diff]"),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setRepeating: clock.setRepeating,
    clearRepeating: clock.clearRepeating
  })
  scheduler.requestRender(); clock.flush()
  scheduler.requestRender(); clock.flush()
  assert.equal(painted[1], "[diff]")
  lines = ["a", "b", "c"]
  scheduler.requestRender(); clock.flush()
  assert.equal(painted[2], "[full]", "行数变了必须全量，否则新增行会错位")
})

test("nothing paints while the terminal cannot be painted", () => {
  // 终端挂起（Ctrl+Z）或已 dispose 时写出去的转义序列会污染用户的 shell
  let ok = false
  const { scheduler, clock, painted } = makeScheduler({ canPaint: () => ok })
  scheduler.requestRender()
  assert.equal(clock.pendingTimeouts(), 0, "不能画的时候连定时器都不该排")
  scheduler.paintFrame({ lines: ["x"], width: 80, height: 24 })
  assert.deepEqual(painted, [], "直接调 paintFrame 也必须被挡住")
  ok = true
  scheduler.requestRender()
  clock.flush()
  assert.equal(painted.length, 1, "恢复后应能正常绘制")
})

test("a malformed frame is ignored rather than painted", () => {
  const { scheduler, painted } = makeScheduler()
  assert.equal(scheduler.paintFrame(null), false)
  assert.equal(scheduler.paintFrame({ width: 80 }), false)
  assert.deepEqual(painted, [])
})

test("cancelPendingFrame drops the queued paint", () => {
  const { scheduler, clock, painted } = makeScheduler()
  scheduler.requestRender()
  scheduler.cancelPendingFrame()
  clock.flush()
  assert.deepEqual(painted, [], "退出路径上排队的帧必须能取消，否则会在清屏之后再画一帧")
  // 取消之后还能重新排
  scheduler.requestRender()
  clock.flush()
  assert.equal(painted.length, 1)
})

test("the busy spinner ticks and repaints, and stops cleanly", () => {
  const ticks = []
  const { scheduler, clock, painted } = makeScheduler({ onSpinnerTick: () => ticks.push(1) })
  scheduler.startBusySpinner()
  scheduler.startBusySpinner()  // 重复调用不该起第二个
  assert.equal(clock.pendingIntervals(), 1)
  assert.equal(scheduler.isSpinnerRunning(), true)
  clock.tickIntervals()
  clock.flush()
  assert.equal(ticks.length, 1, "每次转动推进一格")
  assert.equal(painted.length, 1, "转动要触发重绘，否则动画不动")
  scheduler.stopBusySpinner()
  assert.equal(clock.pendingIntervals(), 0)
  assert.equal(scheduler.isSpinnerRunning(), false)
})

test("the last painted frame is available for hit-testing", () => {
  // 鼠标选区要把屏幕坐标换算成字符位置，靠的是最近一帧的布局元数据。
  const { scheduler, clock, frames } = makeScheduler()
  assert.equal(scheduler.lastPaintedFrame(), null, "还没画过时应为 null")
  scheduler.requestRender()
  clock.flush()
  assert.equal(scheduler.lastPaintedFrame(), frames[0])
})

test("dispose stops everything and refuses further work", () => {
  const { scheduler, clock, painted } = makeScheduler()
  scheduler.startBusySpinner()
  scheduler.requestRender()
  scheduler.dispose()
  assert.equal(clock.pendingIntervals(), 0, "dispose 必须停掉 spinner，否则进程不退出")
  assert.equal(clock.pendingTimeouts(), 0, "排队的帧也要取消")
  scheduler.requestRender()
  clock.flush()
  assert.deepEqual(painted, [], "dispose 之后不该再画")
})
