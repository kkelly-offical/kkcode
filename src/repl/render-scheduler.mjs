/**
 * 帧调度：把「有东西变了」合并成「每 16ms 最多重画一次」。
 *
 * 抽出来的理由不只是行数。这套逻辑此前是 `startTuiRepl` 里六个裸 `let`
 * （`lastFrame` `lastFrameWidth` `forceFullPaint` `renderScheduled` `renderTimer`
 * `spinnerTimer`）加五个函数，闭包里任何一段代码都能改它们 —— 而它们决定的是
 * **差分绘制**：`lastFrame` 错了就会画出残影，`forceFullPaint` 漏置就会在浮层
 * 打开时留下上一帧的碎片。
 *
 * 更要紧的是它此前**完全没有测试**：帧合并（连续 100 次请求只画一次）、
 * 全量与差分的判定（宽度变了、行数变了、强制刷新）、挂起时不画，
 * 这些都只能靠人眼在真实终端里发现。现在它们是可断言的。
 *
 * 生命周期标志（`disposed`、`terminalSuspended`）不搬进来 —— 它们属于终端层。
 * 这里只通过 `canPaint()` 询问「现在能画吗」，谁来回答是终端层的事。
 */

export function createRenderScheduler({
  buildFrame,
  write,
  renderFrame,
  canPaint = () => true,
  frameIntervalMs = 16,
  spinnerIntervalMs = 120,
  onSpinnerTick = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRepeating = setInterval,
  clearRepeating = clearInterval
}) {
  // 差分绘制的状态。全部私有 —— 此前它们是闭包里谁都能改的裸变量。
  let lastLines = []
  let lastWidth = 0
  let lastPainted = null
  let forceFullPaint = true
  let scheduled = false
  let timer = null
  let spinnerTimer = null
  let disposed = false

  function paintFrame(frame) {
    if (disposed || !canPaint()) return false
    if (!frame || !Array.isArray(frame.lines)) return false
    lastPainted = frame
    // 三种情况必须全量重画：首帧、宽度变了、行数变了。差分算法按行比对，
    // 行数一变就对不上位，画出来是错位的残影而不是新内容。
    const fullPaint = forceFullPaint || frame.width !== lastWidth || lastLines.length !== frame.lines.length
    write(renderFrame({
      lines: frame.lines,
      previousLines: lastLines,
      width: frame.width,
      height: frame.height,
      cursor: frame.cursor,
      force: fullPaint
    }))
    lastLines = frame.lines
    lastWidth = frame.width
    forceFullPaint = false
    return true
  }

  function requestRender({ force = false } = {}) {
    if (disposed || !canPaint()) return
    if (force) forceFullPaint = true
    if (scheduled) return
    scheduled = true
    timer = setTimer(() => {
      scheduled = false
      timer = null
      paintFrame(buildFrame())
    }, frameIntervalMs)
  }

  function cancelPendingFrame() {
    if (timer) clearTimer(timer)
    timer = null
    scheduled = false
  }

  function startBusySpinner() {
    if (spinnerTimer) return
    spinnerTimer = setRepeating(() => {
      if (onSpinnerTick) onSpinnerTick()
      requestRender()
    }, spinnerIntervalMs)
  }

  function stopBusySpinner() {
    if (!spinnerTimer) return
    clearRepeating(spinnerTimer)
    spinnerTimer = null
  }

  return {
    paintFrame,
    requestRender,
    cancelPendingFrame,
    startBusySpinner,
    stopBusySpinner,
    /** 下一帧强制全量重画。终端从挂起恢复、或换了字体/尺寸之后需要。 */
    forceNextPaintFull() { forceFullPaint = true },
    /** 最近画出去的那一帧（含布局元数据）。鼠标选区要靠它把屏幕坐标换成字符位置。 */
    lastPaintedFrame() { return lastPainted },
    isSpinnerRunning() { return Boolean(spinnerTimer) },
    dispose() {
      disposed = true
      cancelPendingFrame()
      stopBusySpinner()
    }
  }
}
