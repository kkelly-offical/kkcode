// 受控终端模式（M30）：`kkcode remote` 绑定 OIDC SSO + 网关后，本终端是受控端，
// 只显示远程连接状态面板，不再进入本地交互聊天。聊天入口保留在未绑定路径
// （startRepl 无 remoteService → "interactive"）。
//
// 数据源是 DeviceService 的进程内可观测面，即 M26 sse-contract-v1 钉定的稳定
// 消费面：remoteStatus 字段、'event' 发射（全部日志行）、'device' 发射
// （settings.updated/models.updated 设备级事件）、turns/leases/approvals Map、
// metadata；connected client 即这些条目里的 principal.client。

import { paint } from "../theme/color.mjs"
import { sanitizeTerminalText } from "../theme/terminal-sanitize.mjs"
import { DEFAULT_THEME } from "../theme/default-theme.mjs"
import { checkWorkspaceTrust } from "../kernel/index.mjs"
import { defaultProfile, loadProfile, saveProfile } from "../onboarding.mjs"

const LOCAL_PRINCIPAL = { id: "local", client: "local" }
const SESSION_STATUS_RANK = { running: 0, approval: 1, controlled: 2, idle: 3 }
// 调色板与交互式 TUI 共用主题语义色（M32）：状态面板、toast、状态栏三处
// 的「绿=就绪/黄=过渡/红=要处理/灰=闲置」必须是一套语言，不能各调各的。
// 受控端不加载用户主题（独立进程入口），统一用缺省调色板作共同基准。
const SEM = DEFAULT_THEME.semantic
const CONNECTION_TONE = {
  connected: SEM.success,
  connecting: SEM.warn,
  disconnected: SEM.warn,
  login_required: SEM.error,
  offline: DEFAULT_THEME.base.muted
}
const SESSION_TONE = { running: SEM.success, approval: SEM.warn, controlled: SEM.info, idle: DEFAULT_THEME.base.muted }

export function resolveTerminalMode({ remoteService = null } = {}) {
  return remoteService ? "controlled" : "interactive"
}

