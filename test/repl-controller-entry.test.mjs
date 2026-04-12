import test from "node:test"
import assert from "node:assert/strict"
import { runReplController } from "../src/repl/controller-entry.mjs"

test("runReplController uses tui path when stdio are tty", async () => {
  let used = null
  const mode = await runReplController({
    ctx: {},
    state: {},
    providersConfigured: [],
    customCommands: [],
    recentSessions: [],
    historyLines: [],
    mcpStatusLines: ["x"],
    stdout: { isTTY: true },
    stdin: { isTTY: true },
    clearScreenFn() {
      used = "clear"
    },
    async startTuiRepl() {
      used = "tui"
    },
    async startLineRepl() {
      used = "line"
    }
  })
  assert.equal(mode, "tui")
  assert.equal(used, "tui")
})

test("runReplController uses line path and prints MCP lines when not tty", async () => {
  const logs = []
  let cleared = false
  let used = null
  const mode = await runReplController({
    ctx: {},
    state: {},
    providersConfigured: [],
    customCommands: [],
    recentSessions: [],
    historyLines: [],
    mcpStatusLines: ["mcp one", "mcp two"],
    stdout: { isTTY: false },
    stdin: { isTTY: false },
    log(line) {
      logs.push(line)
    },
    clearScreenFn() {
      cleared = true
    },
    async startTuiRepl() {
      used = "tui"
    },
    async startLineRepl() {
      used = "line"
    }
  })
  assert.equal(mode, "line")
  assert.equal(used, "line")
  assert.equal(cleared, true)
  assert.deepEqual(logs, ["mcp one", "mcp two"])
})
