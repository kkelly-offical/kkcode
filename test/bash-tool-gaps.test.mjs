import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { ToolRegistry } from "../src/tool/registry.mjs"

const yoloConfig = {
  permission: { level: "yolo", rules: [] },
  tool: {},
  git: { auto: { enabled: false } }
}

const registryConfig = {
  ...yoloConfig,
  tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }
}

async function runBashTool(args, cwd, extraCtx = {}) {
  await ToolRegistry.initialize({ config: registryConfig, cwd, force: true, allowProjectSources: false })
  return ToolRegistry.call("bash", args, { cwd, config: yoloConfig, ...extraCtx })
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-bash-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("bash reports non-zero exit codes", async () => {
  await withTempDir(async (dir) => {
    const out = (await runBashTool({ command: "exit 3" }, dir)).output
    // 此前 exitCode 被 catch 整个吞掉，模型无法区分「命令失败」与
    // 「命令成功但往 stderr 写了进度」—— 后者在 npm/pip/git 里极常见
    assert.match(String(out), /\[exit 3\]/)
  })
})

test("bash stays silent about exit code on success", async () => {
  await withTempDir(async (dir) => {
    const out = (await runBashTool({ command: "echo hello" }, dir)).output
    assert.match(String(out), /hello/)
    assert.doesNotMatch(String(out), /\[exit/)
  })
})

test("bash accepts a cwd inside the workspace", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "sub"), { recursive: true })
    const out = (await runBashTool({ command: "pwd", cwd: "sub" }, dir)).output
    assert.match(String(out), /sub/)
  })
})

test("bash rejects a cwd that escapes the workspace", async () => {
  await withTempDir(async (dir) => {
    // cwd 不过 resolveWorkspacePath 的话，`../..` 就能把整个工作区边界抬走，
    // 之后所有相对路径判定都在错误的根下做
    const result = await runBashTool({ command: "pwd", cwd: "../.." }, dir)
    assert.equal(result.status, "error", "越界 cwd 必须被拒")
  })
})

test("bash passes per-command env vars", async () => {
  await withTempDir(async (dir) => {
    const cmd = process.platform === "win32" ? "echo %KK_PROBE%" : "echo $KK_PROBE"
    const out = (await runBashTool({ command: cmd, env: { KK_PROBE: "probe-value" } }, dir)).output
    assert.match(String(out), /probe-value/)
  })
})

test("bash ignores malformed env keys instead of failing", async () => {
  await withTempDir(async (dir) => {
    const out = (await runBashTool({ command: "echo ok", env: { "bad key": "x", "PATH;rm": "y" } }, dir)).output
    assert.match(String(out), /ok/)
  })
})

test("long-running commands are blocked in the foreground but allowed in background", async () => {
  await withTempDir(async (dir) => {
    const foreground = (await runBashTool({ command: "npm run dev" }, dir)).output
    assert.match(String(foreground), /\[blocked\]/)
    // 前台的拦截提示原文就是「或者用 run_in_background: true」
    assert.match(String(foreground), /run_in_background/)

    // 而后台此前也拦 —— 文档承诺的唯一逃生口在代码里被堵死，
    // 模型照提示改参数后拿到的还是 blocked
    const background = (await runBashTool({ command: "npm run dev", run_in_background: true }, dir)).output
    assert.doesNotMatch(String(background), /\[blocked\]/)
    assert.match(String(background), /background task launched/)
  })
})

test("bash output truncation follows the context budget and says how to get more", async () => {
  await withTempDir(async (dir) => {
    const cmd = process.platform === "win32"
      ? 'node -e "process.stdout.write(\'x\'.repeat(20000))"'
      : "node -e \"process.stdout.write('x'.repeat(20000))\""
    const out = (await runBashTool({ command: cmd }, dir, { toolResultLimit: 5000 })).output
    const text = String(out)
    assert.ok(text.length < 20000, "应按 toolResultLimit 截断，而非硬编码 30000")
    // 截断必须带下一步动作，否则模型会把截断当完整输出用
    assert.match(text, /Showing|truncat/i)
  })
})
