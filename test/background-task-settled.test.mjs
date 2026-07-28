import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BackgroundManager } from "../src/orchestration/background-manager.mjs"
import { EventBus } from "../src/core/events.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"

/**
 * 后台任务的终态广播（0.8.0）。
 *
 * 此前后台任务完成时**只有一个模块私有的 EventEmitter** 知道这件事，而它的
 * 三个消费者全是一次性 await。界面、通知、主代理都够不着 —— 任务跑完了没有
 * 任何人会知道，除非用户自己去 /background 查。
 *
 * 这里钉的是广播本身：什么时候发、发什么、发几次。
 */

let home = ""

beforeEach(async () => {
  // 后台任务的 checkpoint 落在 userRootDir() 下 —— 不隔离 HOME 的话，
  // 测试会往用户真实的 .kkcode 里写任务文件。
  home = await mkdtemp(join(tmpdir(), "kkcode-task-settled-"))
  process.env.KKCODE_HOME = home
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

/** 收集 TASK_SETTLED，返回收集器与退订函数。用完必须退订，否则监听器跨用例泄漏。 */
function collectSettled() {
  const events = []
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.type === EVENT_TYPES.TASK_SETTLED) events.push(event)
  })
  return { events, unsubscribe }
}

test("任务完成时向全局总线广播一次，载荷够主代理直接读", async () => {
  const { events, unsubscribe } = collectSettled()
  try {
    const task = await BackgroundManager.launch({
      description: "整理依赖清单",
      payload: { parentSessionId: "ses_parent", subSessionId: "ses_child", subagent: "explorer" },
      config: {},
      run: async () => ({ reply: "找到 3 个未使用的依赖" })
    })
    const settled = await BackgroundManager.waitForTask(task.id, { timeoutMs: 2000, tickMs: 20 })
    assert.equal(settled.status, "completed")

    assert.equal(events.length, 1, `应当恰好广播一次，实际 ${events.length} 次`)
    const payload = events[0].payload
    assert.equal(payload.id, task.id)
    assert.equal(payload.status, "completed")
    assert.equal(payload.description, "整理依赖清单")
    // 摘要是唤醒消息里唯一带信息量的部分 —— 没有它，主代理只知道「有事完成了」
    assert.match(payload.resultPreview, /未使用的依赖/)
    assert.equal(payload.subagent, "explorer")
    assert.equal(payload.subSessionId, "ses_child")
    // 归属：后台任务自己的子会话对界面没意义，等结果的是父会话
    assert.equal(events[0].sessionId, "ses_parent")
  } finally {
    unsubscribe()
  }
})

test("失败也要广播 —— 主代理最需要知道的恰恰是这种", async () => {
  const { events, unsubscribe } = collectSettled()
  try {
    const task = await BackgroundManager.launch({
      description: "跑集成测试",
      payload: {},
      config: {},
      run: async () => { throw new Error("EACCES: 打不开 /etc/shadow") }
    })
    await BackgroundManager.waitForTask(task.id, { timeoutMs: 2000, tickMs: 20 })

    assert.equal(events.length, 1)
    assert.equal(events[0].payload.status, "error")
    assert.match(events[0].payload.resultPreview, /EACCES/)
  } finally {
    unsubscribe()
  }
})

test("只有跨入终态才广播：pending 与 running 一声不吭", async () => {
  const { events, unsubscribe } = collectSettled()
  try {
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const task = await BackgroundManager.launch({
      description: "慢任务",
      payload: {},
      config: {},
      run: async ({ log }) => {
        // running + 一条日志：两次 patchTask，两次都不是终态跨越
        await log("still working")
        await gate
        return { reply: "done" }
      }
    })
    // 让 run 至少推进到 log 之后
    for (let i = 0; i < 20 && (await BackgroundManager.get(task.id))?.status !== "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(events, [], "任务还在跑，不该有任何终态广播")

    release()
    await BackgroundManager.waitForTask(task.id, { timeoutMs: 2000, tickMs: 20 })
    assert.equal(events.length, 1)
    assert.equal(events[0].payload.status, "completed")
  } finally {
    unsubscribe()
  }
})

test("重试是同一个 id 的第二次生命，它的结果也必须叫醒主代理", async () => {
  // 去重键只用 id 的话，这里第二次落地会被静默吞掉 —— 用户重试了一个后台任务，
  // 然后再也等不到任何消息。
  const { events, unsubscribe } = collectSettled()
  try {
    const task = await BackgroundManager.launch({
      description: "会失败一次的任务",
      payload: {},
      config: {},
      run: async () => { throw new Error("first attempt failed") }
    })
    await BackgroundManager.waitForTask(task.id, { timeoutMs: 2000, tickMs: 20 })
    assert.equal(events.length, 1)
    assert.equal(events[0].payload.attempt, 1)

    // retry 把它打回 pending。inline 任务不会被 startPendingTasks 重新拉起
    // （那只管 worker_process），所以这里用 cancel 制造第二次终态跨越。
    const retried = await BackgroundManager.retry(task.id, {})
    assert.equal(retried.status, "pending")
    assert.equal(retried.attempt, 2)
    assert.equal(events.length, 1, "回到 pending 不是终态，不该广播")

    await BackgroundManager.cancel(task.id)
    assert.equal(events.length, 2, "第二次落地必须重新广播")
    assert.equal(events[1].payload.status, "cancelled")
    assert.equal(events[1].payload.attempt, 2)
  } finally {
    unsubscribe()
  }
})
