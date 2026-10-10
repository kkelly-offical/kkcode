import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { modeCommands } from "../src/repl/commands/mode.mjs"
import { sessionCommands } from "../src/repl/commands/session.mjs"
import { switchModeInPlace } from "../src/repl/mode-flow.mjs"

function command(commands, name) {
  const entry = commands.find((candidate) => candidate.names.includes(name))
  assert.ok(entry, `missing /${name} command`)
  return entry
}

function fixture() {
  return {
    state: {
      sessionId: "ses_current",
      modeId: "yolo",
      mode: "assistant",
      providerType: "current-provider",
      model: "current-model"
    },
    ctx: {
      configState: {
        config: {
          permission: { level: "yolo", rules: [{ effect: "allow", command: "git status" }] }
        }
      },
      kernel: {
        sessions: {
          listSessions: async () => [],
          getConversationHistory: async () => []
        }
      }
    },
    switchModeInPlace,
    print: () => {}
  }
}

function assertModeState(fixture, { modeId, mode, approval }) {
  assert.equal(fixture.state.modeId, modeId)
  assert.equal(fixture.state.mode, mode)
  assert.equal(fixture.ctx.configState.config.permission.level, approval)
  assert.deepEqual(
    fixture.ctx.configState.config.permission.rules,
    [{ effect: "allow", command: "git status" }],
    "unrelated permission rules must survive a mode transition"
  )
}

test("/plan <goal> updates the lane, mode id and readonly approval together", async () => {
  const current = fixture()
  const action = await command(modeCommands, "plan").run({
    ...current,
    args: "inspect the parser"
  })

  assert.match(action.rewrite, /read-only development plan/)
  assertModeState(current, { modeId: "plan", mode: "plan", approval: "readonly" })
})

test("/resume restores a plan session without retaining the previous yolo approval", async () => {
  const current = fixture()
  current.ctx.kernel.sessions.listSessions = async () => [{
    id: "ses_plan",
    mode: "plan",
    providerType: "plan-provider",
    model: "plan-model",
    title: "Planning session",
    updatedAt: Date.now()
  }]

  await command(sessionCommands, "resume").run({
    ...current,
    args: "ses_plan",
    openPanel: null
  })

  assert.equal(current.state.sessionId, "ses_plan")
  assert.equal(current.state.providerType, "plan-provider")
  assert.equal(current.state.model, "plan-model")
  assertModeState(current, { modeId: "plan", mode: "plan", approval: "readonly" })
})

test("automatic routing and route rejection use the same complete mode switch", async () => {
  const source = await readFile(new URL("../src/repl.mjs", import.meta.url), "utf8")

  assert.match(source, /switchModeInPlace\(state, ctx, route\.mode\)/)
  assert.match(source, /switchModeInPlace\(state, ctx, confirm\.suggestedMode\)/)
  assert.doesNotMatch(source, /state\.mode\s*=\s*(route\.mode|confirm\.suggestedMode)/)
})
