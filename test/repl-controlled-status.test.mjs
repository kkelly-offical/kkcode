import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import {
  resolveTerminalMode,
  createControlledStatusSource,
  createControlledStatusPanel,
  formatControlledStatusFrame,
  isPanelEvent,
  runControlledTerminal
} from "../src/repl/controlled-status.mjs"

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "")
}

function fakeService(overrides = {}) {
  const service = new EventEmitter()
  service.metadata = {
    id: "dev-1234567890abcdef",
    name: "workstation",
    owner: "acct-1",
    profile: { name: "Alice", organization: "ExampleOrg" },
    ownerGateway: "https://gateway.example.com"
  }
  service.remoteStatus = "connected"
  service.turns = new Map()
  service.leases = new Map()
  service.approvals = new Map()
  service.request = async () => []
  return Object.assign(service, overrides)
}

function collector() {
  const chunks = []
  return { chunks, write: (text) => chunks.push(String(text)), text: () => chunks.join("") }
}

test("resolveTerminalMode: controlled only when a remote service is attached", () => {
  assert.equal(resolveTerminalMode(), "interactive")
  assert.equal(resolveTerminalMode({}), "interactive")
  assert.equal(resolveTerminalMode({ remoteService: null }), "interactive")
  assert.equal(resolveTerminalMode({ remoteService: fakeService() }), "controlled")
})

test("startRepl gates controlled mode before the interactive startup path", async () => {
  const source = await readFile(new URL("../src/repl.mjs", import.meta.url), "utf8")
  const gate = source.indexOf('resolveTerminalMode({ remoteService })')
  assert.ok(gate > -1, "startRepl must branch on resolveTerminalMode")
  assert.ok(source.includes("runControlledTerminal({ service: remoteService, trust })"))
  assert.ok(gate < source.indexOf("await runOnboarding()"), "controlled branch must precede onboarding")
})

test("status source maps device, connection and defaults", () => {
  const source = createControlledStatusSource({ service: fakeService() })
  assert.equal(source.connection(), "connected")
  assert.deepEqual(source.device(), {
    id: "dev-1234567890abcdef",
    name: "workstation",
    profile: { name: "Alice", organization: "ExampleOrg" },
    gateway: "https://gateway.example.com"
  })
  const bare = createControlledStatusSource({ service: new EventEmitter() })
  assert.equal(bare.connection(), "connecting")
  assert.deepEqual(bare.clients(), [])
})

test("status source derives per-session state with running > approval > controlled precedence", async () => {
  const now = () => 1_000_000
  const service = fakeService({
    turns: new Map([
      ["ses_run", { client: "web-client-1", origin: "remote", turnId: "t1" }],
      ["ses_both", { client: "android-2", origin: "remote", turnId: "t2" }]
    ]),
    leases: new Map([
      ["ses_hold", { client: "web-client-1", until: 2_000_000 }],
      ["ses_expired", { client: "web-client-9", until: 500_000 }]
    ]),
    approvals: new Map([
      ["ap1", { id: "ap1", kind: "permission", sessionId: "ses_wait" }],
      ["ap2", { id: "ap2", kind: "question", sessionId: "ses_both" }]
    ]),
    request: async (request) => {
      assert.equal(request.method, "sessions.list")
      return [
        { id: "ses_run", title: "Fix the flaky test", updatedAt: 900_000 },
        { id: "ses_old", title: "Yesterday's idle chat", updatedAt: 100_000 }
      ]
    }
  })
  const source = createControlledStatusSource({ service, now })
  const sessions = await source.sessions()
  const byId = new Map(sessions.map((row) => [row.id, row]))
  assert.equal(byId.get("ses_run").status, "running")
  assert.equal(byId.get("ses_run").title, "Fix the flaky test")
  assert.equal(byId.get("ses_run").client, "web-client-1")
  assert.equal(byId.get("ses_wait").status, "approval")
  assert.equal(byId.get("ses_hold").status, "controlled")
  assert.equal(byId.get("ses_both").status, "running", "running turn wins over a pending approval on the same session")
  assert.equal(byId.has("ses_expired"), false, "expired leases are not active")
  assert.equal(byId.has("ses_old"), false, "idle listed sessions are not active")
  assert.deepEqual(source.clients().sort(), ["android-2", "web-client-1"])
})

test("status source keeps live rows when the session catalog read fails", async () => {
  const service = fakeService({
    turns: new Map([["ses_live", { client: "web-1", origin: "remote" }]]),
    request: async () => { throw new Error("storage offline") }
  })
  const sessions = await createControlledStatusSource({ service }).sessions()
  assert.deepEqual(sessions.map((row) => [row.id, row.status]), [["ses_live", "running"]])
})

