import test from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const entryPath = join(repoRoot, "src", "index.mjs")

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

async function waitFor(check, {
  timeoutMs = 10_000,
  intervalMs = 25,
  message = "condition was not met"
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(message)
}

function countOccurrences(value, pattern) {
  return String(value).split(pattern).length - 1
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test("TUI restores job-control state and exits without a referenced stdin handle", {
  timeout: 25_000
}, async (t) => {
  if (process.platform !== "linux") {
    t.skip("util-linux pseudo-terminal coverage runs on Linux")
    return
  }
  const scriptProbe = spawnSync("script", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
  if (scriptProbe.error || scriptProbe.status !== 0) {
    t.skip("util-linux script command is unavailable")
    return
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "kkcode-tui-lifecycle-"))
  const kkcodeHome = join(tempRoot, "home")
  const pidFile = join(tempRoot, "kkcode.pid")
  const runnerFile = join(tempRoot, "runner.mjs")
  const mcpServerFile = join(tempRoot, "mcp-server.mjs")
  await mkdir(kkcodeHome, { recursive: true })
  await writeFile(join(kkcodeHome, "profile.yaml"), "beginner: true\n", "utf8")
  await writeFile(
    mcpServerFile,
    [
      'let buffer = ""',
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`) }",
      "function handle(message) {",
      '  if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return',
      '  if (message.method === "initialize") {',
      '    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } })',
      "    return",
      "  }",
      '  if (message.method === "tools/list") {',
      '    send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })',
      "    return",
      "  }",
      '  if (message.method === "prompts/list") {',
      '    send({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } })',
      "    return",
      "  }",
      '  send({ jsonrpc: "2.0", id: message.id, result: {} })',
      "}",
      'process.stdin.setEncoding("utf8")',
      'process.stdin.on("data", (chunk) => {',
      "  buffer += chunk",
      '  let newline = buffer.indexOf("\\n")',
      "  while (newline >= 0) {",
      "    const line = buffer.slice(0, newline).trim()",
      "    buffer = buffer.slice(newline + 1)",
      "    if (line) { try { handle(JSON.parse(line)) } catch {} }",
      '    newline = buffer.indexOf("\\n")',
      "  }",
      "})",
      "process.stdin.resume()",
      ""
    ].join("\n"),
    "utf8"
  )
  await writeFile(
    join(kkcodeHome, "config.json"),
    `${JSON.stringify({
      update: { enabled: false },
      ui: {
        terminal: {
          alternate_screen: "always",
          mouse: "always",
          bracketed_paste: true
        }
      },
      tool: {
        sources: {
          builtin: true,
          local: false,
          mcp: true,
          plugin: false
        }
      },
      mcp: {
        auto_discover: false,
        servers: {
          context7: {
            command: process.execPath,
            args: [mcpServerFile],
            framing: "newline",
            health_check_method: "ping",
            timeout_ms: 1000,
            startup_timeout_ms: 2000,
            shutdown_timeout_ms: 1000
          }
        }
      }
    }, null, 2)}\n`,
    "utf8"
  )
  await writeFile(
    runnerFile,
    [
      'import { writeFile } from "node:fs/promises"',
      'import { pathToFileURL } from "node:url"',
      'await writeFile(process.env.KKCODE_TEST_PID_FILE, String(process.pid), "utf8")',
      'await import(pathToFileURL(process.env.KKCODE_TEST_ENTRY).href)',
      ""
    ].join("\n"),
    "utf8"
  )

  const command = `exec ${shellQuote(process.execPath)} ${shellQuote(runnerFile)} --trust`
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    cwd: tempRoot,
    env: {
      ...process.env,
      KKCODE_HOME: kkcodeHome,
      KKCODE_DISABLE_UPDATE_CHECK: "1",
      KKCODE_TEST_ENTRY: entryPath,
      KKCODE_TEST_PID_FILE: pidFile,
      TERM: "xterm-256color"
    },
    stdio: ["pipe", "pipe", "pipe"]
  })

  let output = ""
  let exited = false
  let nodePid = null
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  const exitResult = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  })

  try {
    await waitFor(
      () => output.includes("\x1b[?1049h"),
      { message: `TUI did not enter the alternate screen:\n${output.slice(-1200)}` }
    )
    nodePid = Number(await waitFor(async () => {
      try {
        return await readFile(pidFile, "utf8")
      } catch {
        return null
      }
    }, { message: "TUI process pid was not recorded" }))
    assert.ok(Number.isInteger(nodePid) && nodePid > 1)

    // The frame-enter sequence is written just before signal listeners attach.
    // Give the synchronous startup path time to finish before exercising it.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const entersBeforeSuspend = countOccurrences(output, "\x1b[?1049h")
    const suspendOutputStart = output.length
    process.kill(nodePid, "SIGTSTP")
    await waitFor(
      () => output.slice(suspendOutputStart).includes("\x1b[?1049l"),
      { message: `TUI did not restore the terminal before SIGTSTP:\n${output.slice(-1200)}` }
    )

    process.kill(nodePid, "SIGCONT")
    await waitFor(
      () => countOccurrences(output, "\x1b[?1049h") > entersBeforeSuspend,
      { message: `TUI did not reactivate after SIGCONT:\n${output.slice(-1200)}` }
    )

    child.stdin.write("/exit\r")
    const result = await withTimeout(
      exitResult,
      8_000,
      () => `TUI remained alive after /exit:\n${output.slice(-1600)}`
    )
    assert.deepEqual(result, { code: 0, signal: null })
    assert.match(output, /\x1b\[\?1002l/)
    assert.match(output, /\x1b\[\?2004l/)
  } finally {
    if (!exited) {
      if (nodePid) {
        try { process.kill(nodePid, "SIGCONT") } catch {}
        try { process.kill(nodePid, "SIGTERM") } catch {}
      }
      try { child.kill("SIGTERM") } catch {}
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
})
