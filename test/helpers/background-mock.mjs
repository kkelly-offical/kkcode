import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { BackgroundManager } from "../../src/orchestration/background-manager.mjs"
import { writeJson } from "../../src/storage/json-store.mjs"
import { backgroundTaskCheckpointPath, ensureBackgroundTaskRuntimeDir } from "../../src/storage/paths.mjs"

/**
 * 把 H4 的后台任务执行拦在测试进程内。
 *
 * 不装这个 mock 的「端到端」测试是假的：background.mode 缺省是 worker_process，
 * 任务跑在**独立子进程**里，父进程 registerProvider 注册的 mock provider 对它
 * 完全不可见。子进程会回落到配置里的默认 provider，然后因为没有 API key 失败，
 * 而父进程这边照样把任务记成 completed —— 只要该任务没声明 plannedFiles，
 * remainingFiles 就是空的，没有任何东西可以校验。
 *
 * 于是测试断言到的 "completed" 对应的是一次**什么都没发生**的运行。
 */

let originalLaunch = null
let originalTick = null
let counter = 0

function now() { return Date.now() }

/**
 * @param {object} options
 * @param {string} options.reply            任务的回复文本
 * @param {boolean} options.completeFiles   是否把 plannedFiles 全部标记为已完成
 * @param {boolean} options.writeFiles      是否**真的写出** plannedFiles（默认写）。
 *   0.5.0 起目标核验会拿 stat / node --check 验证产物 —— 只声称完成而不写文件
 *   的 mock 会被判据当场揭穿，测试就该在那时失败而不是假装成功。
 * @param {(payload) => object|null} options.behavior  可选：按 payload 定制结果
 */
export function installBackgroundMock({ reply = "[TASK_COMPLETE] done", completeFiles = true, writeFiles = true, behavior = null } = {}) {
  if (originalLaunch) return
  originalLaunch = BackgroundManager.launchDelegateTask.bind(BackgroundManager)
  originalTick = BackgroundManager.tick.bind(BackgroundManager)

  BackgroundManager.launchDelegateTask = async ({ description, payload }) => {
    const id = `bg_mock_${++counter}`
    await ensureBackgroundTaskRuntimeDir()
    const task = {
      id, description, payload,
      status: "pending",
      createdAt: now(), updatedAt: now(), startedAt: null, endedAt: null,
      logs: [], result: null, error: null, cancelled: false,
      backgroundMode: "worker_process", workerPid: null, lastHeartbeatAt: null,
      attempt: Number(payload?.attempt || 1),
      resumeToken: `resume_${now()}`
    }
    await writeJson(backgroundTaskCheckpointPath(id), task)
    queueMicrotask(() => advance(id).catch(() => {}))
    return task
  }

  BackgroundManager.tick = async () => {}

  async function advance(id) {
    await new Promise((r) => setTimeout(r, 5))
    const task = await BackgroundManager.get(id)
    if (!task || task.status !== "pending") return

    await writeJson(backgroundTaskCheckpointPath(id), {
      ...task, status: "running", startedAt: now(), workerPid: process.pid,
      lastHeartbeatAt: now(), updatedAt: now()
    })
    await new Promise((r) => setTimeout(r, 5))

    const planned = task.payload?.plannedFiles || []
    if (writeFiles && completeFiles) {
      for (const file of planned) {
        const target = path.resolve(process.cwd(), file)
        try {
          await mkdir(path.dirname(target), { recursive: true })
          // 合法 JS，让 node --check 类判据能过；其它扩展名当纯文本也无害
          await writeFile(target, `// mock output for ${file}\nexport const ok = true\n`, "utf8")
        } catch { /* 写不了就让判据如实报失败 */ }
      }
    }
    const custom = behavior ? await behavior(task.payload) : null
    if (custom && custom.error) {
      await writeJson(backgroundTaskCheckpointPath(id), {
        ...task, status: "error", error: custom.error, endedAt: now(), updatedAt: now()
      })
      return
    }
    const result = custom || {
      reply,
      completed_files: completeFiles ? planned : [],
      remaining_files: completeFiles ? [] : planned,
      file_changes: (completeFiles ? planned : []).map((p) => ({ path: p, addedLines: 10, removedLines: 0 })),
      tool_events: planned.length,
      cost: 0
    }

    await writeJson(backgroundTaskCheckpointPath(id), {
      ...task, status: "completed", result, endedAt: now(), updatedAt: now()
    })
  }
}

export function restoreBackgroundMock() {
  if (originalLaunch) BackgroundManager.launchDelegateTask = originalLaunch
  if (originalTick) BackgroundManager.tick = originalTick
  originalLaunch = null
  originalTick = null
}
