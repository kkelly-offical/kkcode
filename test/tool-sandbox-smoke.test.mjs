/**
 * 沙箱的真机冒烟 + bash 工具接线。
 *
 * 纯函数的参数表断言（test/tool-sandbox.test.mjs）证明「我们打算传什么」，
 * 这里证明「内核真的照做了」—— 两者缺一不可：参数表写对了但 bwrap 语义
 * 不是我们以为的那样，只有真跑一次才能发现。
 *
 * 没有 bwrap 的机器上整组 skip（带理由），不静默通过。
 */

import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { mkdtemp, rm, readFile, readlink, realpath } from "node:fs/promises"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { probeBwrap, resetSandboxSupportCache, resetSandboxNotices } from "../src/tool/sandbox.mjs"

const hasBwrap = process.platform === "linux" ? await probeBwrap() : false
const skipReason = process.platform !== "linux"
  ? `needs Linux + bwrap (host is ${process.platform})`
  : "bwrap unavailable on this host (install bubblewrap, or the kernel disallows unprivileged user namespaces)"

function configFor(sandbox) {
  return {
    permission: { level: "yolo", rules: [], ...(sandbox ? { sandbox } : {}) },
    tool: {},
    git: { auto: { enabled: false } }
  }
}

async function runBashTool(args, cwd, { sandbox = null, extraCtx = {} } = {}) {
  const config = configFor(sandbox)
  await ToolRegistry.initialize({
    config: { ...config, tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } },
    cwd,
    force: true,
    allowProjectSources: false
  })
  const result = await ToolRegistry.call("bash", args, { cwd, config, ...extraCtx })
  return String(result.output ?? "")
}

let workspace = ""
let home = ""
let previousHome

test.beforeEach(async () => {
  // 目录名里故意带空格：沙箱参数是数组传的，路径不需要转义 —— 这条
  // 假设要有一个真会踩到它的用例
  workspace = await mkdtemp(path.join(os.tmpdir(), "kkcode-sandbox ws-"))
  home = await mkdtemp(path.join(os.tmpdir(), "kkcode-sandbox-home-"))
  // 沙箱会 mkdir 并 bind ~/.kkcode；不隔离的话测试会写进真实配置目录
  previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  resetSandboxSupportCache()
  resetSandboxNotices()
})

