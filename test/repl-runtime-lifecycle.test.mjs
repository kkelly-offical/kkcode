import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { collectInput } from "../src/repl/input-engine.mjs"
import { processInputLine } from "../src/repl.mjs"
import { sessionCommands } from "../src/repl/commands/session.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const ENTRY = join(ROOT, "src", "index.mjs")
const MCP_SERVER = `
let pending = "";
const newline = String.fromCharCode(10);
process.stdin.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  while (true) {
    const at = pending.indexOf(newline);
    if (at < 0) break;
    const line = pending.slice(0, at).trim();
    pending = pending.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    let result = {};
    if (message.method === "initialize") {
      result = { protocolVersion: "2024-11-05", capabilities: {} };
    } else if (message.method === "tools/list") {
      result = { tools: [] };
    }
    if (message.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + newline);
    }
  }
});
process.stdin.resume();
`

async function isolatedHome(t, { liveMcp = false, configuredModel = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), "kkcode-repl-lifecycle-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, "profile.yaml"), "beginner: true\n", "utf8")

  const provider = {
    type: "openai",
    base_url: "http://127.0.0.1:9/v1",
    api_key: "sk-not-used"
  }
  if (configuredModel) provider.default_model = "test-model"
  const config = {
    provider: { default: "test", test: provider },
    mcp: {
      auto_discover: false,
      background_load: false,
      servers: {}
    },
    skills: { auto_seed: false },
    update: { enabled: false }
  }
  if (liveMcp) {
    config.mcp.servers.fixture = {
      transport: "stdio",
      command: [process.execPath, "-e", MCP_SERVER],
      shell: false,
      framing: "newline",
      timeout_ms: 2000,
      shutdown_timeout_ms: 200
    }
  }
  await writeFile(join(home, "config.yaml"), JSON.stringify(config, null, 2), "utf8")
  return home
}

function runCli({ home, args = [], input = "", timeoutMs = 12_000 }) {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    env: { ...process.env, KKCODE_HOME: home, KKCODE_DISABLE_UPDATE_CHECK: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  let timedOut = false
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.stdin.end(input)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

test("collectInput drains every queued line before reporting EOF", async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const rl = createInterface({ input, output })

  const first = collectInput(rl, "> ")
  input.end("one\ntwo\n")
  assert.equal(await first, "one")
  assert.equal(await collectInput(rl, "> "), "two")
  assert.equal(await collectInput(rl, "> "), null)
  rl.close()
})

test("line mode executes all piped commands and shuts down a live MCP peer at EOF", { timeout: 20_000 }, async (t) => {
  const home = await isolatedHome(t, { liveMcp: true })
  const result = await runCli({ home, input: "/session\n/session\n" })
  const combined = `${result.stdout}\n${result.stderr}`

  assert.equal(result.timedOut, false, `REPL did not exit after EOF:\n${combined.slice(-1200)}`)
  assert.equal(result.code, 0, combined.slice(-1200))
  assert.equal((result.stdout.match(/session=/g) || []).length, 2, combined.slice(-1200))
  assert.match(result.stdout, /mcp ✓ fixture/)
  assert.doesNotMatch(combined, /readline was closed/)
})

test("ultra start shuts down its kernel on an early return with live MCP", { timeout: 20_000 }, async (t) => {
  const home = await isolatedHome(t, { liveMcp: true, configuredModel: false })
  const result = await runCli({
    home,
    args: ["ultra", "start", "fixture objective", "--trust"]
  })
  const combined = `${result.stdout}\n${result.stderr}`

  assert.equal(result.timedOut, false, `ultra start left its MCP peer alive:\n${combined.slice(-1200)}`)
  assert.equal(result.code, 1, combined.slice(-1200))
  assert.match(combined, /no model configured/)
})

test("compact passes the active cancellation signal and does not print late completion", async () => {
  const compact = sessionCommands.find((entry) => entry.names.includes("compact"))
  const controller = new AbortController()
  const writes = []
  let receivedSignal = null

  const pending = compact.run({
    state: { sessionId: "ses_cancel", model: "test-model", providerType: "test" },
    ctx: {
      configState: { config: {} },
      kernel: {
        sessions: {
          compactSession: async ({ signal }) => {
            receivedSignal = signal
            controller.abort()
            throw Object.assign(new Error("cancelled"), { name: "AbortError" })
          }
        }
      }
    },
    print: (text) => { writes.push(text) },
    signal: controller.signal
  })

  await assert.rejects(pending, (error) => error?.name === "AbortError")
  assert.equal(receivedSignal, controller.signal)
  assert.deepEqual(writes, ["compacting conversation..."])
})

test("shell cancellation produces no late transcript or conversation history", { timeout: 10_000 }, async () => {
  const controller = new AbortController()
  let transcriptWrites = 0
  let historyWrites = 0

  const pending = processInputLine({
    line: '!node -e "setInterval(() => {}, 1000)"',
    state: { sessionId: "ses_shell_cancel" },
    ctx: {
      kernel: {
        sessions: {
          appendMessage: async () => { historyWrites += 1 }
        }
      }
    },
    print: () => { transcriptWrites += 1 },
    signal: controller.signal
  })
  const cancellation = setTimeout(() => controller.abort(), 25)
  try {
    await assert.rejects(pending, (error) => error?.name === "AbortError")
  } finally {
    clearTimeout(cancellation)
  }

  assert.equal(transcriptWrites, 0)
  assert.equal(historyWrites, 0)
})
