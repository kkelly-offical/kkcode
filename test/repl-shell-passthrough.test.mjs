import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import {
  runShellPassthrough,
  buildSpawnPlan,
  formatForTranscript,
  formatForContext
} from "../src/repl/shell-passthrough.mjs"

/**
 * `!` 前缀 shell 直通。
 *
 * 这条路径的特殊之处：它**不走审批**（用户对自己的键盘有权限），所以护栏全在
 * 执行器自己身上 —— 超时杀不干净就是 REPL 卡死，输出截断截错地方就是把用户最
 * 想看的那段扔了，转义码没剥就是每条命令白烧几百 token。
 *
 * 主力是注入假 spawn（EventEmitter 模拟），因为要断言的多半是**时序**：
 * 两条流谁先到、SIGTERM 之后多久 SIGKILL。真进程给不了确定的时序。
 * 末尾几条真实冒烟守着「假模型没跑偏」。
 */

const ESC = String.fromCharCode(27)
const CR = String.fromCharCode(13)

/**
 * 假 spawn。
 *
 * 注意 child 故意**没有 pid** —— 真实实现在 POSIX 上会先试 `process.kill(-pid)`
 * 打整个进程组，拿一个编造的 pid 去做这件事等于在测试机上随机杀一个进程组
 * （pid 0 更糟：那是当前进程组）。没有 pid 就落到直接 kill 分支，信号照样可断言。
 * 进程组那一半由末尾的真实冒烟覆盖。
 */
function fakeSpawn() {
  const calls = []
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.signals = []
    child.kill = (signal) => {
      child.signals.push(signal === undefined ? null : signal)
      return true
    }
    calls.push({ file, args, options, child })
    return child
  }
  spawn.calls = calls
  return spawn
}

/** 起一次执行并拿到那个假 child（spawn 是同步调用的，所以调用后立刻就在）。 */
function start(command, options = {}) {
  const spawn = options.spawn || fakeSpawn()
  const promise = runShellPassthrough(command, { spawn, ...options })
  return { promise, spawn, child: spawn.calls[0]?.child }
}

/** 正常收尾：先 exit 再 close，跟真进程一样。 */
function finish(child, code = 0, signal = null) {
  child.emit("exit", code, signal)
  child.emit("close", code, signal)
}

// --- 合流：按到达顺序 ---

test("stdout and stderr merge in arrival order, not stream by stream", async () => {
  // 编译器的做法是 warning 走 stderr、进度走 stdout，两者交错才读得懂。
  // 分别缓冲再拼接的话，用户看到的是「所有正常输出，然后所有报错」——
  // 哪条报错对应哪一步就永远对不上了。
  const { promise, child } = start("build")
  child.stdout.emit("data", Buffer.from("compiling a\n"))
  child.stderr.emit("data", Buffer.from("warning in a\n"))
  child.stdout.emit("data", Buffer.from("compiling b\n"))
  child.stderr.emit("data", Buffer.from("warning in b\n"))
  finish(child, 0)
  const result = await promise
  assert.equal(result.output, "compiling a\nwarning in a\ncompiling b\nwarning in b\n")
})

test("a multi-byte character split across two chunks survives", async () => {
  // 逐块 chunk.toString() 会在 UTF-8 边界上吐替换字符。中文输出里这不是边缘情况。
  const bytes = Buffer.from("测试通过", "utf8")
  const { promise, child } = start("echo hi")
  child.stdout.emit("data", bytes.subarray(0, 5))
  child.stdout.emit("data", bytes.subarray(5))
  finish(child, 0)
  const result = await promise
  assert.equal(result.output, "测试通过")
})

// --- 截断：从中间截 ---

