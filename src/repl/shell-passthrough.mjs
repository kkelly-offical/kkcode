import { spawn as nodeSpawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { stripAnsi } from "./frame-primitives.mjs"
import { paint } from "../theme/color.mjs"

/**
 * `!` 前缀 shell 直通的执行器。
 *
 * 语义：用户敲 `!npm test` 不是在请求模型做什么，而是**自己跑了一条命令**。
 * 所以这里没有审批（用户对自己的键盘有权限），但结果要进会话上下文 —— 否则
 * 下一轮模型看不见「测试刚跑过、这三条挂了」，用户还得手动复述一遍。
 *
 * 两个产物是两件事，不要合并：
 *
 *   formatForTranscript  给人看，进 TUI 对话区，**保留颜色**（`npm test` 的
 *                        红绿是有信息量的）
 *   formatForContext     给模型看，进会话历史，**剥掉一切转义**（色码和进度条
 *                        回车只是 token 消耗，模型读到的 "ESC[32m" 不比
 *                        "PASS" 多告诉它任何事）
 *
 * 三条容易被想当然的行为，都是刻意的：
 *
 *   1. stdin 关成 /dev/null。于是 `!vim` 会立刻退出而不是把 TUI 挂死 —— 交互
 *      式程序在这里没法用，让它快速失败比让用户去别的终端 kill 掉好。
 *   2. 截断从**中间**截。报错在尾部（栈、summary），回显在头部（命令、配置），
 *      只留头部的话就是把最想看的那段扔了。
 *   3. 超时后**保留已产出的输出**。「跑了 30 秒被杀掉」和「跑了 30 秒什么都没
 *      输出」是完全不同的诊断，丢掉输出就分不出来。
 */

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_CHARS = 10_000

/** SIGTERM 之后等多久再 SIGKILL。给「收到信号后清理临时文件」留出的窗口。 */
const DEFAULT_KILL_GRACE_MS = 2_000

/** 进程 exit 之后再等一小会儿收管道里的余量，close 若已到就不等。 */
const EXIT_DRAIN_MS = 200

/** 截断时头部占的比例，其余给尾部。 */
const HEAD_RATIO = 0.6

const CONTEXT_TAG = "user-ran-shell-command"

/**
 * 平台分流。**抽成纯函数并导出，是因为这个仓库在 Windows 分歧上栽过六次** ——
 * 分流逻辑埋在 spawn 调用里的话，Linux 上的测试永远覆盖不到那一半。
 *
 * 两处分歧：
 *
 *   shell     POSIX 用 `/bin/sh -c`；win32 用 cmd 的 `/d /s /c`（等价于 Node
 *             自己 `shell: true` 的实现：/d 跳过 AutoRun，/s 处理引号，/c 执行后退出）
 *   detached  POSIX 开着，子进程成为进程组组长，超时才能用负 pid 连孙进程一起杀
 *             （`npm test` 真正干活的是它 fork 的 node）。win32 没有进程组这回事，
 *             detached 反而会给控制台程序开新窗口，所以关掉。
 */
export function buildSpawnPlan(command, { cwd, env, platform } = {}) {
  const shared = {
    cwd,
    env,
    windowsHide: true,
    // stdin 恒为 /dev/null：见文件头第 1 条
    stdio: ["ignore", "pipe", "pipe"]
  }
  if (platform === "win32") {
    return {
      file: env?.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
      options: { ...shared, detached: false }
    }
  }
  return {
    file: "/bin/sh",
    args: ["-c", command],
    options: { ...shared, detached: true }
  }
}

/**
 * 边收边截的输出槽。
 *
 * 不是「先全存下来最后 slice」：`npm run build` 刷几百兆日志时那样会把 REPL
 * 撑爆，而这些字节本来就注定要被扔掉。头部满了之后尾部是个滑动窗口，内存
 * 占用恒定在 maxOutputChars。
 */
function createOutputSink(maxOutputChars) {
  const budget = Math.max(0, Number(maxOutputChars) || 0)
  const headBudget = Math.floor(budget * HEAD_RATIO)
  const tailBudget = budget - headBudget
  let head = ""
  let tail = ""
  let dropped = 0

  return {
    push(text) {
      let rest = String(text || "")
      if (!rest) return
      const room = headBudget - head.length
      if (room > 0) {
        head += rest.slice(0, room)
        rest = rest.slice(room)
      }
      if (!rest) return
      tail += rest
      if (tail.length > tailBudget) {
        dropped += tail.length - tailBudget
        tail = tail.slice(tail.length - tailBudget)
      }
    },
    finish() {
      if (dropped === 0) return { output: head + tail, truncated: false }
      return { output: `${head}…[${dropped} chars truncated]…${tail}`, truncated: true }
    }
  }
}

/**
 * 把一条流喂进槽里。
 *
 * 用 StringDecoder 而不是 `chunk.toString()`：一个 UTF-8 汉字可能横跨两个
 * chunk，逐块 toString 会在边界上吐出替换字符。stdout/stderr 各自一个解码器
 * （两条独立字节流），但**写进同一个槽** —— 这就是「按到达顺序合流」：顺序
 * 由 data 事件到达的顺序决定，不做任何重排。
 */
function pipeInto(stream, sink) {
  if (!stream || typeof stream.on !== "function") return
  const decoder = new StringDecoder("utf8")
  stream.on("data", (chunk) => {
    sink.push(typeof chunk === "string" ? chunk : decoder.write(chunk))
  })
  stream.on("end", () => sink.push(decoder.end()))
  // 管道读失败（EPIPE 等）不该炸掉整次执行，已收到的输出仍然有价值
  stream.on("error", () => {})
}

/**
 * 杀掉子进程及其后代。
 *
 * POSIX：先试负 pid（整个进程组）。`npm test` 的活儿在它 fork 的 node 里，
 * 只杀 sh 的话孙进程会继续跑、还攥着管道不放，close 事件永远不来。组不存在
 * （进程已退出、或调用方注入的假 spawn 没有真 pid）时退回直接杀。
 *
 * win32：没有 SIGTERM/SIGKILL 之分，也没有负 pid —— TerminateProcess 是唯一
 * 手段，两级升级在这里退化成一次强杀。
 */
function signalChild(child, signal, platform) {
  if (platform === "win32") {
    try { child.kill() } catch { /* 已经死了 */ }
    return
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch { /* 组不在了，退回直接杀 */ }
  }
  try { child.kill(signal) } catch { /* 已经死了 */ }
}

function emptyResult() {
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    output: "",
    truncated: false,
    durationMs: 0,
    timedOut: false,
    error: null
  }
}

