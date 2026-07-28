/**
 * 后台任务完成后的唤醒：替用户把回送发出去。
 *
 * ## 这是什么
 *
 * 后台任务（`task` 工具的 `run_in_background`）跑在独立子进程里。它落地时
 * `BackgroundManager` 会往 EventBus 发一条 `task.settled`，事件桥把结果整理成一段
 * 文本交给 `outbox.pushSystemPrompt`。回合还在跑时那条文本进 steer 队列，下一个
 * step 边界就注入；**空闲**时没有任何人会替用户按下 Enter —— 那正是这个模块。
 *
 * ## 为什么是一个模块而不是 startTuiRepl 里的几行
 *
 * 与 prompt-outbox 的 `drain` 当初被抽出去是同一条理由：`startTuiRepl` 被结构守卫
 * 的棘轮盯着（判定点只减不增），而这里全是判定 —— 六个「现在能不能自动提交」的
 * 条件。第一版写在闭包里，判定点从 189 涨到 191，两条棘轮当场就红了。
 *
 * 而这段逻辑本来就不依赖那个闭包里的任何东西：它只需要「现在是什么状态」和
 * 「怎么发一条」。
 *
 * ## 判定的分量
 *
 * 这是全 REPL 唯一一处**不经用户按键就开启新回合**的路径。判错的代价不是少画
 * 一帧，是把用户写了一半的话当成提问发给模型。所以每个条件都单独一行、单独一
 * 条测试，宁可少唤醒一次。
 */

/**
 * @param {object} deps
 * @param {object} deps.ui                      REPL 的 UI 状态（读 busy / input / paused / 模态位）
 * @param {object} deps.outbox                  prompt-outbox 实例，提供 drain 与 clear
 * @param {(text: string) => Promise<void>} deps.submitOne  把一条文本当作一个回合发出去
 * @param {{add: (dispose: Function) => Function}} [deps.listeners] 监听器登记本；传了就自己登记退出清理
 * @param {() => boolean} [deps.isBlocked]      宿主说「现在别动」（REPL 已 dispose）
 */
export function createTaskWake({
  ui,
  outbox,
  submitOne,
  listeners = null,
  isBlocked = () => false
}) {
  let enabled = true
  let draining = false

  /**
   * 把队列排干。与用户按 Enter 的 `submitAndDrain` 的差别只有一处：
   * **不提交输入框**。提交路径会把 `ui.input` 当成这一轮的内容发出去，而唤醒
   * 到达时那里可能正躺着用户写了一半的话。
   *
   * @returns {Promise<boolean>} 真的排了没有
   */
  async function drain() {
    if (!enabled || draining || isBlocked()) return false
    // 回合在跑时不该走这条路 —— 那时后台结果已经进 steer 队列了
    if (ui.busy) return false
    // 有草稿就不排。消息留在队列里不会丢：用户下一次按 Enter，submitAndDrain
    // 会把排着的一起带走。提示与通知已经发过了，他知道有东西在等。
    if (String(ui.input || "").trim()) return false
    // 权限审批与提问是先来后到 —— 有模态在等人时，先让人把那个答完
    if (ui.pendingPermission || ui.pendingQuestion) return false
    draining = true
    try {
      await outbox.drain(async (text) => {
        // 按过 Esc、或者 REPL 已经在收摊：剩下的都不该再发出去
        if (ui.paused || !enabled || isBlocked()) {
          outbox.clear()
          return
        }
        await submitOne(text)
      })
    } finally {
      draining = false
    }
    return true
  }

  /** 退出时调用。迟到的后台任务终态会一路走到这里，不能让它再开一个新回合。 */
  function dispose() {
    enabled = false
  }

  // 走登记本而不是让调用方再写一行 —— 退出路径有正常与异常两条，各写一份清理
  // 清单正是 0.6.20 修掉的那个缺陷。
  listeners?.add(dispose)

  return { drain, dispose, isEnabled: () => enabled }
}