test("status source lists catalog-reported running sessions even without a local turn entry", async () => {
  const service = fakeService({
    request: async () => [{ id: "ses_remote", title: "Phone turn", status: "running", updatedAt: 123 }]
  })
  const sessions = await createControlledStatusSource({ service }).sessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].status, "running")
  assert.equal(sessions[0].title, "Phone turn")
})

test("isPanelEvent filters streaming deltas and keeps lifecycle events", () => {
  assert.equal(isPanelEvent({ type: "turn.start" }), true)
  assert.equal(isPanelEvent({ type: "approval.requested" }), true)
  assert.equal(isPanelEvent({ type: "stream.text.delta" }), false)
  assert.equal(isPanelEvent({ type: "stream.thinking.delta" }), false)
  assert.equal(isPanelEvent({}), false)
  assert.equal(isPanelEvent(null), false)
})

test("frame renders device, relay, clients, sessions and recent events", () => {
  const text = stripAnsi(formatControlledStatusFrame({
    snapshot: {
      device: { id: "dev-1234567890abcdef", name: "workstation", profile: { name: "Alice", organization: "ExampleOrg" }, gateway: "https://gateway.example.com" },
      connection: "connected",
      clients: ["web-client-1"],
      sessions: [
        { id: "ses_run000000000", status: "running", client: "web-client-1", title: "Fix the flaky test" },
        { id: "ses_wait", status: "approval" }
      ]
    },
    events: [{ timestamp: 0, sessionId: "ses_run000000000", type: "turn.start" }],
    now: 60_000,
    columns: 100
  }))
  assert.match(text, /controlled terminal/)
  assert.match(text, /workstation/)
  assert.match(text, /Alice · ExampleOrg/)
  assert.match(text, /https:\/\/gateway\.example\.com/)
  assert.match(text, /connected/)
  assert.match(text, /Clients \(1\)/)
  assert.match(text, /web-client-1/)
  assert.match(text, /Sessions \(2\)/)
  assert.match(text, /running\s+client=web-client-1/)
  assert.match(text, /approval/)
  assert.match(text, /Fix the flaky test/)
  assert.match(text, /turn\.start/)
  assert.match(text, /Local chat is disabled/)
})

test("frame renders empty states and reconnecting label", () => {
  const text = stripAnsi(formatControlledStatusFrame({
    snapshot: { device: { id: "d", name: "n", profile: null, gateway: null }, connection: "disconnected", clients: [], sessions: [] },
    events: [],
    columns: 80
  }))
  assert.match(text, /disconnected — reconnecting/)
  assert.match(text, /none connected yet/)
  assert.match(text, /no active sessions/)
  assert.match(text, /no events yet/)
})

test("frame neutralizes terminal control characters in remote titles", () => {
  const frame = formatControlledStatusFrame({
    snapshot: {
      device: { id: "d", name: "n", profile: null, gateway: null },
      connection: "connected",
      clients: [],
      sessions: [{ id: "ses_evil", status: "running", title: "\x1b[2J\x1b[H wiped" }]
    },
    columns: 80
  })
  assert.ok(!frame.includes("\x1b[2J\x1b[H wiped"), "raw escape sequences from titles must not reach the terminal")
  assert.ok(stripAnsi(frame).includes("wiped"))
})

test("TTY panel redraws the frame and buffers recent events", async () => {
  const service = fakeService()
  const out = collector()
  const panel = createControlledStatusPanel({
    source: createControlledStatusSource({ service }),
    write: out.write,
    tty: true,
    intervalMs: 600_000,
    now: () => 1_700_000_000_000
  })
  await panel.start()
  assert.ok(out.text().startsWith("\x1b[2J\x1b[H"), "TTY render clears and repaints")
  service.emit("event", { type: "turn.start", sessionId: "ses_a", timestamp: 1_700_000_000_000 })
  service.emit("event", { type: "stream.text.delta", sessionId: "ses_a", timestamp: 1_700_000_000_100 })
  await panel.flush()
  const frames = out.text()
  assert.ok(frames.includes("turn.start"))
  assert.ok(!frames.includes("stream.text.delta"), "delta spam never reaches the panel")
  await panel.stop()
  const writesAfterStop = out.chunks.length
  service.emit("event", { type: "turn.finish", sessionId: "ses_a", timestamp: 1_700_000_000_200 })
  await panel.flush()
  assert.equal(out.chunks.length, writesAfterStop, "stop unsubscribes from the event stream")
})

