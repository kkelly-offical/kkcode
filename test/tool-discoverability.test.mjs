import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { PermissionEngine } from "../src/permission/engine.mjs"
import { PermissionError } from "../src/core/errors.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PROMPT_DIR = path.join(ROOT, "src", "tool", "prompt")
const registryConfig = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }

/**
 * 这一组测试来自 0.6.9 之后的真模型验收，那轮发现的问题是同一类：
 * **工具建好了、注册了、单测全绿，但模型从不用它**。
 *
 * 「整理 messy/ 目录」的任务里，模型用一条 bash 干完 mkdir/mv/rm/tar，
 * 五个新工具一次都没被调用 —— 因为 bash 的工具说明里那份 CRITICAL 选择规则
 * 只列了 read/grep/glob/write/edit，新工具从未被通告。而这些工具存在的全部
 * 理由就是 bash 绕过路径校验与保护清单。补上说明后，同一任务的 12 次调用
 * 全部走专用工具，bash 零调用。
 *
 * 所以「可发现性」和功能一样需要回归测试：它不是文档问题，是工具是否起作用。
 */

async function listTools(mode = "agent") {
  await ToolRegistry.initialize({ config: registryConfig, cwd: ROOT, force: true, allowProjectSources: false })
  return ToolRegistry.list({ mode, cwd: ROOT, agents: [], config: registryConfig })
}

test("every registered builtin tool has a prompt file, since that is what the model reads", async () => {
  // 工具的 description 很短，模型看到的详细说明来自 src/tool/prompt/<name>.txt
  // （system-prompt 的第 5 层）。缺文件不会报错，只会让工具在模型眼里模糊不清。
  const tools = await listTools()
  const files = new Set((await readdir(PROMPT_DIR)).map((f) => f.replace(/\.txt$/, "")))

  // MCP 与动态工具自带说明，只检查内置工具
  const missing = tools
    .map((t) => t.name)
    .filter((name) => !name.startsWith("mcp_"))
    .filter((name) => !files.has(name))

  assert.deepEqual(missing, [], `以下工具缺 prompt 文件：${missing.join(", ")}`)
})

test("bash's tool selection rules name every tool that supersedes a shell command", async () => {
  // 这条是上面那次验收的直接产物。模型遵循的是这份清单 —— 漏登记的工具
  // 就等于不存在，而它们各自替代的 shell 命令仍会被用。
  const bashPrompt = await readFile(path.join(PROMPT_DIR, "bash.txt"), "utf8")
  const rules = bashPrompt.slice(0, bashPrompt.indexOf("Parameters:"))

  for (const [tool, shellCommand] of [
    ["read", "cat"], ["grep", "grep"], ["glob", "find"],
    ["write", "echo"], ["edit", "sed"],
    ["move", "mv"], ["copy", "cp"], ["remove", "rm"],
    ["mkdir", "mkdir"], ["archive", "tar"], ["http_request", "curl"]
  ]) {
    assert.match(rules, new RegExp(`\\b${tool}\\b`), `选择规则里必须点名 ${tool}`)
    assert.match(rules, new RegExp(shellCommand, "i"), `必须说明它替代的是 ${shellCommand}`)
  }
})

test("the rules explain why, not just what", async () => {
  const bashPrompt = await readFile(path.join(PROMPT_DIR, "bash.txt"), "utf8")
  // 「不许用 rm」没有理由时读起来像风格洁癖，模型会在权衡时放弃它。
  // 真实理由是安全属性，写出来才站得住。
  assert.match(bashPrompt, /not style preferences/i)
  assert.match(bashPrompt, /symlink/i)
  assert.match(bashPrompt, /protected/i)
  assert.match(bashPrompt, /recoverable/i)
  assert.match(bashPrompt, /metadata endpoints/i)
})

test("bash still owns data processing, which is the intended path for CSV/JSON work", async () => {
  // 调研结论：没有一家前沿工具内置数据处理。计划据此不做 data_query，
  // 而是让 python3/node 一行流走 bash —— 那条路必须在说明里是明确允许的，
  // 否则模型会在「不许用 bash」和「没有别的工具」之间卡住。
  const bashPrompt = await readFile(path.join(PROMPT_DIR, "bash.txt"), "utf8")
  assert.match(bashPrompt, /python3?\b/)
  assert.match(bashPrompt, /data processing/i)
})

test("a protected-path denial tells the model what it hit", async () => {
  // 验收里模型收到的原文只有 `permission denied for tool write` —— 它既不知道
  // 撞的是保护清单（而非档位不够），也无法向用户解释或换个可行做法。
  // 带上理由之后，模型给出了准确解释和三个替代方案。
  PermissionEngine.setTrusted(true)
  const config = { permission: { level: "yolo", rules: [] } }
  await assert.rejects(
    () => PermissionEngine.check({
      config, sessionId: "discover", tool: "write", mode: "agent", pattern: ".npmrc"
    }),
    (error) => {
      assert.ok(error instanceof PermissionError)
      assert.match(error.message, /protected_path/, "必须点明判定来源")
      assert.match(error.message, /\.npmrc/, "必须点明是哪个文件")
      assert.match(error.message, /host environment/i, "必须给出理由")
      return true
    }
  )
})

test("chat can trust a workspace headlessly", async () => {
  // 无头 chat 此前完全没法信任工作区：buildContext 一直接受 options.trust，
  // 而 chat 从不传 —— 于是脚本与 CI 里所有工具（含 read）一律被拒，唯一出路
  // 是先开 REPL 手敲 /trust。ultra 早在 0.5.0 补了同一个缺口。
  const source = await readFile(path.join(ROOT, "src", "commands", "chat.mjs"), "utf8")
  assert.match(source, /--trust/, "chat 必须提供 --trust")
  assert.match(source, /buildContext\(\{\s*trust:/, "而且必须真的把它传给 buildContext")
})
