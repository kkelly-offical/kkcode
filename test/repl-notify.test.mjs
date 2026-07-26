import test from "node:test"
import assert from "node:assert/strict"
import {
  createNotifier,
  sanitizeTitle,
  wrapTitleSequence,
  describeAlert,
  desktopCommand,
  resolveDesktopMode
} from "../src/repl/notify.mjs"

/**
 * 通知模块的三条通道：终端标题、响铃、桌面通知。
 *
 * 全部靠注入的假 stdout / spawn / env / platform 来测 —— 这个文件跑完不会起任何
 * 进程，也不会往真的 process.stdout 写一个字节。断言尽量写成整串相等：标题这条
 * 通道的正确性就是「写出去的字节序列一模一样」，用 includes 断言等于没断言。
 */

const ESC = "\x1b"
const BEL = "\x07"

function fakeStdout({ isTTY = true } = {}) {
  const writes = []
  return {
    isTTY,
    write(text) { writes.push(String(text)); return true },
    writes,
    all: () => writes.join("")
  }
}

function fakeSpawn({ throwEnoent = false } = {}) {
  const calls = []
  const children = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    if (throwEnoent) {
      const error = new Error(`spawn ${command} ENOENT`)
      error.code = "ENOENT"
      throw error
    }
    const handlers = new Map()
    const child = {
      unrefs: 0,
      kills: 0,
      once(event, fn) { handlers.set(event, fn); return child },
      unref() { child.unrefs += 1 },
      kill() { child.kills += 1 },
      has: (event) => handlers.has(event),
      emit(event, ...args) { handlers.get(event)?.(...args) }
    }
    children.push(child)
    return child
  }
  return { spawn, calls, children }
}

function fakeTimers() {
  const live = new Map()
  let nextId = 1
  return {
    setTimer(fn, ms) {
      const handle = { id: nextId++, ms, fn, unrefs: 0, unref() { handle.unrefs += 1; return handle } }
      live.set(handle.id, handle)
      return handle
    },
    clearTimer(handle) { if (handle) live.delete(handle.id) },
    pending: () => [...live.values()],
    fire() {
      const list = [...live.values()]
      live.clear()
      for (const handle of list) handle.fn()
      return list.length
    }
  }
}

function makeNotifier({
  notify = {},
  env = {},
  isTTY = true,
  platform = "linux",
  spawnOptions = {}
} = {}) {
  const stdout = fakeStdout({ isTTY })
  const spawner = fakeSpawn(spawnOptions)
  const timers = fakeTimers()
  const notifier = createNotifier({
    config: { ui: { notify } },
    env: { TERM: "xterm-256color", ...env },
    stdout,
    spawn: spawner.spawn,
    platform,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })
  return { notifier, stdout, spawner, timers }
}

/** 失焦 + 只留桌面通道，用来单独观察 spawn。 */
function makeDesktopOnly(patch = {}) {
  const made = makeNotifier({ notify: { title: false, ...(patch.notify || {}) }, ...patch })
  made.notifier.setFocused(false)
  return made
}

// --- 通道一：终端标题的字节序列 ---

test("普通终端下写出的就是 OSC 2 + BEL，一个字节不多", () => {
  const { notifier, stdout } = makeNotifier()
  notifier.setTitle("hello")
  assert.equal(stdout.writes.length, 1)
  assert.equal(stdout.all(), `${ESC}]2;hello${BEL}`)
  // 同一件事再用十六进制核一遍：ESC ] 2 ; h e l l o BEL
  assert.equal(Buffer.from(stdout.all(), "utf8").toString("hex"), "1b5d323b68656c6c6f07")
})

test("tmux 下裸序列照发，另外补一条 ESC 加倍的 DCS passthrough", () => {
  const { notifier, stdout } = makeNotifier({ env: { TMUX: "/tmp/tmux-1000/default,7,0" } })
  notifier.setTitle("hi")
  const bare = `${ESC}]2;hi${BEL}`
  // tmux 的 passthrough 要求载荷里每个 ESC 写两遍：本机 tmux 3.2a 实测，外层 pty
  // 上收到的正是解包后的 `ESC ] 2 ; hi BEL`。
  assert.equal(stdout.all(), `${bare}${ESC}Ptmux;${ESC}${ESC}]2;hi${BEL}${ESC}\\`)
})

