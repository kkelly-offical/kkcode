/**
 * 鼠标交互：日志区文本选择、输入框光标定位与拖选、边缘自动滚动。
 *
 * ## 为什么选区记的是「绝对行」而不是屏幕行
 *
 * 边选边滚时，同一个屏幕行下面的内容已经换了。只有 transcript 的绝对行还指向
 * 用户当初框住的那几行 —— 屏幕行会随滚动漂走，最后复制出来的是别的内容。
 *
 * ## 为什么自动滚动必须由定时器驱动
 *
 * SGR 1002 只在**跨 cell 移动**时上报。鼠标停在日志区边缘不动是收不到任何事件的，
 * 靠事件驱动的话选区就停在那里不动了。所以边缘滚动是一个定时器，并且必须在
 * 松手、清选区、终端挂起、退出这四处**全部**停掉 —— 漏掉任何一处，进程都不会退出。
 *
 * ## 状态都在模块内
 *
 * 两个定时器与拖拽状态此前是 startTuiRepl 闭包里的裸 `let`，两千行内任何一段都能
 * 改它们。现在它们是私有的，外面只能通过这里返回的几个函数动它们。
 */

import { classifySgrMouseEvent, isScreenRowWithin, normalizeMouseSelection } from "./terminal-protocol.mjs"
import { inputIndexAtPosition, splitTextByCellRange } from "./text-layout.mjs"
import { stripAnsi, displayWidth } from "./frame-primitives.mjs"

/** 越界越远滚得越快。三档就够 —— 再细用户也感觉不出来。 */
export function autoScrollStep(overshoot) {
  const distance = Math.abs(overshoot)
  if (distance >= 6) return { lines: 4, intervalMs: 60 }
  if (distance >= 3) return { lines: 2, intervalMs: 80 }
  return { lines: 1, intervalMs: 120 }
}

/** 屏幕行 → transcript 绝对行。 */
export function absoluteRowFromScreen(row, layout) {
  const viewportRow = Math.max(0, row - layout.logStartRow)
  return (layout.visibleStartIndex || 0) + viewportRow
}

/** transcript 绝对行 → 屏幕行；不在当前视口内时返回 null。 */
export function screenRowFromAbsolute(absRow, layout) {
  const viewportRow = absRow - (layout.visibleStartIndex || 0)
  if (viewportRow < 0) return null
  const row = layout.logStartRow + viewportRow
  return row > layout.logEndRow ? null : row
}

