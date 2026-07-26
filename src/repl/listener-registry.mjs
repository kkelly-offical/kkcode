/**
 * 事件监听器的登记与释放：挂上就登记好怎么摘。
 *
 * ## 为什么需要它
 *
 * REPL 退出时要摘掉八个进程级监听器（resize、SIGINT、SIGTERM、SIGHUP、
 * SIGBREAK、SIGTSTP、SIGCONT、exit）。此前挂载散在四处，释放集中在 `finally`
 * 里写成十行 `if (onX) removeListener(...)`，还带 win32/posix 分支：
 *
 *     if (onResize) process.stdout.removeListener("resize", onResize)
 *     if (onSigint) process.removeListener("SIGINT", onSigint)
 *     if (onTerminate) {
 *       process.removeListener("SIGTERM", onTerminate)
 *       process.removeListener("SIGHUP", onTerminate)
 *     }
 *     …
 *
 * 一份手写清单，必须和另一处的挂载保持同步。加一个监听器时最自然的疏忽就是
 * 忘了加对应的移除 —— 而漏掉的后果是进程不退出，或者退出后仍在响应信号。
 * 这和「补全目录与命令分发是两份清单」是同一种形状的问题。
 *
 * 登记之后，释放不再是清单，而是把登记本倒着走一遍。
 *
 * ## 不该用它的地方
 *
 * 反复开关的监听器（keypress / data 随终端激活与挂起来回装卸）不属于这里 ——
 * 它们的生命周期是「多次」，而这个登记本的语义是「挂一次、退出时摘一次」。
 * 把它们混进来会在第二次挂载时留下一个失效的释放项。
 */

export function createListenerRegistry() {
  const disposers = []

  /**
   * 挂一个监听器，同时登记它的移除。
   * @returns {Function} 单独提前释放它的函数（幂等）
   */
  function on(target, event, handler) {
    if (!handler) return () => {}
    target.on(event, handler)
    let released = false
    const dispose = () => {
      if (released) return
      released = true
      target.removeListener(event, handler)
    }
    disposers.push(dispose)
    return dispose
  }

  /**
   * 登记一个**不是监听器**的清理动作（终端标题恢复、定时器、外部资源）。
   *
   * 它们的生命周期与监听器完全一致 —— 建一次、退出时收一次 —— 所以走同一个
   * 登记本。退出路径有正常与异常两条，各写一份清理清单正是 0.6.20 修掉的那个
   * 缺陷：加东西时最自然的疏忽就是只往其中一条里加。
   *
   * @returns {Function} 单独提前释放它的函数（幂等）
   */
  function add(dispose) {
    if (typeof dispose !== "function") return () => {}
    let released = false
    const wrapped = () => {
      if (released) return
      released = true
      dispose()
    }
    disposers.push(wrapped)
    return wrapped
  }

  /** 倒序释放所有登记项。倒序是为了后挂的先摘，与挂载顺序对称。 */
  function disposeAll() {
    while (disposers.length) {
      const dispose = disposers.pop()
      // 一个释放失败不该拖住其余的 —— 退出路径上必须尽力摘干净
      try { dispose() } catch { /* 忽略 */ }
    }
  }

  return { on, add, disposeAll, size: () => disposers.length }
}
