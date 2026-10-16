import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { register } from "node:module"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendUserMessage, flushNow, touchSession, updateSession } from "../src/kernel/session/store.mjs"

const facadeUrl = new URL("../src/kernel/index.mjs", import.meta.url).href
const commandUrl = new URL("../src/commands/session.mjs", import.meta.url).href
const shimUrl = `data:text/javascript,${encodeURIComponent(`
import { createKernel as createRealKernel } from ${JSON.stringify(facadeUrl)}
export * from ${JSON.stringify(facadeUrl)}
export async function createKernel(options) {
  const kernel = await createRealKernel(options)
  const fixture = globalThis.__sessionCommandFixture
  const shutdown = kernel.shutdown.bind(kernel)
  kernel.shutdown = async () => {
    fixture.shutdowns += 1
    await shutdown()
  }
  kernel.bootExtensions = async () => {
    fixture.boots += 1
    if (fixture.bootError) throw fixture.bootError
    return kernel.extensionPolicy
  }
  kernel.executeTurn = async (options) => {
    fixture.turns.push(options)
    if (fixture.turnError) throw fixture.turnError
    return fixture.turnResult
  }
  return kernel
}
`)}`
const loaderUrl = `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === ${JSON.stringify(commandUrl)} && specifier === "../kernel/index.mjs") {
    return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`)}`
register(loaderUrl, import.meta.url)
const { createSessionCommand } = await import(commandUrl)

let home
let project
let previousHome
let previousCwd

function config(recovery = true) {
  return {
    provider: { default: "fixture", fixture: { type: "openai", default_model: "fixture-model" } },
    session: { recovery, title_generation: false },
    mcp: { auto_discover: false, background_load: false, servers: {} },
    skills: { auto_seed: false },
    update: { enabled: false }
  }
}

async function writeConfig(recovery = true) {
  await writeFile(join(home, "config.yaml"), JSON.stringify(config(recovery)), "utf8")
}

async function seedSession({ failed = false, empty = false } = {}) {
  const sessionId = "ses_command_fixture"
  await touchSession({ sessionId, mode: "agent", model: "fixture-model", providerType: "fixture", cwd: project })
  if (!empty) await appendUserMessage(sessionId, "original prompt")
  if (failed) await updateSession(sessionId, { retryMeta: { failedAt: Date.now(), turnId: "turn_failed" } })
  await flushNow()
  return sessionId
}

async function runCommand(args) {
  const stdout = []
  const stderr = []
  const originalLog = console.log
  const originalError = console.error
  let error = null
  console.log = (...values) => stdout.push(values.join(" "))
  console.error = (...values) => stderr.push(values.join(" "))
  try {
    await createSessionCommand().parseAsync(args, { from: "user" })
  } catch (caught) {
    error = caught
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  return { code: process.exitCode ?? 0, stdout: stdout.join("\n"), stderr: stderr.join("\n"), error }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-command-session-home-"))
  project = await mkdtemp(join(tmpdir(), "kkcode-command-session-project-"))
  previousHome = process.env.KKCODE_HOME
  previousCwd = process.cwd()
  process.env.KKCODE_HOME = home
  process.chdir(project)
  process.exitCode = 0
  await writeConfig()
  globalThis.__sessionCommandFixture = {
    shutdowns: 0,
    boots: 0,
    turns: [],
    bootError: null,
    turnError: null,
    turnResult: { reply: "completed reply", status: "completed" }
  }
})

afterEach(async () => {
  try {
    await flushNow()
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousHome
    process.exitCode = 0
    delete globalThis.__sessionCommandFixture
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

for (const command of ["resume", "retry"]) {
  test(`${command} keeps successful replies and exits zero after shutdown`, async () => {
    const sessionId = await seedSession({ failed: command === "retry" })
    const result = await runCommand([command, "--id", sessionId])
    assert.equal(result.error, null)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /completed reply/)
    assert.equal(globalThis.__sessionCommandFixture.shutdowns, 1)
    assert.equal(globalThis.__sessionCommandFixture.boots, 1)
    assert.equal(globalThis.__sessionCommandFixture.turns[0].prompt, "original prompt")
    assert.equal(globalThis.__sessionCommandFixture.turns[0].contentBlocks, undefined)
  })

  test(`${command} restores multimodal content without treating blocks as a prompt string`, async () => {
    const content = [
      { type: "text", text: "Examine the image." },
      { type: "image", mediaType: "image/png", data: "IMAGE_BYTES_NOT_PROMPT" },
      { type: "text", text: "Then compare the audio." },
      { type: "audio", mediaType: "audio/wav", data: "AUDIO_BYTES_NOT_PROMPT" },
      { type: "text", text: "Keep this order." }
    ]
    const sessionId = await seedSession({ failed: command === "retry", empty: true })
    await appendUserMessage(sessionId, content)
    await flushNow()

    const result = await runCommand([command, "--id", sessionId])
    assert.equal(result.error, null)
    assert.equal(result.code, 0)
    const turn = globalThis.__sessionCommandFixture.turns[0]
    assert.equal(typeof turn.prompt, "string")
    assert.equal(turn.prompt, "Examine the image.\nThen compare the audio.\nKeep this order.")
    assert.deepEqual(turn.contentBlocks, content)
    assert.doesNotMatch(turn.prompt, /IMAGE_BYTES_NOT_PROMPT|AUDIO_BYTES_NOT_PROMPT|\[object Object\]/)
  })

  test(`${command} preserves reply text and chat failure exit semantics`, async () => {
    const sessionId = await seedSession({ failed: command === "retry" })
    const scenarios = [
      { result: { reply: "provider error: forced", error: "forced", status: "error" }, code: 1 },
      { result: { reply: "partial reply", status: "incomplete", stopReason: "max-steps" }, code: 2 },
      { result: { reply: "blocked reply", status: "blocked", stopReason: "verification-incomplete" }, code: 2 },
      { result: { reply: "cancelled reply", status: "cancelled", cancelled: true, stopReason: "cancelled" }, code: 2 },
      { result: { reply: "provider error: cancelled", error: "cancelled", status: "cancelled", cancelled: true }, code: 1 }
    ]
    for (const scenario of scenarios) {
      process.exitCode = 0
      const fixture = globalThis.__sessionCommandFixture
      fixture.turnResult = scenario.result
      fixture.shutdowns = 0
      const result = await runCommand([command, "--id", sessionId])
      assert.equal(result.error, null)
      assert.equal(result.code, scenario.code, scenario.result.status)
      assert.ok(result.stdout.includes(scenario.result.reply), scenario.result.status)
      assert.equal(fixture.shutdowns, 1, scenario.result.status)
    }
  })
}

test("status and recoverable shut down on normal and empty early returns", async () => {
  for (const args of [["status"], ["status", "--json"], ["recoverable"]]) {
    globalThis.__sessionCommandFixture.shutdowns = 0
    const result = await runCommand(args)
    assert.equal(result.error, null, args.join(" "))
    assert.equal(result.code, 0, args.join(" "))
    assert.equal(globalThis.__sessionCommandFixture.shutdowns, 1, args.join(" "))
  }
})

test("resume and retry shut down without booting on missing or non-retryable sessions", async () => {
  for (const [args, seed] of [
    [["resume", "--id", "ses_missing"], false],
    [["retry", "--id", "ses_missing"], false],
    [["retry", "--id", "ses_command_fixture"], true]
  ]) {
    if (seed) await seedSession()
    globalThis.__sessionCommandFixture.shutdowns = 0
    globalThis.__sessionCommandFixture.boots = 0
    const result = await runCommand(args)
    assert.equal(result.error, null)
    assert.equal(result.code, 1)
    assert.equal(globalThis.__sessionCommandFixture.shutdowns, 1)
    assert.equal(globalThis.__sessionCommandFixture.boots, 0)
  }
})

test("disabled recovery shuts down on every early return", async () => {
  await writeConfig(false)
  for (const args of [["resume", "--id", "ses_missing"], ["retry", "--id", "ses_missing"], ["recoverable"]]) {
    globalThis.__sessionCommandFixture.shutdowns = 0
    globalThis.__sessionCommandFixture.boots = 0
    const result = await runCommand(args)
    assert.equal(result.error, null)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /session recovery is disabled/)
    assert.equal(globalThis.__sessionCommandFixture.shutdowns, 1)
    assert.equal(globalThis.__sessionCommandFixture.boots, 0)
  }
})

test("boot and turn exceptions still shut down exactly once", async () => {
  const sessionId = await seedSession({ failed: true })
  for (const failure of ["bootError", "turnError"]) {
    const fixture = globalThis.__sessionCommandFixture
    fixture.shutdowns = 0
    fixture[failure] = new Error(`${failure} fixture`)
    const result = await runCommand([failure === "bootError" ? "resume" : "retry", "--id", sessionId])
    assert.equal(result.error?.message, `${failure} fixture`)
    assert.equal(fixture.shutdowns, 1)
    fixture[failure] = null
  }
})