function failedResult(err, startedAt) {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    output: "",
    truncated: false,
    durationMs: Date.now() - startedAt,
    timedOut: false,
    error: err?.message || String(err)
  }
}

function waitForChild(child, ctx) {
  const { sink, startedAt, timeoutMs, killGraceMs, platform, abortSignal, setTimer, clearTimer } = ctx
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let error = null
    let exitCode = null
    let exitSignal = null
    const timers = new Set()

    // 一律 unref：真实运行里管道是 ref 的，unref 只保证「定时器不会成为进程
    // 退不出去的最后一根句柄」。
    //
    // 定时器本身**必须可注入**（默认全局 setTimeout）：注入假 spawn 的测试没有
    // 真句柄撑事件循环，unref 定时器在空循环里永远不触发 —— Node 22 的 test
    // runner 会当场判 "promise pending but event loop resolved"（Node 24 的
    // runner 自带常驻句柄，恰好掩盖了这一点：本地 24 全绿、CI 22 三格红）。
    // 测试注入不带 unref 的定时器即可撑住循环，形状与 render-scheduler 一致。
    const later = (fn, ms) => {
      const timer = setTimer(fn, ms)
      timer?.unref?.()
      timers.add(timer)
      return timer
    }

    const settle = () => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimer(timer)
      timers.clear()
      abortSignal?.removeEventListener?.("abort", onAbort)
      const { output, truncated } = sink.finish()
      resolve({
        ok: !error && !timedOut && exitCode === 0,
        exitCode,
        signal: exitSignal,
        output,
        truncated,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: error ? (error.message || String(error)) : null
      })
    }

    const escalateKill = () => {
      signalChild(child, "SIGTERM", platform)
      later(() => {
        signalChild(child, "SIGKILL", platform)
        // 最后的保险：SIGKILL 之后还等不到 close，说明有个改了自己进程组的
        // 孙进程攥着管道。宁可少收一点输出，也不能把用户的 REPL 卡死。
        later(settle, killGraceMs)
      }, killGraceMs)
    }

    // Ctrl-C 掐掉：和超时走同一套两级升级，但**不标 timedOut** —— 用户主动
    // 打断和「跑太久被系统杀掉」是两回事，状态行不该说谎
    function onAbort() {
      escalateKill()
    }

    pipeInto(child.stdout, sink)
    pipeInto(child.stderr, sink)

    child.on("error", (err) => {
      error = err
      settle()
    })
    child.on("exit", (code, sig) => {
      exitCode = code
      exitSignal = sig
      // exit 到了但 close 没到：管道还有余量，给一小会儿；close 先到就没这回事
      later(settle, EXIT_DRAIN_MS)
    })
    child.on("close", (code, sig) => {
      if (exitCode === null) exitCode = code
      if (!exitSignal) exitSignal = sig
      settle()
    })

    if (timeoutMs > 0) {
      later(() => {
        timedOut = true
        escalateKill()
      }, timeoutMs)
    }
    if (abortSignal) {
      if (abortSignal.aborted) onAbort()
      else abortSignal.addEventListener?.("abort", onAbort, { once: true })
    }
  })
}

