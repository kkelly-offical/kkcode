import { spawn as spawnProcess } from "node:child_process"

/**
 * 回合跑完 / 要审批 / 要回答时把用户叫回来。
 *
 * 三条通道彼此独立、各自可关：终端标题（被动，永远反映最新状态）、响铃与桌面
 * 通知（打扰，只在窗口失焦时发）。所有外部副作用（stdout、spawn、env、platform）
 * 都从签名注入，测试里一个真进程都不会起。
 */

const ESC = "\x1b"
const BEL = "\x07"
const APP_NAME = "kkcode"
const MAX_TITLE_LENGTH = 80
const MAX_BODY_LENGTH = 200
const DESKTOP_TIMEOUT_MS = 3000
const DESKTOP_PLATFORMS = new Set(["darwin", "linux", "win32"])

export const NOTIFY_DEFAULTS = Object.freeze({
  enabled: true,
  title: true,
  bell: false,
  desktop: "auto",
  min_duration_ms: 30000
})

const SETTING_KEYS = Object.keys(NOTIFY_DEFAULTS)

/**
 * 接线方可能传整份 config，也可能只传 `ui.notify` 那一节（`resolveTerminalFeatures`
 * 就是后者）。两种都收，免得少写一层 `?.` 就静默退回全默认值。
 */
function pickSection(config) {
  if (!config || typeof config !== "object") return {}
  if (config.ui?.notify && typeof config.ui.notify === "object") return config.ui.notify
  if (config.notify && typeof config.notify === "object") return config.notify
  return config
}

export function resolveNotifySettings(config) {
  const section = pickSection(config)
  const settings = { ...NOTIFY_DEFAULTS }
  for (const key of SETTING_KEYS) {
    if (section[key] !== undefined) settings[key] = section[key]
  }
  const threshold = Number(settings.min_duration_ms)
  settings.min_duration_ms = Number.isFinite(threshold) && threshold >= 0
    ? threshold
    : NOTIFY_DEFAULTS.min_duration_ms
  return settings
}

/**
 * 标题文本消毒 —— 这里是注入面，不是排版。
 *
 * OSC 2 以 BEL 收尾，所以载荷里的 BEL 会提前关掉序列、后面的字节直接被终端当命令
 * 执行；载荷里的 ESC 更是能原地开一条新序列。C0、DEL、C1 一律换成空格。
 * （C1 在 UTF-8 下本来就编成两字节、多数终端不会当控制符，但 latin-1 模式下会。）
 */