test("output over the cap keeps head and tail, dropping the middle", async () => {
  // 报错在尾部（栈、失败 summary），回显在头部（命令、配置）。只留头部 =
  // 恰好把用户敲这条命令想看的东西扔了。
  const head = "H".repeat(6000)
  const middle = "M".repeat(1000)
  const tail = "T".repeat(4000)
  const { promise, child } = start("noisy", { maxOutputChars: 10_000 })
  child.stdout.emit("data", Buffer.from(head + middle + tail))
  finish(child, 0)
  const result = await promise

  assert.equal(result.truncated, true)
  assert.equal(result.output, `${head}…[1000 chars truncated]…${tail}`)
  assert.ok(!result.output.includes("M"), "被丢掉的应该是中段")
})

test("exactly at the cap is not truncated, one over is", async () => {
  // 阈值两侧各一条：只测「远超」的话，差一错位（>= vs >）测不出来。
  const exact = start("exact", { maxOutputChars: 10_000 })
  exact.child.stdout.emit("data", Buffer.from("x".repeat(10_000)))
  finish(exact.child, 0)
  const atCap = await exact.promise
  assert.equal(atCap.truncated, false)
  assert.equal(atCap.output.length, 10_000)
  assert.ok(!atCap.output.includes("truncated"))

  const over = start("over", { maxOutputChars: 10_000 })
  over.child.stdout.emit("data", Buffer.from("x".repeat(10_001)))
  finish(over.child, 0)
  const overCap = await over.promise
  assert.equal(overCap.truncated, true)
  assert.ok(overCap.output.includes("…[1 chars truncated]…"))
})

test("truncation works across many small chunks, not just one big write", async () => {
  // 实现是边收边截（头部满了之后尾部是滑动窗口），内存不随输出增长。
  // 一次性大写入测不出滑动窗口的 off-by-one。
  const { promise, child } = start("stream", { maxOutputChars: 100 })
  for (let i = 0; i < 50; i += 1) child.stdout.emit("data", Buffer.from(`${i}`.padStart(8, "0")))
  finish(child, 0)
  const result = await promise

  assert.equal(result.truncated, true)
  assert.ok(result.output.startsWith("00000000"), "头部是最早的输出")
  assert.ok(result.output.endsWith("00000049"), "尾部是最新的输出")
  const dropped = Number(result.output.match(/\[(\d+) chars truncated\]/)[1])
  assert.equal(dropped, 50 * 8 - 100, "丢掉的字符数要对得上")
})

// --- 超时：两级升级 ---

test("a timeout escalates SIGTERM to SIGKILL when the process ignores it", async () => {
  // 只发 SIGTERM 的话，任何装了 SIGTERM 处理器又不退出的程序都能把 REPL 挂死。
  const { promise, child } = start("sleep 999", { timeoutMs: 20, killGraceMs: 20 })
  child.stdout.emit("data", Buffer.from("started\n"))
  // 故意不 emit exit/close：模拟无视信号的进程
  const result = await promise

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"], "先温和后强硬")
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)
  assert.equal(result.output, "started\n", "超时也要保留已产出的输出")
})

test("a process that dies on SIGTERM is not SIGKILLed", async () => {
  const { promise, child } = start("sleep 999", { timeoutMs: 20, killGraceMs: 200 })
  child.on("__term", () => {})
  setTimeout(() => finish(child, null, "SIGTERM"), 60)
  const result = await promise

  assert.deepEqual(child.signals, ["SIGTERM"], "已经死了就不该再补一刀")
  assert.equal(result.timedOut, true)
  assert.equal(result.signal, "SIGTERM")
})

test("an abort signal kills the command without claiming it timed out", async () => {
  // 契约之外的一个附加口子：用户 Ctrl-C 时得能提前掐掉，否则 `!sleep 300`
  // 要把 REPL 按满 30 秒超时。走同一套两级升级，但状态行不能说「超时」——
  // 「我按了 Ctrl-C」和「它跑太久被杀了」是两个不同的事实。
  const controller = new AbortController()
  const { promise, child } = start("sleep 300", { timeoutMs: 30_000, killGraceMs: 20, signal: controller.signal })
  child.stdout.emit("data", Buffer.from("working\n"))
  controller.abort()
  setTimeout(() => finish(child, null, "SIGTERM"), 10)
  const result = await promise

  assert.equal(child.signals[0], "SIGTERM")
  assert.equal(result.timedOut, false, "用户打断不是超时")
  assert.equal(result.ok, false)
  assert.equal(result.output, "working\n", "打断前的输出要保留")
})

