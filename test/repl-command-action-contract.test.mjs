import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * 命令返回值（action）的契约。
 *
 * `processInputLine` 的每个分支都返回一个 action 对象，三个调用点直接读它的字段
 * （`action.cleared`、`action.exit`…）。但 `/agents` 与 `/tasks` 返回的是 `null`，
 * 于是 `action.cleared` 抛 TypeError：
 *
 *   - TUI 路径外面有 try/catch，只是往对话记录里多打一行 `error: Cannot read …`
 *   - **行模式（管道输入、无 TTY）的 while 循环没有 try/catch，整个 REPL 崩掉**
 *
 * v0.6.0 引入，横跨 15 个版本没被发现 —— 因为日常用的是 TUI，而 TUI 把它咽下去了。
 *
 * 两层防线：
 *   1. 结构层：每个调用点都必须把 action 归一化，这样将来任何 `return null` 都无害
 *   2. 行为层：真的起一个行模式进程跑这些命令，断言它活着退出
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const ENTRY = join(ROOT, "src", "index.mjs")

test("every processInputLine call site normalizes the action", async () => {
  const src = await readFile(join(ROOT, "src", "repl.mjs"), "utf8")
  const sites = [...src.matchAll(/(\w+)\s*=\s*(\(?)await processInputLine\(/g)]
  assert.ok(sites.length >= 3, `预期至少 3 个调用点，实际 ${sites.length}`)

  // 归一化的写法：`(await processInputLine({…})) || {}` 或 `?? {}`。
  // 逐个调用点取到它的语句结尾，断言带了兜底。
  for (const site of sites) {
    const tail = src.slice(site.index)
    const stmtEnd = tail.indexOf("\n\n")
    const stmt = tail.slice(0, stmtEnd === -1 ? 4000 : stmtEnd)
    assert.match(stmt, /\)\s*(\|\||\?\?)\s*\{\s*\}/,
      `调用点 \`${site[1]} = await processInputLine(\` 未归一化 action —— ` +
      "命令返回 null 时后面的 action.cleared 会抛 TypeError")
  }
})

test("no command branch returns a bare null as its action", async () => {
  const src = await readFile(join(ROOT, "src", "repl.mjs"), "utf8")
  const start = src.indexOf("async function processInputLine(")
  const end = src.indexOf("async function startLineRepl(")
  assert.ok(start !== -1 && end > start, "找不到 processInputLine 的范围")
  const body = src.slice(start, end)

  const bareNulls = body.split("\n")
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter(({ line }) => /^return (null|undefined)\s*$/.test(line))

  assert.deepEqual(bareNulls, [],
    "action 必须是对象 —— 调用点直接读它的字段:\n" +
    bareNulls.map((b) => `  第 ${b.no} 行（函数内）: ${b.line}`).join("\n"))
})

test("line-mode REPL survives the read-only commands", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "kkcode-action-contract-"))
  await mkdir(home, { recursive: true })
  // beginner profile 让启动跳过引导，否则进程会停在提问上等输入
  await writeFile(join(home, "profile.yaml"), "beginner: true\n", "utf8")
  await writeFile(join(home, "config.yaml"), [
    "provider:",
    "  default: test",
    "  test:",
    "    type: openai",
    "    base_url: http://127.0.0.1:9/v1",
    "    api_key: sk-not-used",
    "    default_model: test-model",
    "mcp:",
    "  auto_discover: false",
    "skills:",
    "  auto_seed: false"
  ].join("\n"), "utf8")

  // 只读、不需要模型的命令。它们全都只查询状态然后返回 action ——
  // 任何一个返回 null 都会让这条循环崩在下一次读 action.cleared 上。
  const commands = [
    "/agents", "/tasks", "/help", "/keys", "/session",
    "/history", "/commands", "/board", "/permission", "/status",
    "/exit"
  ]

  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, KKCODE_HOME: home, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.stdin.end(`${commands.join("\n")}\n`)

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })

  const combined = `${stdout}\n${stderr}`
  assert.doesNotMatch(combined, /Cannot read properties of (null|undefined)/,
    `命令让 REPL 崩了：\n${combined.slice(-800)}`)
  assert.doesNotMatch(combined, /TypeError/, `出现 TypeError：\n${combined.slice(-800)}`)
  // 崩掉的话 /exit 根本执行不到，退出码非 0
  assert.equal(exitCode, 0, `预期正常退出，实际 ${exitCode}：\n${combined.slice(-800)}`)
})