test("screen 下用 ESC P … ESC \\ 包一层，载荷里的 ESC 不加倍", () => {
  const { notifier, stdout } = makeNotifier({ env: { TERM: "screen.xterm-256color" } })
  notifier.setTitle("hi")
  const bare = `${ESC}]2;hi${BEL}`
  assert.equal(stdout.all(), `${bare}${ESC}P${ESC}]2;hi${BEL}${ESC}\\`)
})

test("tmux 里 TERM 也是 screen*，此时按 tmux 包而不是按 screen 包", () => {
  // 顺序搞反的话，tmux 会把没加倍的 ESC 当成自己的序列 —— 这条守着分支顺序。
  const wrapped = wrapTitleSequence("x", { TMUX: "/tmp/s,1,0", TERM: "screen-256color" })
  assert.equal(wrapped, `${ESC}]2;x${BEL}${ESC}Ptmux;${ESC}${ESC}]2;x${BEL}${ESC}\\`)
})

test("TERM=dumb 时标题通道整条关闭", () => {
  const { notifier, stdout } = makeNotifier({ env: { TERM: "dumb" } })
  assert.equal(notifier.setTitle("hello"), false)
  assert.deepEqual(stdout.writes, [])
})

test("非 TTY（管道、重定向到文件）时标题通道整条关闭", () => {
  const { notifier, stdout } = makeNotifier({ isTTY: false })
  assert.equal(notifier.setTitle("hello"), false)
  assert.deepEqual(stdout.writes, [])
})

// --- 注入面：标题消毒 ---

test("标题里的 BEL / ESC / 换行不能变成第二条转义序列", () => {
  const hostile = `a${BEL}b${ESC}]0;evil${BEL}c\nd`
  // 先确认这条输入确实带着注入载荷，否则下面的断言是对着空气成立的
  assert.ok(hostile.includes(`${ESC}]0;`), "样本本身必须含有一条完整的 OSC 0 前缀")

  const { notifier, stdout } = makeNotifier()
  notifier.setTitle(hostile)
  const out = stdout.all()

  assert.equal(out.match(/\x07/g).length, 1, "BEL 只能出现一次 —— 就是序列结尾那个")
  assert.equal(out.match(/\x1b/g).length, 1, "ESC 只能出现一次 —— 就是序列开头那个")
  assert.ok(!out.includes(`${ESC}]0;`), "注入的 OSC 0 不能原样出现在输出里")
  assert.equal(out, `${ESC}]2;a b ]0;evil c d${BEL}`)
})

test("tmux 包装下同样注入不进去", () => {
  const { notifier, stdout } = makeNotifier({ env: { TMUX: "/tmp/s,1,0" } })
  notifier.setTitle(`x${ESC}]0;evil${BEL}`)
  const out = stdout.all()
  const clean = "x ]0;evil"
  assert.equal(out, `${ESC}]2;${clean}${BEL}${ESC}Ptmux;${ESC}${ESC}]2;${clean}${BEL}${ESC}\\`)
  // 包装本身带 5 个 ESC（裸 1 + DCS 头 1 + 载荷加倍 2 + ST 1），多一个就说明漏了消毒
  assert.equal(out.match(/\x1b/g).length, 5)
})

test("控制字符全类别都被剥掉，包括 DEL 与 C1", () => {
  assert.equal(sanitizeTitle("a\u0000b\u007fc\u009dd"), "a b c d")
  assert.equal(sanitizeTitle("tab\there"), "tab here")
})

test("超长标题截到 80 字符并以省略号收尾", () => {
  const long = "x".repeat(200)
  const cut = sanitizeTitle(long)
  assert.equal(cut.length, 80)
  assert.equal(cut.endsWith("…"), true)
  assert.equal(cut.slice(0, 79), "x".repeat(79))

  const { notifier, stdout } = makeNotifier()
  notifier.setTitle(long)
  assert.equal(stdout.all(), `${ESC}]2;${cut}${BEL}`)
})