test("output arriving before the timeout is kept, and duration is reported", async () => {
  const { promise, child } = start("slow", { timeoutMs: 30, killGraceMs: 10 })
  child.stdout.emit("data", Buffer.from("half done"))
  const result = await promise
  assert.equal(result.output, "half done")
  assert.ok(result.durationMs >= 30, `耗时应覆盖整个超时窗口，实际 ${result.durationMs}`)
})

// --- spawn 失败 ---

test("a spawn that throws is folded into a result, not thrown", async () => {
  // 调用方在按键回调里。抛出去只会变成一次未捕获拒绝，把 TUI 带走。
  const spawn = () => {
    const err = new Error("spawn /bin/sh ENOENT")
    err.code = "ENOENT"
    throw err
  }
  const result = await runShellPassthrough("anything", { spawn })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, null)
  assert.match(result.error, /ENOENT/)
  assert.equal(result.output, "")
})

test("an async error event is folded in too", async () => {
  // spawn 同步返回、稍后才 emit error（EACCES 常走这条），两条路都要接住
  const { promise, child } = start("anything")
  child.emit("error", new Error("EACCES: permission denied"))
  const result = await promise
  assert.equal(result.ok, false)
  assert.match(result.error, /EACCES/)
})

// --- 空命令 ---

test("an empty command never spawns anything", async () => {
  // 只敲了个 `!` 就回车。`sh -c ""` 会起一个进程只为立刻退出。
  const spawn = fakeSpawn()
  for (const command of ["", "   ", null, undefined]) {
    const result = await runShellPassthrough(command, { spawn })
    assert.equal(result.output, "")
    assert.equal(result.timedOut, false)
  }
  assert.equal(spawn.calls.length, 0, "一次都不该 spawn")
})

test("an empty command produces nothing to show and nothing to remember", () => {
  // 尤其是 context：告诉模型「用户运行了空命令」纯属噪音
  assert.equal(formatForTranscript("  ", { ok: true, exitCode: 0 }), "")
  assert.equal(formatForContext("  ", { ok: true, exitCode: 0 }), "")
})

// --- 平台分流 ---

test("posix runs the command through /bin/sh -c in its own process group", () => {
  const plan = buildSpawnPlan("npm test", { cwd: "/w", env: {}, platform: "linux" })
  assert.equal(plan.file, "/bin/sh")
  assert.deepEqual(plan.args, ["-c", "npm test"])
  assert.equal(plan.options.detached, true, "要成为进程组组长，超时才杀得掉孙进程")
})

test("win32 runs it through cmd and does not ask for a process group", () => {
  // 这个仓库在 Windows 分歧上栽过六次。分流抽成纯函数就是为了让它在 Linux 上可测。
  const plan = buildSpawnPlan("npm test", { cwd: "C:\\w", env: {}, platform: "win32" })
  assert.equal(plan.file, "cmd.exe")
  assert.deepEqual(plan.args, ["/d", "/s", "/c", "npm test"],
    "cmd 的三个开关：跳过 AutoRun、按字符串处理引号、执行后退出")
  assert.equal(plan.options.detached, false, "win32 没有进程组，detached 只会开新控制台窗口")
})

test("win32 honours ComSpec when the shell has been relocated", () => {
  const plan = buildSpawnPlan("dir", { cwd: ".", env: { ComSpec: "D:\\alt\\cmd.exe" }, platform: "win32" })
  assert.equal(plan.file, "D:\\alt\\cmd.exe")
})

