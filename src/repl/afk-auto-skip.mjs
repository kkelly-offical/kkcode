/**
 * AFK 提问打发：挂机时提问不再无限期堵着（0.8.1）。
 *
 * ## 问题
 *
 * 模型的提问（question prompt）是模态的、挂着一个未 settle 的 Promise。
 * 用户在场时这是对的 —— 问题就该等人答；但**挂机**时它变成了死锁：
 * 一个长任务跑到一半模型问了句「要不要连测试一起改？」，用户吃饭去了，
 * 回来发现整个回合在那个浮层上停了四十分钟。通知（notify）只能把人叫回来，
 * 叫不回来的时候得有人替他把问题打发掉。
 *
 * ## 三条纪律
 *
 * 1. **只打发提问，绝不碰权限审批。** 权限是安全决策：自动批是放权，自动拒
 *    会把回合搞坏一半 —— 两个方向都不该由计时器做。审批一直等着，fail-closed。
 * 2. **打发 = 跳过，不是编造答案。** 走 resolveQuestionPrompt 的既有路径，
 *    未答的问题按 QUESTION_SKIPPED 返回 —— 模型知道「用户没答」，
 *    自己拿主意继续，这正是 AFK 语义想要的。
 * 3. **任何按键都算「人在」。** noteActivity 由按键分发入口调用，每次都把
 *    计时器拨回起点 —— 盯着选项想十分钟的人不会被打发（他一定按过方向键）。
 *
 * ## 为什么是独立模块
 *
 * 与 task-wake 同一条理由：startTuiRepl 被判定点棘轮盯着，而这里的每个
 * 条件都只依赖显式传入的东西。计时器可注入 —— Node 22 的 unref 之课：
 * 实现方会对返回句柄调 `?.unref?.()`，测试注入的假句柄别带 unref。
 */

/**
 * @param {object} p
 * @param {object} p.ui                      读 pendingQuestion / pendingPermission
 * @param {number} [p.timeoutMs]             0 或负数 = 整个功能关闭
 * @param {() => void} p.resolveQuestionPrompt  按「跳过」语义结掉当前提问
 * @param {Function} [p.showToast]
 * @param {Function} [p.appendLog]           上屏一行说明 —— 用户回来得知道发生过什么
 * @param {{add: (dispose: Function) => Function}} [p.listeners]
 * @param {Function} [p.setTimer]            可注入（测试与 Node 版本差异）
 * @param {Function} [p.clearTimer]
 */
export function createAfkAutoSkip({
  ui,
  timeoutMs = 600_000,
  resolveQuestionPrompt,
  showToast = null,
  appendLog = null,
  listeners = null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle)
}) {
  const enabled = Number(timeoutMs) > 0
  let handle = null
  let disposed = false

  function disarm() {
    if (handle !== null) {
      clearTimer(handle)
      handle = null
    }
  }

  /** 重新起表。没有挂起的提问就不起 —— 空转的计时器只会带来假唤醒。 */
  function arm() {
    disarm()
    if (!enabled || disposed || !ui.pendingQuestion) return
    handle = setTimer(fire, timeoutMs)
    // 不能让一个「以防用户挂机」的计时器反过来拖住进程退出
    handle?.unref?.()
  }

  function fire() {
    handle = null
    if (disposed || !ui.pendingQuestion) return
    const seconds = Math.round(timeoutMs / 1000)
    appendLog?.(`⏲ ${seconds}s 无人应答 · 提问已按「跳过」处理（AFK）`, { kind: "system" })
    showToast?.("AFK 超时 · 提问已跳过，模型自行继续", { topic: "question", tone: "warn" })
    // 既有路径：未答的问题按 QUESTION_SKIPPED 返回，队列里的下一个会被激活 ——
    // prompt-queue 激活时会再叫 questionShown，表在那里重新起
    resolveQuestionPrompt()
  }

  /** 按键分发入口每键调用一次：人在，表回拨。 */
  function noteActivity() {
    if (!enabled || disposed) return
    if (ui.pendingQuestion) arm()
    else disarm()
  }

  /** prompt-queue 在提问变为当前项时调用。 */
  function questionShown() {
    arm()
  }

  /** prompt-queue 在没有提问挂起时调用。 */
  function questionSettled() {
    if (!ui.pendingQuestion) disarm()
  }

  function dispose() {
    disposed = true
    disarm()
  }

  listeners?.add(dispose)

  return { noteActivity, questionShown, questionSettled, dispose, isArmed: () => handle !== null }
}