test.afterEach(async () => {
  if (previousHome === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = previousHome
  resetSandboxSupportCache()
  resetSandboxNotices()
  await rm(workspace, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test("sandboxed bash can write inside the workspace", { skip: hasBwrap ? false : skipReason }, async () => {
  const out = await runBashTool(
    { command: "printf 'inside\\n' > made-by-sandbox.txt && echo wrote && readlink /proc/self/ns/pid && cat /proc/self/mountinfo" },
    workspace,
    { sandbox: { mode: "auto", network: true } }
  )
  assert.match(out, /wrote/)
  assert.equal(await readFile(path.join(workspace, "made-by-sandbox.txt"), "utf8"), "inside\n")

  // 光断言「写成功了」不沙箱也会绿，而且工作区建在 tmp 下（tmp 本来就在
  // 可写 bind 里）——所以证据得从内核那边取：pid namespace 换了没有、
  // 根挂载是不是 ro、工作区是不是自己一条 rw 挂载。
  const hostPidNs = await readlink("/proc/self/ns/pid")
  const sandboxPidNs = out.match(/pid:\[\d+\]/)?.[0]
  assert.match(hostPidNs, /pid:\[\d+\]/, "宿主侧没读到 namespace，下面的比较会空洞通过")
  assert.ok(sandboxPidNs, `没读到沙箱内的 pid namespace: ${out}`)
  assert.notEqual(sandboxPidNs, hostPidNs)

  const mounts = out.split("\n")
    .filter((line) => /^\d+ \d+ \d+:\d+ /.test(line))
    .map((line) => {
      const fields = line.split(" ")
      // mountinfo 把空格写成 \040
      return { point: fields[4].replace(/\\040/g, " "), options: fields[5] }
    })
  assert.ok(mounts.length > 3, `没解析出挂载表: ${out}`)
  assert.match(mounts.find((item) => item.point === "/")?.options || "", /^ro\b/, "根必须是只读 bind")
  const realWorkspace = await realpath(workspace)
  const workspaceMount = mounts.find((item) => item.point === realWorkspace)
  assert.ok(workspaceMount, "工作区必须是一条独立的 bind 挂载")
  assert.match(workspaceMount.options, /^rw\b/)
})

test("sandboxed bash cannot write outside the workspace", { skip: hasBwrap ? false : skipReason }, async () => {
  const out = await runBashTool(
    { command: "touch /etc/kkcode-sandbox-probe" },
    workspace,
    { sandbox: { mode: "auto", network: true } }
  )
  assert.match(out, /\[exit \d+\]/)
  assert.match(out, /Read-only file system|Permission denied/)
  // 失败必须带上「哪些目录可写」，否则模型会把 EROFS 当环境损坏去瞎修
  assert.match(out, /\[sandbox\] active \(bwrap, network=on\)/)
  assert.ok(out.includes(workspace), "提示里要点名工作区")
})

test("sandbox state dir stays writable so session state still lands", { skip: hasBwrap ? false : skipReason }, async () => {
  const out = await runBashTool(
    { command: `touch "${process.env.KKCODE_HOME}/probe" && echo state-ok` },
    workspace,
    { sandbox: { mode: "auto", network: true } }
  )
  assert.match(out, /state-ok/)
})

test("network:false cuts the sandbox off from host services", { skip: hasBwrap ? false : skipReason }, async () => {
  const server = http.createServer((_req, res) => res.end("hi"))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const probe = `node -e "fetch('http://127.0.0.1:${port}').then(()=>console.log('REACHED')).catch(()=>console.log('BLOCKED'))"`
  try {
    // 控制组先跑：不先证明「开着网就能连上」，BLOCKED 可能只是探针本身写坏了
    const open = await runBashTool({ command: probe }, workspace, { sandbox: { mode: "auto", network: true } })
    assert.match(open, /REACHED/)

    const closed = await runBashTool({ command: probe }, workspace, { sandbox: { mode: "auto", network: false } })
    assert.match(closed, /BLOCKED/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("background bash is sandboxed too", { skip: hasBwrap ? false : skipReason }, async () => {
  // 否则 run_in_background: true 就是一个绕过沙箱的开关
  const { BackgroundManager } = await import("../src/orchestration/background-manager.mjs")
  const launched = await runBashTool(
    { command: "touch /etc/kkcode-sandbox-bg-probe", run_in_background: true },
    workspace,
    { sandbox: { mode: "auto", network: true } }
  )
  const taskId = launched.match(/background task launched: (\S+)/)?.[1]
  assert.ok(taskId, `未拿到 task id: ${launched}`)
  let task = null
  for (let i = 0; i < 100; i += 1) {
    task = await BackgroundManager.get(taskId)
    if (task && ["completed", "error", "cancelled"].includes(task.status)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const text = `${task?.result || ""}${task?.error || ""}`
  assert.match(text, /Read-only file system|Permission denied/)
})

test("mode=auto with no backend falls back loudly, never silently", async () => {
  // bwrap 探测走 PATH，清空 PATH 即可在任何机器上复现「想开但开不了」。
  // /bin/sh 是绝对路径、echo 是内建命令，所以命令本身照样能跑。
  const previousPath = process.env.PATH
  process.env.PATH = path.join(workspace, "no-such-bin")
  resetSandboxSupportCache()
  resetSandboxNotices()
  try {
    const first = await runBashTool({ command: "echo still-ran" }, workspace, { sandbox: { mode: "auto", network: true } })
    assert.match(first, /\[sandbox\] requested \(mode=auto\) but unavailable/)
    assert.match(first, /WITHOUT OS-level isolation/)
    assert.match(first, /still-ran/)

    // 提示每进程一次：后端不会在同一个会话里中途变可用
    const second = await runBashTool({ command: "echo still-ran" }, workspace, { sandbox: { mode: "auto", network: true } })
    assert.doesNotMatch(second, /\[sandbox\]/)
    assert.match(second, /still-ran/)
  } finally {
    process.env.PATH = previousPath
    resetSandboxSupportCache()
    resetSandboxNotices()
  }
})

test("mode=off leaves bash byte-for-byte on the 0.8.0 path", async () => {
  const outside = path.join(os.tmpdir(), `kkcode-sandbox-off-${process.pid}.txt`)
  const commands = [
    "echo hello",
    "exit 3",
    "pwd",
    `printf 'x' > "${outside}" && echo wrote-outside`
  ]
  const variants = [null, { mode: "off" }, { mode: "off", network: false }]
  try {
    for (const command of commands) {
      const outputs = []
      for (const sandbox of variants) {
        outputs.push(await runBashTool({ command }, workspace, { sandbox }))
      }
      assert.equal(outputs[0], outputs[1], `sandbox 缺省与 mode=off 必须一致：${command}`)
      assert.equal(outputs[0], outputs[2], `mode=off 下 network 开关必须无效：${command}`)
      assert.doesNotMatch(outputs[0], /\[sandbox\]/)
    }
    // 工作区外仍可写 —— 这是「确实没被包」的正证，不然上面的一致性可能只是
    // 三个变体一起坏了
    assert.equal(await readFile(outside, "utf8"), "x")
  } finally {
    await rm(outside, { force: true })
  }
})