/**
 * 本地执行一条 shell 命令，返回合流后的输出。永不抛：spawn 失败（ENOENT 等）
 * 折进 `{ ok: false, error }`，因为调用方在按键回调里，抛出去只会变成一次
 * 未捕获拒绝。
 *
 * @param {string} command 用户输入里 `!` 之后的部分
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs] 默认 30s；<=0 表示不设超时
 * @param {number} [options.maxOutputChars] 默认 10k，超出从中间截
 * @param {object} [options.env]
 * @param {Function} [options.spawn] 注入用，默认 node:child_process 的 spawn
 * @param {string} [options.platform] 注入用，默认 process.platform
 * @param {number} [options.killGraceMs] SIGTERM 到 SIGKILL 的间隔，默认 2s
 * @param {AbortSignal} [options.signal] 可选：用户 Ctrl-C 时提前掐掉
 * @returns {Promise<{ok:boolean,exitCode:?number,signal:?string,output:string,
 *   truncated:boolean,durationMs:number,timedOut:boolean,error:?string}>}
 */
export async function runShellPassthrough(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    env = process.env,
    spawn = nodeSpawn,
    platform = process.platform,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    signal: abortSignal = null,
    // 可注入的定时器（理由见 waitForChild 的 later）
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = options

  // 只敲了个 `!` 就回车：不 spawn（`sh -c ""` 会起一个进程只为立刻退出），
  // 也不进上下文 —— 告诉模型「用户运行了空命令」没有任何价值
  const line = String(command || "").trim()
  if (!line) return emptyResult()

  const plan = buildSpawnPlan(line, { cwd, env, platform })
  const sink = createOutputSink(maxOutputChars)
  const startedAt = Date.now()

  let child
  try {
    child = spawn(plan.file, plan.args, plan.options)
  } catch (err) {
    return failedResult(err, startedAt)
  }
  return await waitForChild(child, {
    sink, startedAt, timeoutMs, killGraceMs, platform, abortSignal, setTimer, clearTimer
  })
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0)
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(1)}s`
}

/**
 * 状态行。两个产物共用一份 —— 分开写的话，某天只有一边会记得反映截断。
 */
function statusLine(result) {
  const duration = formatDuration(result?.durationMs)
  const parts = []
  if (result?.error) parts.push(`failed to start: ${result.error}`)
  else if (result?.timedOut) parts.push(`timed out after ${duration}, process killed`)
  else if (result?.signal) parts.push(`killed by ${result.signal} after ${duration}`)
  else parts.push(`exit ${result?.exitCode ?? "?"} in ${duration}`)
  if (result?.truncated) parts.push("output truncated")
  return parts.join(", ")
}

/**
 * 折叠回车覆写。
 *
 * `npm install` / `pip` 的进度条是同一行反复用 `\r` 重画的：终端上你只看见
 * 最后一帧，但字节流里是几百份。剥 ANSI 不管这个（`\r` 不是转义序列），所以
 * 单独处理 —— 理由和剥色码完全一样，都是不让终端的绘制手段吃掉上下文预算。
 *
 * 先归一 CRLF：Windows 换行不是覆写，误当覆写会把整行内容吃掉。
 */
function collapseCarriageReturns(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
    .join("\n")
}

/**
 * 给 TUI 对话区。保留输出里的颜色 —— 用户就该看到 `npm test` 原本的红绿。
 * color 显式可关，测试才能断言配色（测试进程不是 TTY，paint 默认恒返回原文）。
 */
export function formatForTranscript(command, result, { color } = {}) {
  const line = String(command || "").trim()
  if (!line) return ""
  const enabled = color === undefined ? undefined : Boolean(color)
  const paintOptions = enabled === undefined ? {} : { enabled }
  const head = paint(`$ ${line}`, "cyan", { ...paintOptions, bold: true })
  const status = paint(`(${statusLine(result)})`, result?.ok ? null : "red",
    { ...paintOptions, dim: Boolean(result?.ok) })
  const body = String(result?.output || "").replace(/\s+$/, "")
  return [head, body, status].filter(Boolean).join("\n")
}

/**
 * 给会话历史。包在标签里，让模型能把这段和「工具调用的输出」区分开 ——
 * 这是**用户自己跑的**，不是它要求跑的，语义不同。
 *
 * 一切转义都在这里剥掉。
 */
export function formatForContext(command, result) {
  const line = stripAnsi(String(command || "")).trim()
  if (!line) return ""
  const body = collapseCarriageReturns(stripAnsi(String(result?.output || ""))).replace(/\s+$/, "")
  const parts = [`$ ${line}`]
  if (body) parts.push(body)
  parts.push(`(${statusLine(result)})`)
  return `<${CONTEXT_TAG}>\n${parts.join("\n")}\n</${CONTEXT_TAG}>`
}