// --- 通道二：响铃 ---

test("响铃默认关：失焦的审批提醒也只写标题", () => {
  const { notifier, stdout } = makeNotifier({ platform: "freebsd" })
  notifier.setFocused(false)
  const fired = notifier.alert("permission", { tool: "Bash" })
  assert.equal(fired.bell, false)
  assert.equal(stdout.all(), `${ESC}]2;${describeAlert("permission", { tool: "Bash" }).titleText}${BEL}`)
})

test("打开响铃后写出的恰好是一个 U+0007", () => {
  const { notifier, stdout } = makeNotifier({ notify: { bell: true, title: false }, platform: "freebsd" })
  notifier.setFocused(false)
  assert.equal(notifier.alert("permission", { tool: "Bash" }).bell, true)
  assert.equal(stdout.writes.length, 1)
  assert.equal(stdout.all().length, 1)
  assert.equal(stdout.all().codePointAt(0), 7)
  assert.equal(stdout.all(), "\u0007")
})

test("TERM=dumb 时响铃也不响", () => {
  const { notifier, stdout } = makeNotifier({ notify: { bell: true }, env: { TERM: "dumb" }, platform: "freebsd" })
  notifier.setFocused(false)
  assert.equal(notifier.alert("permission", {}).bell, false)
  assert.deepEqual(stdout.writes, [])
})

// --- 通道三：桌面通知 ---

test("darwin 走 osascript，引号按 AppleScript 字面量转义", () => {
  const { notifier, spawner } = makeDesktopOnly({ platform: "darwin" })
  notifier.alert("error", { message: 'say "hi" C:\\path' })
  assert.equal(spawner.calls.length, 1)
  assert.equal(spawner.calls[0].command, "osascript")
  assert.deepEqual(spawner.calls[0].args, [
    "-e",
    'display notification "say \\"hi\\" C:\\\\path" with title "kkcode · error"'
  ])
})

test("linux 走 notify-send，标题与正文各一个参数", () => {
  const { notifier, spawner } = makeDesktopOnly({ platform: "linux" })
  notifier.alert("permission", { tool: "Bash" })
  assert.equal(spawner.calls[0].command, "notify-send")
  assert.deepEqual(spawner.calls[0].args, ["kkcode · needs permission", "Bash needs approval"])
})

test("win32 走 PowerShell toast，单引号加倍", () => {
  const { notifier, spawner } = makeDesktopOnly({ platform: "win32" })
  notifier.alert("question", { question: "it's ready?" })
  const call = spawner.calls[0]
  assert.equal(call.command, "powershell")
  assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"])
  assert.ok(call.args[3].includes("ToastNotificationManager"))
  assert.ok(call.args[3].includes("CreateTextNode('it''s ready?')"), "单引号必须加倍，否则脚本被截断")
  assert.ok(!/CreateTextNode\('it's/.test(call.args[3]))
})

test("没有桌面通道的平台静默跳过", () => {
  // 先直接断言派发表本身。notifyDesktop 外面裹着 try/catch，「返回 null 还硬着头皮
  // 去 spawn」会被那个 catch 吞成同样的「没有 spawn」—— 只看 spawner.calls 是空的
  // 分不出这两种情况，等于放过了一整类错误。
  assert.equal(desktopCommand("aix", { heading: "x", body: "y" }), null)
  assert.equal(desktopCommand("sunos", { heading: "x", body: "y" }), null)
  assert.equal(desktopCommand("darwin", { heading: "x", body: "y" })?.command, "osascript")

  const { notifier, spawner } = makeDesktopOnly({ platform: "aix" })
  assert.equal(notifier.alert("permission", { tool: "Bash" }).desktop, false)
  assert.deepEqual(spawner.calls, [])
})

test("spawn 同步抛 ENOENT 时静默，不冒泡到调用方", () => {
  const { notifier, spawner } = makeDesktopOnly({ platform: "linux", spawnOptions: { throwEnoent: true } })
  let fired = null
  assert.doesNotThrow(() => { fired = notifier.alert("permission", { tool: "Bash" }) })
  assert.equal(fired.desktop, false)
  assert.equal(spawner.calls.length, 1, "确实尝试过 spawn —— 否则这条测的是没发生的事")
})

test("命令以 error 事件报 ENOENT 时也被吃掉，并且不留下待决定时器", () => {
  const { notifier, spawner, timers } = makeDesktopOnly({ platform: "linux" })
  notifier.alert("permission", { tool: "Bash" })
  const child = spawner.children[0]
  assert.equal(child.has("error"), true, "没有 error 监听器的话 ENOENT 会炸掉进程")
  assert.equal(timers.pending().length, 1)
  assert.doesNotThrow(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })))
  assert.equal(timers.pending().length, 0)
})