export function sanitizeTitle(raw, max = MAX_TITLE_LENGTH) {
  const collapsed = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/**
 * 把 OSC 2 包成当前复用器能透传的形态。裸序列**始终照发**，包装是额外加的。
 *
 * tmux：裸 OSC 2 被 tmux 自己吃掉、变成 pane title（在本机 tmux 3.2a 上实测：
 * 外层 pty 上收不到 OSC，状态栏里出现了那个标题）。要让外层终端的标题也变，得走
 * DCS passthrough —— `ESC P tmux ; <载荷，其中每个 ESC 写两遍> ESC \`，实测外层
 * pty 上原样收到了 `ESC ] 2 ; <text> BEL`。tmux(1) 从 3.3 起用 `allow-passthrough`
 * 控制这条通道且默认 off；关着的时候 tmux 直接丢弃这段 DCS，不会有乱码漏到屏幕上，
 * 我们只是退回「只有 pane title」—— 所以两条都发才是最优解，而不是二选一。
 *
 * screen：screen(1) 的 Control Sequences 一节写着 `ESC P (A) Device Control
 * String. Outputs a string directly to the host terminal without interpretation.`
 * 载荷里的 ESC 不用加倍（后面不是 `\`，不会提前结束 DCS）。GNU screen 4.09 实测：
 * 包装过的原样到达外层；裸的那条 screen 也会转发（它另外补一条 OSC 0 并压/弹标题栈）。
 * 两条设的是同一段文本，先后到达不会互相打架。
 */
export function wrapTitleSequence(text, env = process.env) {
  const osc = `${ESC}]2;${text}${BEL}`
  if (env?.TMUX) {
    return `${osc}${ESC}Ptmux;${osc.replaceAll(ESC, ESC + ESC)}${ESC}\\`
  }
  if (String(env?.TERM || "").startsWith("screen")) {
    return `${osc}${ESC}P${osc}${ESC}\\`
  }
  return osc
}

export function resolveDesktopMode(value, { env = process.env, platform = process.platform } = {}) {
  if (value === false || value === "never") return false
  if (!DESKTOP_PLATFORMS.has(platform)) return false
  if (value === true || value === "always") return true
  // auto：SSH 会话里弹出来的是服务器的桌面，没人看得见。
  return !(env?.SSH_CONNECTION || env?.SSH_TTY)
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

const KIND_LABELS = {
  "turn-done": "done",
  // 后台任务的完成。刻意与 turn-done 分开：它不受 min_duration_ms 约束 ——
  // 那个阈值量的是「这一轮跑了多久，值不值得打扰」，而后台任务本来就是
  // 用户放手去做别的事之后完成的，多短都该报。
  "task-done": "background task",
  permission: "needs permission",
  question: "waiting on you",
  error: "error"
}

function describeBody(kind, detail) {
  if (kind === "turn-done") return detail.summary || formatDuration(detail.durationMs)
  if (kind === "task-done") {
    const summary = detail.summary || detail.description || "background task"
    return detail.status ? `${summary} (${detail.status})` : summary
  }
  if (kind === "permission") return detail.tool ? `${detail.tool} needs approval` : "needs approval"
  if (kind === "question") return detail.question || detail.summary || "waiting for your answer"
  if (kind === "error") return detail.message || "something went wrong"
  return detail.summary || detail.message || ""
}

export function describeAlert(kind, detail = {}) {
  const label = KIND_LABELS[kind] || String(kind || "update")
  const heading = `${APP_NAME} · ${label}`
  const body = sanitizeTitle(describeBody(kind, detail || {}), MAX_BODY_LENGTH)
  return {
    heading,
    body,
    titleText: body ? `${heading} — ${body}` : heading
  }
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''")
}

/**
 * Windows 的 toast 走 WinRT。`CreateTextNode` 自己会做 XML 转义，这里只需要把
 * PowerShell 单引号字面量里的 `'` 加倍。
 */
function powershellToast(heading, body) {
  return [
    "$ErrorActionPreference='Stop'",
    "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
    "$xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$t=$xml.GetElementsByTagName('text')",
    `[void]$t.Item(0).AppendChild($xml.CreateTextNode('${escapePowerShell(heading)}'))`,
    `[void]$t.Item(1).AppendChild($xml.CreateTextNode('${escapePowerShell(body)}'))`,
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_NAME}').Show($toast)`
  ].join(";")
}

/**
 * 平台 → 要 spawn 的命令。返回 null 表示这个平台没有可用通道（静默跳过）。
 * 正文里的控制字符已经在 describeAlert 里剥掉了，这里只处理各自的引号转义。
 */
export function desktopCommand(platform, { heading, body }) {
  if (platform === "darwin") {
    const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(heading)}"`
    return { command: "osascript", args: ["-e", script] }
  }
  if (platform === "linux") {
    return { command: "notify-send", args: [heading, body] }
  }
  if (platform === "win32") {
    return {
      command: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", powershellToast(heading, body)]
    }
  }
  return null
}