test("the platform option actually reaches spawn", async () => {
  // 上面三条测的是纯函数。这条确认执行器真的用了它，而不是各算各的。
  const { promise, child, spawn } = start("dir", { platform: "win32" })
  finish(child, 0)
  await promise
  assert.equal(spawn.calls[0].file, "cmd.exe")
  assert.deepEqual(spawn.calls[0].args, ["/d", "/s", "/c", "dir"])
})

test("win32 kills without a signal name", async () => {
  // Windows 没有 SIGTERM/SIGKILL 之分，TerminateProcess 是唯一手段
  const { promise, child } = start("hang", { platform: "win32", timeoutMs: 20, killGraceMs: 20 })
  const result = await promise
  assert.deepEqual(child.signals, [null, null])
  assert.equal(result.timedOut, true)
})

// --- stdin ---

test("stdin is closed so interactive programs exit instead of hanging", async () => {
  // `!vim` 立刻退出是**对的**：交互式程序在这里没法用，让它快速失败比让用户
  // 去别的终端 kill 掉好。stdio[0] 一旦变成 pipe/inherit 就会挂死整个 TUI。
  const { promise, child, spawn } = start("cat")
  finish(child, 0)
  await promise
  assert.equal(spawn.calls[0].options.stdio[0], "ignore")
})

// --- 上下文产物 ---

const okResult = {
  ok: true, exitCode: 0, signal: null, output: "3 passing\n",
  truncated: false, durationMs: 3200, timedOut: false, error: null
}

test("the context block names the command, the exit code and the duration", () => {
  const text = formatForContext("npm test", okResult)
  assert.equal(text,
    "<user-ran-shell-command>\n" +
    "$ npm test\n" +
    "3 passing\n" +
    "(exit 0 in 3.2s)\n" +
    "</user-ran-shell-command>")
})

test("the context block strips colour codes", () => {
  // 模型读到 "[32m" 不会比读到 "PASS" 多懂任何事，只是每条命令白烧 token。
  const colored = { ...okResult, output: `${ESC}[32mPASS${ESC}[0m all green\n` }
  const text = formatForContext("npm test", colored)
  assert.ok(!text.includes(ESC), "上下文里不该有任何转义字节")
  assert.ok(text.includes("PASS all green"), "剥掉的是转义，不是内容")
})

test("the context block collapses carriage-return progress bars", () => {
  // npm/pip 的进度条是同一行反复重画的：终端上只见最后一帧，字节流里几百份。
  // 剥 ANSI 管不到这个（\r 不是转义序列）。
  const spinner = { ...okResult, output: `10%${CR}50%${CR}100% done\nnext line\n` }
  const text = formatForContext("npm i", spinner)
  assert.ok(text.includes("100% done"))
  assert.ok(!text.includes("10%"), "中间帧应该被覆写掉")
  assert.ok(text.includes("next line"), "换行不是覆写")
})

test("windows line endings are not mistaken for overwrites", () => {
  // CRLF 当成覆写的话，整行内容会被吃掉。这个仓库在 CRLF 上栽过。
  const crlf = { ...okResult, output: `first${CR}\nsecond${CR}\n` }
  const text = formatForContext("build", crlf)
  assert.ok(text.includes("first"), "CRLF 的行首内容不能被吃掉")
  assert.ok(text.includes("second"))
})

test("truncation and timeout show up in the status line", () => {
  const truncated = formatForContext("cat big.log", { ...okResult, truncated: true })
  assert.ok(truncated.includes("output truncated"),
    "不说的话模型会把截断处的半行当成真实输出去推理")

  const timedOut = formatForContext("sleep 99", {
    ...okResult, ok: false, exitCode: null, timedOut: true, durationMs: 30_000
  })
  assert.ok(timedOut.includes("timed out after 30.0s"))
  assert.ok(timedOut.includes("process killed"))
})