test("子进程被 unref、超时是 3 秒且定时器自己也 unref", () => {
  const { notifier, spawner, timers } = makeDesktopOnly({ platform: "linux" })
  notifier.alert("permission", { tool: "Bash" })
  assert.deepEqual(spawner.calls[0].options, { stdio: "ignore", windowsHide: true })
  assert.equal(spawner.children[0].unrefs, 1)
  const [timer] = timers.pending()
  assert.equal(timer.ms, 3000)
  assert.equal(timer.unrefs, 1, "定时器不 unref 就会把进程退出拖后三秒")
})

test("超时到点会杀掉没退出的通知进程", () => {
  const { notifier, spawner, timers } = makeDesktopOnly({ platform: "linux" })
  notifier.alert("permission", { tool: "Bash" })
  assert.equal(spawner.children[0].kills, 0)
  assert.equal(timers.fire(), 1)
  assert.equal(spawner.children[0].kills, 1)
})

test("正常退出后不再持有子进程，dispose 不会去 kill 它", () => {
  const { notifier, spawner, timers } = makeDesktopOnly({ platform: "linux" })
  notifier.alert("permission", { tool: "Bash" })
  spawner.children[0].emit("close", 0)
  assert.equal(timers.pending().length, 0)
  notifier.dispose()
  assert.equal(spawner.children[0].kills, 0)
})

test("dispose 会杀掉仍未决的通知进程", () => {
  const { notifier, spawner } = makeDesktopOnly({ platform: "linux" })
  notifier.alert("permission", { tool: "Bash" })
  notifier.dispose()
  assert.equal(spawner.children[0].kills, 1)
})

// --- SSH ---