function oneLine(value, limit = 60) {
  const text = sanitizeTerminalText(value ?? "").replace(/[\r\n]+/g, " ").trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function shortId(id) {
  const text = String(id || "")
  return text.length > 12 ? `${text.slice(0, 8)}…` : text
}

function shortClient(client) {
  const text = String(client || "")
  return text.length > 14 ? `${text.slice(0, 10)}…` : text
}

function ageLabel(timestamp, now) {
  if (!timestamp) return ""
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

function mergeLiveRow(rows, sessionId, patch) {
  const existing = rows.get(sessionId) || { id: sessionId, status: "idle" }
  const status = SESSION_STATUS_RANK[patch.status] < SESSION_STATUS_RANK[existing.status] ? patch.status : existing.status
  rows.set(sessionId, { ...existing, ...patch, status })
}

// DeviceService 可观测面 → 面板快照。sessions.list 失败时退化为纯实时行。
export function createControlledStatusSource({ service, now = () => Date.now() } = {}) {
  let requestCounter = 0
  function liveRows() {
    const rows = new Map()
    for (const [sessionId, lease] of service.leases || []) {
      if (lease && lease.until > now()) mergeLiveRow(rows, sessionId, { status: "controlled", client: lease.client })
    }
    for (const approval of service.approvals?.values?.() || []) {
      if (approval?.sessionId) mergeLiveRow(rows, approval.sessionId, { status: "approval", approvalKind: approval.kind })
    }
    for (const [sessionId, turn] of service.turns || []) {
      if (turn) mergeLiveRow(rows, sessionId, { status: "running", client: turn.client, origin: turn.origin })
    }
    return rows
  }
  return {
    connection: () => service.remoteStatus || "connecting",
    device: () => {
      const metadata = service.metadata || {}
      return { id: metadata.id || "", name: metadata.name || "", profile: metadata.profile || null, gateway: metadata.ownerGateway || null }
    },
    clients: () => {
      const seen = new Set()
      for (const row of liveRows().values()) if (row.client) seen.add(String(row.client))
      return [...seen]
    },
    async sessions() {
      const rows = liveRows()
      try {
        requestCounter += 1
        const listed = await service.request({ id: `panel-status-${requestCounter}`, method: "sessions.list", params: {} }, LOCAL_PRINCIPAL)
        for (const session of Array.isArray(listed) ? listed : []) {
          if (!session?.id) continue
          const live = rows.get(session.id)
          const listedRunning = session.status === "running" && !live
          rows.set(session.id, {
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt,
            status: live?.status || (listedRunning ? "running" : "idle"),
            client: live?.client,
            origin: live?.origin
          })
        }
      } catch { /* 会话目录读取失败不阻塞面板：实时行仍然可信 */ }
      return [...rows.values()]
        .filter((row) => row.status !== "idle")
        .sort((a, b) => SESSION_STATUS_RANK[a.status] - SESSION_STATUS_RANK[b.status] || String(a.id).localeCompare(String(b.id)))
    },
    subscribe: (listener) => {
      service.on("event", listener)
      // M26 契约的设备级发射（settings.updated / models.updated）；今天的
      // DeviceService 尚不发射，订阅是前向兼容，空挂无副作用。
      service.on("device", listener)
      return () => {
        service.off("event", listener)
        service.off("device", listener)
      }
    }
  }
}

export function isPanelEvent(row) {
  return Boolean(row?.type) && !String(row.type).endsWith(".delta")
}

function connectionLabel(connection) {
  if (connection === "disconnected") return "disconnected — reconnecting"
  return connection
}

function sessionLine(row, activityAt, now) {
  const status = paint(row.status.padEnd(10), SESSION_TONE[row.status] || "#888888")
  const client = row.client ? `client=${oneLine(shortClient(row.client), 12)}` : "client=-"
  const age = ageLabel(activityAt.get(row.id) || row.updatedAt, now)
  const title = row.title ? `  ${oneLine(row.title, 40)}` : ""
  return `  ${shortId(row.id).padEnd(10)} ${status} ${client.padEnd(14)} ${age.padEnd(8)}${title}`.trimEnd()
}

export function formatControlledStatusFrame({ snapshot, events = [], activityAt = new Map(), now = Date.now(), columns = 100 } = {}) {
  const width = Math.max(60, Math.min(columns || 100, 120))
  const { device, connection, clients, sessions } = snapshot
  const lines = []
  lines.push(paint(" KK Code remote — controlled terminal", DEFAULT_THEME.base.accent, { bold: true }))
  lines.push(paint(" " + "─".repeat(width - 1), DEFAULT_THEME.base.border))
  lines.push(` Device   ${oneLine(device.name || "-", 40)} (${oneLine(shortId(device.id), 12)})`)
  const owner = device.profile ? `${oneLine(device.profile.name || "-", 30)} · ${oneLine(device.profile.organization || "-", 30)}` : "-"
  lines.push(` Owner    ${owner}`)
  lines.push(` Gateway  ${oneLine(device.gateway || "-", 80)}`)
  lines.push(` Relay    ${paint("●", CONNECTION_TONE[connection] || "#888888")} ${oneLine(connectionLabel(connection), 30)}`)
  lines.push("")
  lines.push(paint(` Clients (${clients.length})`, DEFAULT_THEME.components.header, { bold: true }))
  lines.push(clients.length ? `  ${clients.map((client) => oneLine(shortClient(client), 12)).join("  ")}` : "  none connected yet")
  lines.push("")
  lines.push(paint(` Sessions (${sessions.length})`, DEFAULT_THEME.components.header, { bold: true }))
  if (sessions.length) for (const row of sessions) lines.push(sessionLine(row, activityAt, now))
  else lines.push("  no active sessions")
  lines.push("")
  lines.push(paint(" Recent events", DEFAULT_THEME.components.header, { bold: true }))
  if (events.length) {
    for (const event of events) {
      const time = new Date(event.timestamp || now).toTimeString().slice(0, 8)
      lines.push(`  ${time}  ${shortId(event.sessionId).padEnd(10)} ${oneLine(event.type, 40)}`)
    }
  } else lines.push("  no events yet")
  lines.push("")
  lines.push(paint(" Local chat is disabled while this device is controlled. Press Ctrl+C to stop remote access.", DEFAULT_THEME.base.muted))
  return lines.join("\n")
}

// 面板核心：事件环形缓冲 + 渲染调度。TTY 全帧重绘；非 TTY 追加行（可被管道收集）。
export function createControlledStatusPanel({ source, write, tty = false, columns = 100, intervalMs = 1000, now = () => Date.now(), maxEvents = 8 } = {}) {
  const events = []
  const activityAt = new Map()
  let unsubscribe = null, timer = null, stopped = false, started = false, lastConnection = null, paintedOnce = false, rendering = Promise.resolve()
  let resolveWait
  const waiting = new Promise((resolve) => { resolveWait = resolve })

  async function snapshot() {
    return { device: source.device(), connection: source.connection(), clients: source.clients(), sessions: await source.sessions() }
  }
  function render() {
    rendering = rendering.then(async () => {
      if (stopped) return
      const frame = formatControlledStatusFrame({ snapshot: await snapshot(), events, activityAt, now: now(), columns })
      if (stopped) return
      if (tty) write(`\x1b[2J\x1b[H${frame}\n`)
      else if (!paintedOnce) { write(`${frame}\n`); paintedOnce = true }
    }).catch(() => {})
    return rendering
  }
  function noteConnection(connection) {
    if (lastConnection === null) { lastConnection = connection; return }
    if (connection !== lastConnection) {
      if (!tty) write(`[${new Date(now()).toISOString()}] relay: ${lastConnection} -> ${connection}\n`)
      lastConnection = connection
    }
  }
  function noteEvent(row) {
    if (!isPanelEvent(row)) return
    events.push({ timestamp: row.timestamp || now(), sessionId: row.sessionId || "", type: row.type })
    if (events.length > maxEvents) events.shift()
    if (row.sessionId) activityAt.set(row.sessionId, row.timestamp || now())
    if (tty) return render()
    write(`[${new Date(row.timestamp || now()).toISOString()}] ${row.sessionId || "-"} ${row.type}\n`)
  }
  return {
    async start() {
      if (stopped || started) return
      started = true
      unsubscribe = source.subscribe((row) => noteEvent(row))
      await render()
      if (stopped) return
      lastConnection = source.connection()
      // 定时器必须 ref 住事件循环：受控进程可能没有别的 ref 句柄，unref 后
      // libuv 会带着未派发的 SIGINT 直接退出（信号丢失，进程以 code 13 收尾）
      timer = setInterval(() => {
        noteConnection(source.connection())
        if (tty) void render()
      }, intervalMs)
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (timer) clearInterval(timer)
      unsubscribe?.()
      resolveWait()
    },
    wait: () => waiting,
    flush: () => rendering,
    noteEvent,
    noteConnection
  }
}

async function ensureControlledProfile() {
  if (!(await loadProfile())) await saveProfile(defaultProfile())
}

export async function runControlledTerminal({
  service,
  trust = false,
  cwd = process.cwd(),
  write = (text) => process.stdout.write(text),
  tty = Boolean(process.stdout.isTTY),
  columns = process.stdout.columns || 100,
  intervalMs = 1000,
  now = () => Date.now(),
  quit = null,
  ensureProfile = ensureControlledProfile,
  honorTrust = (flag) => checkWorkspaceTrust({ cwd, cliTrust: flag, isTTY: false })
} = {}) {
  // 受控端不做交互式信任提问；--trust 仍按既有语义持久化授信（isTTY:false → 确定性路径）
  await honorTrust(Boolean(trust))
  // 首跑资料在受控模式走静默默认，与 runOnboarding 的非 TTY 分支一致
  await ensureProfile()
  const source = createControlledStatusSource({ service, now })
  const panel = createControlledStatusPanel({ source, write, tty, columns, intervalMs, now })
  const onSigint = () => { void panel.stop() }
  process.once("SIGINT", onSigint)
  try {
    // Ctrl+C during the initial asynchronous snapshot must not wait for a slow
    // catalog read or let start() recreate a referenced timer after stop().
    await Promise.race([panel.start(), panel.wait()])
    if (quit) {
      await quit
      await panel.stop()
    }
    await panel.wait()
    write("Remote access stopped.\n")
  } finally {
    process.removeListener("SIGINT", onSigint)
    await panel.stop()
  }
}
