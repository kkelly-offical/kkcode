/**
 * 终端设备的所有权：进/出备用屏、原始模式、stdin 补丁、Unix 作业控制。
 *
 * 这是整个 REPL 里唯一直接改**进程外部状态**的地方 —— 原始模式、备用屏、
 * stdin 的 emit 补丁都是全局的。做错的后果不是显示错乱，是用户的 shell 坏掉：
 * 原始模式没恢复，退出后终端不回显；备用屏没退出，屏幕内容丢失；stdin 没
 * pause，进程永远不退出。
 *
 * 所以设备状态全部私有，只能通过这里的几个动作改变：
 *
 *   activate    进备用屏、装解码器、开原始模式、接管 stdin
 *   deactivate  反过来做一遍。`pauseInput` 只在最终拆除时传 —— readline 的
 *               keypress 解码器会一直挂着一个 data 监听器，不 pause 就一直
 *               引用着 TTY handle，进程不退出。
 *   suspend / continueAfter   Ctrl+Z 的两半
 *
 * ## Ctrl+Z 为什么要「吞掉再重发」
 *
 * 直接让默认行为接管，进程会带着备用屏和原始模式停住 —— 回到 shell 看到的是
 * 一团乱码。所以先摘掉自己的 SIGTSTP 处理器、恢复终端状态、再把信号按默认
 * 行为重发一次；SIGCONT 回来时重新进备用屏。这也是 SIGTSTP/SIGCONT 不进
 * 监听器登记本的原因：它们是**有意反复装卸**的。
 */

export function createTerminalSession({
  features,
  startFrame,
  stopFrame,
  emitKeypressEvents,
  interceptStdinEmit,
  originalStdinEmit,
  decoders = [],
  keypressEscapeTimeoutMs,
  cancelPendingFrame,
  cancelProtocolFlush,
  detachInputListeners,
  attachInputListeners,
  abortClipboard,
  repaint,
  isDisposed = () => false,
  stdin = process.stdin,
  platform = process.platform
}) {
  // 设备状态：全部私有。此前是 startTuiRepl 闭包里六个裸 `let`。
  let suspended = true
  let frameActive = false
  let rawModeActive = false
  let stdinEmitPatched = false
  let keypressDecoderStarted = false
  let jobControlSuspended = false
  let resumeFrameAfterContinue = false
  let onSuspendSignal = null
  let onResumeRequested = null

  function deactivate({ pauseInput = false } = {}) {
    suspended = true
    cancelPendingFrame()
    cancelProtocolFlush()
    abortClipboard()
    detachInputListeners()

    if (rawModeActive && stdin.isTTY) {
      try { stdin.setRawMode(false) } catch {}
    }
    rawModeActive = false

    if (stdinEmitPatched) {
      stdin.emit = originalStdinEmit
      stdinEmitPatched = false
    }
    for (const decoder of decoders) decoder.reset()

    if (frameActive) {
      frameActive = false
      // 退备用屏失败也要继续往下走 —— 后面还有 pause 要做
      try { stopFrame(features) } catch {}
    }
    if (pauseInput) {
      // readline 的 keypress 解码器会一直挂着一个 data 监听器，不 pause
      // 就一直引用着 TTY handle，进程永远不退出
      try { stdin.pause() } catch {}
    }
  }

  function activate({ repaint: shouldRepaint = false } = {}) {
    if (isDisposed() || frameActive) return false
    suspended = true
    try {
      startFrame(features)
      frameActive = true
      if (!keypressDecoderStarted) {
        emitKeypressEvents(stdin, { escapeCodeTimeout: keypressEscapeTimeoutMs })
        keypressDecoderStarted = true
      }
      stdin.emit = interceptStdinEmit
      stdinEmitPatched = true
      if (stdin.isTTY) {
        stdin.setRawMode(true)
        rawModeActive = true
      }
      attachInputListeners()
      stdin.resume()
      suspended = false
      if (shouldRepaint) repaint()
      return true
    } catch (error) {
      // 半途失败会留下原始模式或备用屏 —— 必须回滚干净再抛
      deactivate({ pauseInput: true })
      throw error
    }
  }

  /**
   * 把终端暂时还给一个 cooked 模式的提示（向导、引导流程）。
   *
   * 期间不能让定时器、resize、提示或事件回调画到它上面 —— 所以先整个停掉。
   */
  async function withSuspended(fn, { onResume } = {}) {
    deactivate()
    try {
      return await fn()
    } finally {
      // 借出期间可能收到终止信号、外层 REPL 已经结束了。绝不能把 TUI 复活。
      if (!isDisposed() && activate({ repaint: true }) && onResume) onResume()
    }
  }

  /** Ctrl+Z 的前半：恢复终端状态，再把信号按默认行为重发。 */
  function suspendForJobControl({ beforeSuspend } = {}) {
    if (isDisposed() || jobControlSuspended || platform === "win32") return false
    jobControlSuspended = true
    resumeFrameAfterContinue = frameActive
    if (beforeSuspend) beforeSuspend()
    deactivate({ pauseInput: true })

    // 先摘掉自己的处理器，否则重发的信号又会被自己接住
    if (onSuspendSignal) process.removeListener("SIGTSTP", onSuspendSignal)
    try {
      process.kill(process.pid, "SIGTSTP")
    } catch {
      // 发不出去就当场恢复，否则界面停在拆掉的状态回不来
      continueAfterJobControl()
    }
    return true
  }

  /** Ctrl+Z 的后半：SIGCONT 回来，重新进备用屏。 */
  function continueAfterJobControl() {
    if (!jobControlSuspended) return false
    jobControlSuspended = false
    if (onSuspendSignal && platform !== "win32") {
      process.on("SIGTSTP", onSuspendSignal)
    }
    const resumed = !isDisposed() && resumeFrameAfterContinue && activate({ repaint: true })
    if (resumed && onResumeRequested) onResumeRequested()
    resumeFrameAfterContinue = false
    return resumed
  }

  return {
    activate,
    deactivate,
    withSuspended,
    suspendForJobControl,
    continueAfterJobControl,
    /**
     * 登记作业控制的信号处理器。挂载与摘除由 suspend/continue 自己管 ——
     * 它们是**有意反复装卸**的，所以不进监听器登记本。
     */
    registerJobControlHandlers({ onSuspend, onResume }) {
      onSuspendSignal = onSuspend
      onResumeRequested = onResume
    },
    isSuspended: () => suspended,
    isFrameActive: () => frameActive,
    isJobControlSuspended: () => jobControlSuspended
  }
}