export function createMouseSelection({
  ui,
  transcript,
  requestRender,
  scrollBy,
  copyToClipboard,
  onInputChanged,
  lastPaintedFrame,
  isDisposed = () => false,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRepeating = setInterval,
  clearRepeating = clearInterval,
  highlightHoldMs = 200
}) {
  let autoScrollTimer = null
  let autoScrollState = null
  let selectionClearTimer = null

  function stopAutoScroll() {
    if (autoScrollTimer) {
      clearRepeating(autoScrollTimer)
      autoScrollTimer = null
    }
    autoScrollState = null
  }

  function updateDragSelection(row, col, layout) {
    const sel = ui.mouseSelection
    if (!sel?.active) return
    // 拖到日志区外时把行钳制回边界，配合自动滚动继续扩展选区
    const clampedRow = Math.min(Math.max(row, layout.logStartRow), layout.logEndRow)
    sel.endRow = clampedRow
    sel.endCol = col
    sel.endAbs = absoluteRowFromScreen(clampedRow, layout)
    if (sel.endAbs !== sel.startAbs || col !== sel.startCol) sel.moved = true
    requestRender()
  }

  function updateAutoScroll(row, col, layout) {
    if (!ui.mouseSelection?.active) {
      stopAutoScroll()
      return
    }
    const above = layout.logStartRow - row
    const below = row - layout.logEndRow
    const overshoot = above > 0 ? above : below > 0 ? -below : 0
    if (!overshoot) {
      stopAutoScroll()
      return
    }

    const { lines, intervalMs } = autoScrollStep(overshoot)
    const direction = overshoot > 0 ? lines : -lines
    // 速度没变就只更新列，别重建定时器 —— 重建会让滚动一顿一顿的
    if (autoScrollState?.intervalMs === intervalMs && autoScrollState?.direction === direction) {
      autoScrollState.col = col
      return
    }

    stopAutoScroll()
    autoScrollState = { direction, intervalMs, col }
    autoScrollTimer = setRepeating(() => {
      if (isDisposed() || !ui.mouseSelection?.active) {
        stopAutoScroll()
        return
      }
      const before = ui.scrollOffset
      scrollBy(autoScrollState.direction)
      if (ui.scrollOffset === before) {
        // 已经到顶或到底，继续滚没有意义
        stopAutoScroll()
        return
      }
      const edgeRow = autoScrollState.direction > 0
        ? ui.layoutMeta.logStartRow
        : ui.layoutMeta.logEndRow
      updateDragSelection(edgeRow, autoScrollState.col, ui.layoutMeta)
    }, intervalMs)
  }

  /** 屏幕坐标 → 输入框字符位置 */
  function inputCharFromScreen(row, col, layout) {
    const textCol = Math.max(0, col - layout.inputInnerOffset)
    const inputLineIdx = row - layout.inputStartRow
    if (inputLineIdx < 0) return 0
    return Math.min(ui.input.length, inputIndexAtPosition(ui.inputLayout, inputLineIdx, textCol))
  }

  /** 点击输入框 → 定位光标 */
  function handleInputClick(row, col, layout) {
    if (ui.busy) return
    ui.inputCursor = inputCharFromScreen(row, col, layout)
    ui.inputSelection = null
    ui.inputDragAnchor = ui.inputCursor
    requestRender()
  }

  function clearSelections() {
    stopAutoScroll()
    ui.mouseSelection = null
    ui.inputSelection = null
    ui.inputDragAnchor = -1
    if (selectionClearTimer) {
      clearTimer(selectionClearTimer)
      selectionClearTimer = null
    }
  }

  /** 删除输入框中选中的文本，返回 true 表示确实删了东西。 */
  function deleteInputSelection() {
    const sel = ui.inputSelection
    if (!sel || sel.start === sel.end) return false
    const start = Math.min(sel.start, sel.end)
    const end = Math.max(sel.start, sel.end)
    ui.input = ui.input.slice(0, start) + ui.input.slice(end)
    ui.inputCursor = start
    ui.inputSelection = null
    ui.inputDragAnchor = -1
    onInputChanged()
    return true
  }

  /** 完成文本选择 → 按 autoCopy 决定是否复制。 */
  function finishSelection(forceCopy = false) {
    const sel = ui.mouseSelection
    if (!sel) return
    // 最近画出去的那一帧由帧调度器保管 —— 屏幕坐标换算要靠它的布局元数据
    const frame = lastPaintedFrame()
    if (!frame?.lines) { ui.mouseSelection = null; return }

    // 行用 transcript 绝对行而非屏幕行：边选边滚之后屏幕行下的内容已经
    // 换了，只有绝对行还指向用户当初框住的那几行。
    const { startRow: r1, startCol: c1, endRow: r2, endCol: c2, isClick } = normalizeMouseSelection({
      startRow: (sel.startAbs ?? 0) + 1,
      startCol: sel.startCol,
      endRow: (sel.endAbs ?? 0) + 1,
      endCol: sel.endCol,
      moved: sel.moved
    })

    // 起止相同视为单击 —— 这时它可能落在一个可折叠块的展开区域上
    if (isClick) {
      const screenRow = screenRowFromAbsolute(r1, ui.layoutMeta)
      const hit = screenRow === null ? null : ui.layoutMeta.transcriptHitRegions?.find((region) =>
        region.row === screenRow &&
        c1 + 1 >= region.columnStart &&
        c1 + 1 <= region.columnEnd
      )
      if (hit?.itemId && hit.action === "toggle") transcript.toggleLog(hit.itemId)
      ui.mouseSelection = null
      return
    }

    if (ui.autoCopy || forceCopy) {
      const lines = []
      const transcriptLines = ui.layoutMeta.transcriptLines || []
      for (let r = r1; r <= r2; r++) {
        const plain = stripAnsi(String(transcriptLines[r] ?? ""))
        if (r === r1 && r === r2) {
          lines.push(splitTextByCellRange(plain, c1, c2).selected)
        } else if (r === r1) {
          lines.push(splitTextByCellRange(plain, c1, displayWidth(plain)).selected)
        } else if (r === r2) {
          lines.push(splitTextByCellRange(plain, 0, c2).selected)
        } else {
          lines.push(plain)
        }
      }
      const selectedText = lines.join("\n").trimEnd()
      if (selectedText) void copyToClipboard(selectedText)
      // 复制之后短暂保留高亮再清除：立刻清掉的话用户看不出复制了什么
      if (selectionClearTimer) clearTimer(selectionClearTimer)
      selectionClearTimer = setTimer(() => {
        selectionClearTimer = null
        ui.mouseSelection = null
        requestRender()
      }, highlightHoldMs)
    }
    // autoCopy 关闭时保留高亮，等下次点击或按键清除
  }

  function handleMouseEvent(ev) {
    const action = classifySgrMouseEvent(ev)
    if (action === "wheel-up") { scrollBy(3); return }
    if (action === "wheel-down") { scrollBy(-3); return }

    const row = ev.y  // 1-based 屏幕行
    const col = ev.x  // 1-based 屏幕列
    const layout = ui.layoutMeta

    // 终端把鼠标交给了应用之后，右键的「复制」得由我们自己实现
    if (action === "secondary-press" && ui.mouseSelection) {
      finishSelection(true)
      return
    }

    if (action === "primary-press") {
      clearSelections()
      if (isScreenRowWithin(row, layout.inputStartRow, layout.inputEndRow)) {
        handleInputClick(row, col, layout)
        return
      }
      // 落在状态栏/输入框等区域时不建选区，否则自动滚动会把这些行一起选进去
      if (!isScreenRowWithin(row, layout.logStartRow, layout.logEndRow)) return
      const anchorAbs = absoluteRowFromScreen(row, layout)
      ui.mouseSelection = {
        startRow: row, startCol: col,
        endRow: row, endCol: col,
        startAbs: anchorAbs, endAbs: anchorAbs,
        active: true,
        moved: false
      }
      return
    }

    if (action === "primary-drag") {
      if (ui.mouseSelection?.active) {
        updateDragSelection(row, col, layout)
        updateAutoScroll(row, col, layout)
        return
      }
      if (ui.inputDragAnchor >= 0 && isScreenRowWithin(row, layout.inputStartRow, layout.inputEndRow)) {
        const pos = inputCharFromScreen(row, col, layout)
        const anchor = ui.inputDragAnchor
        ui.inputSelection = { start: Math.min(anchor, pos), end: Math.max(anchor, pos) }
        ui.inputCursor = pos
      }
      return
    }

    if (action === "primary-release") {
      if (ui.mouseSelection?.active) {
        stopAutoScroll()
        updateDragSelection(row, col, layout)
        ui.mouseSelection.active = false
        finishSelection()
        return
      }
      if (ui.inputDragAnchor >= 0) {
        ui.inputDragAnchor = -1
        // 没有实际范围就不算选择，留着会让下一次退格误删
        if (ui.inputSelection && ui.inputSelection.start === ui.inputSelection.end) {
          ui.inputSelection = null
        }
      }
    }
  }

  return {
    handleMouseEvent,
    clearSelections,
    deleteInputSelection,
    finishSelection,
    stopAutoScroll,
    handleInputClick,
    inputCharFromScreen,
    /** 退出与挂起路径都要调 —— 漏掉的话定时器会拖着进程不退出。 */
    dispose() {
      stopAutoScroll()
      if (selectionClearTimer) {
        clearTimer(selectionClearTimer)
        selectionClearTimer = null
      }
    },
    isAutoScrolling: () => Boolean(autoScrollTimer)
  }
}
