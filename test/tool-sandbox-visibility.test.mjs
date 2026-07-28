/**
 * 沙箱的可见性：/status 面板与 doctor 都得说出**真实生效的后端**。
 *
 * 「配置里写了 mode=auto，机器上没有 bwrap」是这个特性最容易出的事故，
 * 而它唯一的补救是把真相摆到用户眼前 —— 所以这两处展示要单独验收。
 */

import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { renderRuntimeDashboardView } from "../src/ui/repl-status-view.mjs"
import { buildReplRuntimeSnapshot } from "../src/repl/runtime-facade.mjs"
import { formatSandboxLine, describeSandboxStatus, resetSandboxSupportCache } from "../src/tool/sandbox.mjs"

const baseState = {
  sessionId: "ses_sandbox",
  mode: "agent",
  providerType: "openai",
  model: "gpt-4o-mini",
  memoryLoaded: false
}

function renderWith(sandboxStatus) {
  return renderRuntimeDashboardView({
    theme: DEFAULT_THEME,
    state: baseState,
    providers: ["openai"],
    recentSessions: [],
    mcpSummary: { healthy: 0, configured: 0, tools: 0, entries: [] },
    skillSummary: { total: 0, template: 0, skillMd: 0, mcpPrompt: 0, programmable: 0 },
    backgroundSummary: { active: 0, counts: { pending: 0, running: 0, completed: 0, interrupted: 0, error: 0 } },
    runtimeSummary: { messageCount: 1, partCount: 1, recoverableCount: 0, audit: { total: 0, errorCount: 0 } },
    sandboxStatus,
    customCommandCount: 0,
    cwd: process.cwd(),
    columns: 100
  })
}

test("formatSandboxLine names the backend, not the config", () => {
  assert.equal(formatSandboxLine(null), "sandbox: off (bash runs unsandboxed)")
  assert.equal(
    formatSandboxLine(describeSandboxStatus({ config: { permission: { sandbox: { mode: "off" } } } })),
    "sandbox: off (bash runs unsandboxed)"
  )
  assert.equal(
    formatSandboxLine(describeSandboxStatus({
      config: { permission: { sandbox: { mode: "auto", network: false } } },
      platform: "linux",
      hasBwrap: true
    })),
    "sandbox: bwrap network=off"
  )
  assert.equal(
    formatSandboxLine(describeSandboxStatus({
      config: { permission: { sandbox: { mode: "auto" } } },
      platform: "darwin"
    })),
    "sandbox: sandbox-exec network=on"
  )
  const unavailable = formatSandboxLine(describeSandboxStatus({
    config: { permission: { sandbox: { mode: "auto" } } },
    platform: "linux",
    hasBwrap: false
  }))
  // 「想开但开不了」不能显示成 off，也不能显示成 on
  assert.match(unavailable, /^sandbox: auto-but-unavailable — /)
  assert.match(unavailable, /bwrap/)
})

test("/status runtime panel shows the sandbox line when there is a status", () => {
  const active = renderWith(describeSandboxStatus({
    config: { permission: { sandbox: { mode: "auto", network: false } } },
    platform: "linux",
    hasBwrap: true
  }))
  assert.match(active, /sandbox: bwrap network=off/)

  const unavailable = renderWith(describeSandboxStatus({
    config: { permission: { sandbox: { mode: "auto" } } },
    platform: "win32"
  }))
  assert.match(unavailable, /sandbox: auto-but-unavailable/)

  // 没拿到状态时不画这一行 —— 面板不能凭空断言「off」
  assert.doesNotMatch(renderWith(null), /sandbox:/)
})

test("buildReplRuntimeSnapshot carries the sandbox status", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kkcode-sandbox-vis-home-"))
  const project = await mkdtemp(path.join(os.tmpdir(), "kkcode-sandbox-vis-project-"))
  const previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  resetSandboxSupportCache()
  try {
    const snapshot = await buildReplRuntimeSnapshot({
      cwd: project,
      state: { sessionId: "ses_sandbox", mode: "agent", providerType: "openai", model: "gpt-test" },
      customCommands: [],
      providers: ["openai"],
      mcpRegistry: { healthSnapshot: () => [], listTools: () => [] },
      skillRegistry: { isReady: () => true, list: () => [] },
      config: { permission: { sandbox: { mode: "off" } } }
    })
    assert.equal(snapshot.sandboxStatus.status, "off")

    // 不传 config 也不能崩：repl.mjs 那条 dashboard 刷新路径就没有 config
    const bare = await buildReplRuntimeSnapshot({
      cwd: project,
      state: { sessionId: "ses_sandbox", mode: "agent" },
      mcpRegistry: { healthSnapshot: () => [], listTools: () => [] },
      skillRegistry: { isReady: () => true, list: () => [] }
    })
    assert.equal(bare.sandboxStatus.status, "off")
  } finally {
    if (previousHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousHome
    resetSandboxSupportCache()
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})