test("panel subscribes to the M26 device-level channel", async () => {
  const service = fakeService()
  const out = collector()
  const panel = createControlledStatusPanel({
    source: createControlledStatusSource({ service }),
    write: out.write,
    tty: false,
    intervalMs: 600_000,
    now: () => 1_700_000_000_000
  })
  await panel.start()
  service.emit("device", { type: "models.updated", deviceId: "dev-1234567890abcdef", timestamp: 1_700_000_000_000 })
  assert.match(out.text(), /models\.updated/)
  await panel.stop()
  service.emit("device", { type: "settings.updated", deviceId: "dev-1234567890abcdef", timestamp: 1_700_000_001_000 })
  assert.ok(!out.text().includes("settings.updated"), "stop unsubscribes the device channel too")
})

test("line panel prints one snapshot, then transition and event lines", async () => {
  const service = fakeService()
  const out = collector()
  let now = 1_700_000_000_000
  const panel = createControlledStatusPanel({
    source: createControlledStatusSource({ service, now: () => now }),
    write: out.write,
    tty: false,
    intervalMs: 600_000,
    now: () => now
  })
  await panel.start()
  assert.equal(out.chunks.length, 1, "non-TTY prints the frame exactly once")
  assert.match(stripAnsi(out.text()), /Relay\s+● connected/)
  service.emit("event", { type: "turn.start", sessionId: "ses_b", timestamp: now })
  assert.match(out.text(), /ses_b turn\.start/)
  service.emit("event", { type: "stream.text.delta", sessionId: "ses_b", timestamp: now })
  assert.ok(!out.text().includes("stream.text.delta"))
  service.remoteStatus = "disconnected"
  now += 1000
  panel.noteConnection(service.remoteStatus)
  assert.match(out.text(), /relay: connected -> disconnected/)
  panel.noteConnection(service.remoteStatus)
  assert.equal(out.text().match(/relay:/g).length, 1, "unchanged connection does not repeat the line")
  await panel.stop()
})

test("runControlledTerminal honors trust/profile hooks and returns after quit", async () => {
  const service = fakeService()
  const out = collector()
  const calls = { trust: [], profile: 0 }
  const baselineSigint = process.listenerCount("SIGINT")
  let release
  const running = runControlledTerminal({
    service,
    trust: true,
    write: out.write,
    tty: false,
    intervalMs: 600_000,
    quit: new Promise((resolve) => { release = resolve }),
    honorTrust: async (flag) => { calls.trust.push(flag) },
    ensureProfile: async () => { calls.profile += 1 }
  })
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await running
  assert.deepEqual(calls.trust, [true])
  assert.equal(calls.profile, 1)
  assert.match(stripAnsi(out.text()), /controlled terminal/)
  assert.equal(process.listenerCount("SIGINT"), baselineSigint, "SIGINT listener is removed on exit")
})

test("runControlledTerminal stops when SIGINT arrives", async () => {
  const service = fakeService()
  const out = collector()
  const running = runControlledTerminal({
    service,
    write: out.write,
    tty: false,
    intervalMs: 600_000,
    honorTrust: async () => {},
    ensureProfile: async () => {}
  })
  await new Promise((resolve) => setImmediate(resolve))
  process.emit("SIGINT")
  await running
  assert.match(stripAnsi(out.text()), /controlled terminal/)
})

// 真实 DeviceService + 真 startRepl 接线的端到端冒烟：面板渲染、真实事件管线
// （record → liveView/replay → 'event' 发射）、SIGINT 停机、service.close 收口。
test("startRepl controlled mode runs the panel on a real DeviceService", async () => {
  const previousHome = process.env.KKCODE_HOME
  const home = await mkdtemp(path.join(os.tmpdir(), "kkcode-m30-"))
  process.env.KKCODE_HOME = home
  const chunks = []
  const originalWrite = process.stdout.write
  process.stdout.write = (text, ...rest) => { chunks.push(String(text)); return true }
  let service
  try {
    const { DeviceService } = await import("../src/device/service.mjs")
    const { startRepl } = await import("../src/repl.mjs")
    service = await new DeviceService({ cwd: process.cwd(), roots: [process.cwd()] }).initialize()
    service.remoteStatus = "connected"
    const running = startRepl({ remoteService: service })
    const output = () => chunks.join("")
    const deadline = Date.now() + 10000
    while (!output().includes("controlled terminal") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const frame = stripAnsi(output())
    assert.match(frame, /controlled terminal/)
    assert.match(frame, new RegExp(`Device\\s+${os.hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    assert.match(frame, /Relay\s+● connected/)
    assert.match(frame, /no active sessions/)
    await service.record({ type: "turn.start", sessionId: "ses_real1", turnId: "t1", payload: { prompt: "hello from web" } })
    assert.match(output(), /ses_real1 turn\.start/)
    process.emit("SIGINT")
    await running
    assert.match(output(), /Remote access stopped\./)
    await service.close()
    service = null
  } finally {
    process.stdout.write = originalWrite
    if (service) await service.close().catch(() => {})
    if (previousHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