test("a non-zero exit is visible in the status line", () => {
  const failed = formatForContext("npm test", {
    ...okResult, ok: false, exitCode: 1, output: "1 failing\n", durationMs: 900
  })
  assert.ok(failed.includes("(exit 1 in 900ms)"))
})

test("a command with no output still produces a status line", () => {
  const quiet = formatForContext("true", { ...okResult, output: "" })
  assert.equal(quiet,
    "<user-ran-shell-command>\n$ true\n(exit 0 in 3.2s)\n</user-ran-shell-command>")
})

// --- 两个产物是两件事 ---

test("the transcript may carry colour, the context never does", () => {
  // 合并成一个产物是很自然的想法，然后就会二选一：要么对话区变成灰的，
  // 要么每条命令往上下文里塞几百个色码字节。
  const colored = { ...okResult, output: `${ESC}[32mPASS${ESC}[0m\n` }
  const transcript = formatForTranscript("npm test", colored, { color: true })
  const context = formatForContext("npm test", colored)

  assert.ok(transcript.includes(ESC), "对话区该看到 npm test 原本的红绿")
  assert.ok(!context.includes(ESC))
  assert.notEqual(transcript, context)
  assert.ok(!transcript.includes("<user-ran-shell-command>"), "标签是给模型的，不该出现在屏幕上")
})

test("the transcript echoes the command and its outcome", () => {
  const text = formatForTranscript("npm test", okResult, { color: false })
  assert.equal(text, "$ npm test\n3 passing\n(exit 0 in 3.2s)")
})

test("a colour-free transcript has no escapes at all", () => {
  const text = formatForTranscript("npm test", { ...okResult, ok: false, exitCode: 1 }, { color: false })
  assert.ok(!text.includes(ESC))
  assert.ok(text.includes("(exit 1 in 3.2s)"))
})

// --- 真实冒烟：假 spawn 骗不了这几条 ---

test("smoke: a real command runs and its output comes back", async () => {
  const result = await runShellPassthrough("echo hello from shell", { timeoutMs: 5000 })
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.equal(result.output.trim(), "hello from shell")
  assert.equal(result.truncated, false)
})

test("smoke: stderr comes back merged, and a non-zero exit is reported", async () => {
  const result = await runShellPassthrough("echo out; echo err 1>&2; exit 3", { timeoutMs: 5000 })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 3)
  assert.ok(result.output.includes("out"), "stdout 要在")
  assert.ok(result.output.includes("err"), "stderr 也要在")
})

test("smoke: a real timeout kills the process group and keeps what was printed", async () => {
  // 这条覆盖假 spawn 覆盖不到的那一半：POSIX 上的负 pid 进程组杀。
  // `sleep` 是 sh 的子进程，只杀 sh 的话它会继续跑、攥着管道不放，close 永远不来。
  const started = Date.now()
  const result = await runShellPassthrough("echo before sleeping; sleep 30", {
    timeoutMs: 300, killGraceMs: 100
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)
  assert.ok(result.output.includes("before sleeping"), "超时前的输出要保留")
  assert.ok(Date.now() - started < 5000, `不该等满 30 秒，实际 ${Date.now() - started}ms`)
})

test("smoke: a program that reads stdin gets EOF instead of hanging", async () => {
  // `cat` 无参数会一直读 stdin。stdin 若不是 /dev/null，这条会跑满超时。
  const started = Date.now()
  const result = await runShellPassthrough("cat", { timeoutMs: 4000 })
  assert.equal(result.timedOut, false, "stdin 应该立刻 EOF")
  assert.equal(result.exitCode, 0)
  assert.ok(Date.now() - started < 3000)
})

test("smoke: cwd is respected", async () => {
  const result = await runShellPassthrough("pwd", { cwd: "/", timeoutMs: 5000 })
  assert.equal(result.output.trim(), "/")
})