export function createNotifier({
  config,
  env = process.env,
  stdout = process.stdout,
  spawn = spawnProcess,
  platform = process.platform,
  // 超时用的定时器也注入，否则这条 3 秒路径没法测。
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const settings = resolveNotifySettings(config)
  const enabled = settings.enabled !== false
  // TERM=dumb 与非 TTY（管道、日志文件）下，转义序列和 BEL 都只会变成垃圾字节。
  const terminalCapable = Boolean(stdout?.isTTY) && env?.TERM !== "dumb"
  const titleEnabled = enabled && settings.title !== false && terminalCapable
  const bellEnabled = enabled && settings.bell === true && terminalCapable
  const desktopEnabled = enabled && resolveDesktopMode(settings.desktop, { env, platform })

  let focused = true
  let disposed = false
  let titleTouched = false
  const pending = new Set()

  const write = (text) => {
    if (disposed || !text) return false
    try {
      stdout.write(text)
      return true
    } catch {
      return false
    }
  }

  const setTitle = (text) => {
    if (!titleEnabled || disposed) return false
    const ok = write(wrapTitleSequence(sanitizeTitle(text), env))
    if (ok) titleTouched = true
    return ok
  }

  /**
   * 「恢复」标题在终端上没有通用做法：xterm 的标题栈（CSI 22t/23t）不是哪儿都有，
   * 原始标题也读不回来（OSC 21 查询基本没人实现，而且是个信息泄露面）。这里选最
   * 保守的一种 —— 设成空串，让终端退回自己的默认（多数会显示 shell 提示或程序名）。
   */
  const clearTitle = () => {
    if (!titleEnabled || disposed) return false
    return write(wrapTitleSequence("", env))
  }

  const ringBell = () => {
    if (!bellEnabled || disposed) return false
    return write(BEL)
  }

  const forget = (child, timer) => {
    if (timer !== null) clearTimer(timer)
    pending.delete(child)
  }

  /**
   * 桌面通知：起完就撒手。失败（命令不存在、桌面总线没起来、权限被拒）一律静默 ——
   * 通知失败绝不能冒泡到主流程。
   */
  const notifyDesktop = ({ heading, body }) => {
    if (!desktopEnabled || disposed) return false
    const spec = desktopCommand(platform, { heading, body })
    if (!spec) return false

    let child = null
    try {
      child = spawn(spec.command, spec.args, { stdio: "ignore", windowsHide: true })
    } catch {
      return false
    }
    if (!child) return false

    // 不用 spawn 的 timeout 选项：Node 内部那个定时器没有 unref，会把事件循环多
    // 拽住三秒，正好违反「绝不能拖住进程退出」。自己起一个 unref 过的。
    let timer = null
    const stop = () => forget(child, timer)
    timer = setTimer(() => {
      try { child.kill?.() } catch {}
      pending.delete(child)
    }, DESKTOP_TIMEOUT_MS)
    timer?.unref?.()

    try { child.unref?.() } catch {}
    // 没有 error 监听器时，ENOENT 会以未捕获异常的形式炸掉进程。
    child.once?.("error", stop)
    child.once?.("close", stop)
    pending.add(child)
    return true
  }

  const meetsDuration = (durationMs) => {
    const elapsed = Number(durationMs)
    // 拿不到时长就不通知：这是「超过阈值才响」的保守读法。接线时务必传 durationMs。
    return Number.isFinite(elapsed) && elapsed >= settings.min_duration_ms
  }

  const alert = (kind, detail = {}) => {
    const fired = { title: false, bell: false, desktop: false }
    if (!enabled || disposed) return fired
    if (kind === "turn-done" && !meetsDuration(detail?.durationMs)) return fired

    const message = describeAlert(kind, detail)
    fired.title = setTitle(message.titleText)
    // 有焦点时只更新标题：标题是被动状态，响铃和弹窗是打扰。
    if (focused) return fired
    fired.bell = ringBell()
    fired.desktop = notifyDesktop(message)
    return fired
  }

  return {
    setTitle,
    clearTitle,
    alert,
    setFocused(value) {
      focused = value !== false
      return focused
    },
    isFocused: () => focused,
    channels: () => ({ title: titleEnabled, bell: bellEnabled, desktop: desktopEnabled }),
    dispose() {
      if (disposed) return
      // 没碰过标题就别去「恢复」—— 那会抹掉本来就属于别人的标题。
      if (titleTouched) clearTitle()
      disposed = true
      for (const child of pending) {
        try { child.kill?.() } catch {}
      }
      pending.clear()
    }
  }
}