test("SSH 会话里 desktop:auto 不弹，标题照旧更新", () => {
  for (const env of [{ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, { SSH_TTY: "/dev/pts/3" }]) {
    const { notifier, spawner, stdout } = makeNotifier({ platform: "linux", env })
    notifier.setFocused(false)
    const fired = notifier.alert("permission", { tool: "Bash" })
    assert.equal(fired.desktop, false, `${Object.keys(env)[0]} 下不应该弹桌面通知`)
    assert.deepEqual(spawner.calls, [])
    assert.equal(fired.title, true)
    assert.equal(stdout.writes.length, 1)
  }
})

test("SSH 会话里 desktop:always 仍然弹", () => {
  const { notifier, spawner } = makeDesktopOnly({
    platform: "linux",
    env: { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" },
    notify: { desktop: "always" }
  })
  assert.equal(notifier.alert("permission", { tool: "Bash" }).desktop, true)
  assert.equal(spawner.calls[0].command, "notify-send")
})

test("非 SSH 的 auto 会弹，desktop:never 一律不弹", () => {
  const auto = makeDesktopOnly({ platform: "linux" })
  assert.equal(auto.notifier.alert("permission", {}).desktop, true)

  const never = makeDesktopOnly({ platform: "linux", notify: { desktop: "never" } })
  assert.equal(never.notifier.alert("permission", {}).desktop, false)
  assert.deepEqual(never.spawner.calls, [])
})

test("desktop 模式判定表", () => {
  const ssh = { SSH_CONNECTION: "x" }
  assert.equal(resolveDesktopMode("auto", { env: {}, platform: "darwin" }), true)
  assert.equal(resolveDesktopMode("auto", { env: ssh, platform: "darwin" }), false)
  assert.equal(resolveDesktopMode("always", { env: ssh, platform: "win32" }), true)
  assert.equal(resolveDesktopMode("never", { env: {}, platform: "linux" }), false)
  assert.equal(resolveDesktopMode(true, { env: ssh, platform: "linux" }), true)
  assert.equal(resolveDesktopMode(false, { env: {}, platform: "linux" }), false)
  assert.equal(resolveDesktopMode("always", { env: {}, platform: "sunos" }), false)
})

// --- 触发语义：时长阈值 ---

test("29 秒的回合不通知，31 秒的通知", () => {
  const short = makeDesktopOnly({ platform: "linux" })
  assert.deepEqual(short.notifier.alert("turn-done", { durationMs: 29_000 }), {
    title: false, bell: false, desktop: false
  })
  assert.deepEqual(short.spawner.calls, [])
  assert.deepEqual(short.stdout.writes, [])

  const long = makeDesktopOnly({ platform: "linux" })
  assert.equal(long.notifier.alert("turn-done", { durationMs: 31_000 }).desktop, true)
  assert.deepEqual(long.spawner.calls[0].args, ["kkcode · done", "31s"])
})

test("阈值本身算通知（>=，不是 >）", () => {
  const { notifier } = makeDesktopOnly({ platform: "linux" })
  assert.equal(notifier.alert("turn-done", { durationMs: 30_000 }).desktop, true)
})

test("min_duration_ms 可配置", () => {
  const { notifier, spawner } = makeDesktopOnly({ platform: "linux", notify: { min_duration_ms: 1000 } })
  assert.equal(notifier.alert("turn-done", { durationMs: 900 }).desktop, false)
  assert.equal(notifier.alert("turn-done", { durationMs: 1200 }).desktop, true)
  assert.equal(spawner.calls.length, 1)
})

test("拿不到时长的 turn-done 保守地不通知", () => {
  const { notifier, spawner } = makeDesktopOnly({ platform: "linux" })
  assert.equal(notifier.alert("turn-done", {}).desktop, false)
  assert.equal(notifier.alert("turn-done").desktop, false)
  assert.deepEqual(spawner.calls, [])
})

test("审批与提问不看时长，立即通知", () => {
  const { notifier, spawner } = makeDesktopOnly({ platform: "linux" })
  assert.equal(notifier.alert("permission", { tool: "Write" }).desktop, true)
  assert.equal(notifier.alert("question", { question: "选哪个分支？" }).desktop, true)
  assert.equal(notifier.alert("error", { message: "boom" }).desktop, true)
  assert.deepEqual(spawner.calls.map((c) => c.args[0]), [
    "kkcode · needs permission",
    "kkcode · waiting on you",
    "kkcode · error"
  ])
})

test("回合摘要优先于时长，超过一分钟按 Xm Ys 显示", () => {
  assert.equal(describeAlert("turn-done", { durationMs: 95_000 }).body, "1m 35s")
  assert.equal(describeAlert("turn-done", { durationMs: 95_000, summary: "重构完成" }).body, "重构完成")
})

// --- 触发语义：焦点 ---

test("默认当作有焦点：只更新标题，不响铃不弹窗", () => {
  const { notifier, spawner, stdout } = makeNotifier({ notify: { bell: true }, platform: "linux" })
  assert.equal(notifier.isFocused(), true)
  const fired = notifier.alert("turn-done", { durationMs: 60_000 })
  assert.deepEqual(fired, { title: true, bell: false, desktop: false })
  assert.deepEqual(spawner.calls, [])
  assert.equal(stdout.all(), `${ESC}]2;kkcode · done — 1m 0s${BEL}`)
})

test("失焦后才打扰，重新聚焦又安静下来", () => {
  const { notifier, spawner } = makeNotifier({ notify: { bell: true, title: false }, platform: "linux" })
  notifier.setFocused(false)
  assert.deepEqual(notifier.alert("turn-done", { durationMs: 60_000 }), {
    title: false, bell: true, desktop: true
  })
  assert.equal(spawner.calls.length, 1)

  notifier.setFocused(true)
  assert.equal(notifier.alert("turn-done", { durationMs: 60_000 }).desktop, false)
  assert.equal(spawner.calls.length, 1, "重新聚焦后不应该再弹")
})

test("有焦点时审批提醒同样不弹窗，只落到标题上", () => {
  const { notifier, spawner } = makeNotifier({ platform: "linux" })
  const fired = notifier.alert("permission", { tool: "Bash" })
  assert.deepEqual(fired, { title: true, bell: false, desktop: false })
  assert.deepEqual(spawner.calls, [])
})

// --- 总开关 ---

test("enabled:false 时三条通道全静默", () => {
  const { notifier, stdout, spawner } = makeNotifier({
    notify: { enabled: false, bell: true, title: true, desktop: "always" },
    platform: "linux"
  })
  notifier.setFocused(false)
  assert.deepEqual(notifier.channels(), { title: false, bell: false, desktop: false })
  assert.equal(notifier.setTitle("hello"), false)
  assert.deepEqual(notifier.alert("permission", { tool: "Bash" }), {
    title: false, bell: false, desktop: false
  })
  assert.equal(notifier.alert("turn-done", { durationMs: 99_000 }).title, false)
  assert.deepEqual(stdout.writes, [])
  assert.deepEqual(spawner.calls, [])
})

test("单条通道可以各自关掉", () => {
  const { notifier } = makeNotifier({ notify: { title: false, bell: true }, platform: "linux" })
  assert.deepEqual(notifier.channels(), { title: false, bell: true, desktop: true })
})

// --- dispose ---

test("dispose 把标题恢复成空串，之后一个字节都不再写", () => {
  const { notifier, stdout, spawner } = makeNotifier({ notify: { bell: true }, platform: "linux" })
  notifier.setFocused(false)
  notifier.setTitle("working")
  notifier.dispose()
  assert.equal(stdout.writes.at(-1), `${ESC}]2;${BEL}`)
  const settled = stdout.writes.length

  notifier.setTitle("again")
  notifier.alert("permission", { tool: "Bash" })
  notifier.clearTitle()
  assert.equal(stdout.writes.length, settled, "dispose 之后不应该再有任何写入")
  assert.deepEqual(spawner.calls, [])
})

test("从没设过标题就 dispose，不去动别人的标题", () => {
  const { notifier, stdout } = makeNotifier()
  notifier.dispose()
  assert.deepEqual(stdout.writes, [])
})

test("dispose 幂等，不会重复写恢复序列", () => {
  const { notifier, stdout } = makeNotifier()
  notifier.setTitle("working")
  notifier.dispose()
  notifier.dispose()
  assert.equal(stdout.writes.length, 2)
})

test("dispose 在 tmux 下恢复的也是包装过的空标题", () => {
  const { notifier, stdout } = makeNotifier({ env: { TMUX: "/tmp/s,1,0" } })
  notifier.setTitle("working")
  notifier.dispose()
  assert.equal(stdout.writes.at(-1), `${ESC}]2;${BEL}${ESC}Ptmux;${ESC}${ESC}]2;${BEL}${ESC}\\`)
})

// --- 配置解析 ---

test("整份 config 与单独一节都能接住", () => {
  const section = { bell: true, min_duration_ms: 5000 }
  const whole = createNotifier({
    config: { ui: { notify: section } },
    env: { TERM: "xterm" },
    stdout: fakeStdout(),
    spawn: fakeSpawn().spawn,
    platform: "linux"
  })
  const bare = createNotifier({
    config: section,
    env: { TERM: "xterm" },
    stdout: fakeStdout(),
    spawn: fakeSpawn().spawn,
    platform: "linux"
  })
  assert.deepEqual(whole.channels(), bare.channels())
  assert.equal(bare.channels().bell, true)
})

test("缺省配置等于默认值：标题开、响铃关", () => {
  const { notifier } = makeNotifier({ notify: undefined, platform: "linux" })
  assert.deepEqual(notifier.channels(), { title: true, bell: false, desktop: true })
})
