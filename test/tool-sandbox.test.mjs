import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import {
  resolveSandboxBackend,
  buildSandboxedCommand,
  buildSandboxExecProfile,
  describeSandboxStatus,
  readSandboxConfig,
  resolveWritableDir,
  takeSandboxUnavailableNotice,
  resetSandboxNotices,
  probeSandboxSupport,
  resetSandboxSupportCache
} from "../src/tool/sandbox.mjs"

const WS = "/home/dev/project"
const TMP = "/tmp"
const STATE = "/home/dev/.kkcode"

function bwrapArgs(overrides = {}) {
  const spec = buildSandboxedCommand({
    backend: "bwrap",
    command: "echo hi",
    workspaceDir: WS,
    tmpDir: TMP,
    homeStateDir: STATE,
    ...overrides
  })
  return spec.args
}

test("resolveSandboxBackend covers the platform matrix", () => {
  assert.equal(resolveSandboxBackend({ platform: "linux", hasBwrap: true }), "bwrap")
  // bwrap 不在（或内核禁了非特权 userns）时必须是 none，不能假装有沙箱
  assert.equal(resolveSandboxBackend({ platform: "linux", hasBwrap: false }), "none")
  assert.equal(resolveSandboxBackend({ platform: "darwin", hasBwrap: false }), "sandbox-exec")
  assert.equal(resolveSandboxBackend({ platform: "darwin", hasSandboxExec: false }), "none")
  assert.equal(resolveSandboxBackend({ platform: "win32", hasBwrap: true }), "none")
  assert.equal(resolveSandboxBackend({ platform: "freebsd", hasBwrap: true }), "none")
  assert.equal(resolveSandboxBackend({}), "none")
})

test("bwrap arg table: read-only root, three writable binds, no net isolation by default", () => {
  assert.deepEqual(buildSandboxedCommand({
    backend: "bwrap",
    command: "echo hi",
    workspaceDir: WS,
    tmpDir: TMP,
    homeStateDir: STATE
  }), {
    command: "bwrap",
    args: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--bind", WS, WS,
      "--bind", TMP, TMP,
      "--bind", STATE, STATE,
      "--unshare-pid", "--die-with-parent",
      "/bin/sh", "-c", "echo hi"
    ]
  })
})

test("network:false adds --unshare-net, network:true never does", () => {
  assert.ok(bwrapArgs({ network: false }).includes("--unshare-net"))
  assert.ok(!bwrapArgs({ network: true }).includes("--unshare-net"))
  // 开关只影响网络这一项，可写目录不能跟着变
  const off = bwrapArgs({ network: false })
  const on = bwrapArgs({ network: true })
  assert.deepEqual(off.filter((item) => item !== "--unshare-net"), on)
})

test("extra writable dirs are appended as binds, duplicates collapse", () => {
  const args = bwrapArgs({ extraWritableDirs: ["/home/dev/.cache", WS, "/home/dev/.cache"] })
  const binds = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--bind") binds.push(args[i + 1])
  }
  // 工作区已经在列表里，重复的 --bind 会让参数表随环境漂移
  assert.deepEqual(binds, [WS, TMP, STATE, "/home/dev/.cache"])
})

test("the command text is one argv, so quotes and newlines need no escaping", () => {
  const nasty = `printf '%s\\n' "a b" && echo $HOME; echo 'it'\\''s'\n# trailing comment`
  const args = bwrapArgs({ command: nasty })
  assert.equal(args.at(-1), nasty)
  assert.equal(args.at(-2), "-c")
  assert.equal(args.at(-3), "/bin/sh")
  // 命令文本不得出现在其他任何位置（拼接过就会）
  assert.equal(args.filter((item) => item === nasty).length, 1)
})

test("backend none returns null so the caller keeps the current path", () => {
  assert.equal(buildSandboxedCommand({ backend: "none", command: "echo hi", workspaceDir: WS }), null)
  assert.equal(buildSandboxedCommand({ backend: "bwrap", command: "   ", workspaceDir: WS }), null)
  assert.equal(buildSandboxedCommand({}), null)
})

test("sandbox-exec profile denies writes by default and allows only the three roots", () => {
  const spec = buildSandboxedCommand({
    backend: "sandbox-exec",
    command: "echo hi",
    workspaceDir: "/Users/dev/project",
    tmpDir: "/private/var/folders/xx/T",
    homeStateDir: "/Users/dev/.kkcode",
    network: true
  })
  assert.equal(spec.command, "sandbox-exec")
  assert.equal(spec.args[0], "-p")
  assert.deepEqual(spec.args.slice(2), ["/bin/sh", "-c", "echo hi"])

  const profile = spec.args[1]
  const lines = profile.split("\n")
  assert.equal(lines[0], "(version 1)")
  // 顺序即语义：profile 语言里后匹配的规则覆盖先匹配的
  assert.ok(lines.indexOf("(deny file-write*)") > lines.indexOf("(allow default)"))
  assert.ok(lines.indexOf("(allow file-write*") > lines.indexOf("(deny file-write*)"))
  assert.match(profile, /\(subpath "\/Users\/dev\/project"\)/)
  assert.match(profile, /\(subpath "\/private\/var\/folders\/xx\/T"\)/)
  assert.match(profile, /\(subpath "\/Users\/dev\/\.kkcode"\)/)
  // `cmd > /dev/null` 是最常见的写法，不放行等于沙箱里一半命令报错
  assert.match(profile, /\(literal "\/dev\/null"\)/)
  assert.ok(!profile.includes("(deny network*)"))
})

test("sandbox-exec profile denies network only when network is off", () => {
  const profile = buildSandboxExecProfile({ writableDirs: ["/Users/dev/project"], network: false })
  assert.ok(profile.includes("(deny network*)"))
  // deny network* 必须在最后，前面的 (allow default) 才盖不住它
  assert.equal(profile.split("\n").at(-1), "(deny network*)")
})

test("sandbox-exec profile escapes quotes in paths", () => {
  const profile = buildSandboxExecProfile({ writableDirs: ['/Users/dev/we"ird'] })
  assert.match(profile, /\(subpath "\/Users\/dev\/we\\"ird"\)/)
})

test("readSandboxConfig defaults to off and treats unknown modes as off", () => {
  assert.deepEqual(readSandboxConfig(null), { mode: "off", network: true, writableDirs: [] })
  assert.deepEqual(readSandboxConfig({}), { mode: "off", network: true, writableDirs: [] })
  assert.equal(readSandboxConfig({ permission: { sandbox: { mode: "on" } } }).mode, "off")
  assert.equal(readSandboxConfig({ permission: { sandbox: { mode: "auto" } } }).mode, "auto")
  assert.equal(readSandboxConfig({ permission: { sandbox: { mode: "auto", network: false } } }).network, false)
  assert.deepEqual(
    readSandboxConfig({ permission: { sandbox: { mode: "auto", writable_dirs: ["~/.cache", "", 3] } } }).writableDirs,
    ["~/.cache"]
  )
})

test("resolveWritableDir expands ~ and resolves relatives against the workspace", () => {
  assert.equal(resolveWritableDir("~/.cache", { homeDir: "/home/dev" }), "/home/dev/.cache")
  assert.equal(resolveWritableDir("~", { homeDir: "/home/dev" }), "/home/dev")
  assert.equal(resolveWritableDir("build", { workspaceDir: WS }), path.join(WS, "build"))
  assert.equal(resolveWritableDir("/var/cache", { workspaceDir: WS }), "/var/cache")
  assert.equal(resolveWritableDir("  ", { workspaceDir: WS }), "")
})

test("describeSandboxStatus speaks one vocabulary for /status and doctor", () => {
  assert.equal(describeSandboxStatus({ config: null }).status, "off")
  assert.equal(describeSandboxStatus({ config: { permission: { sandbox: { mode: "off" } } } }).status, "off")

  const ok = describeSandboxStatus({
    config: { permission: { sandbox: { mode: "auto", network: false } } },
    platform: "linux",
    hasBwrap: true
  })
  assert.deepEqual(ok, { mode: "auto", backend: "bwrap", network: false, status: "bwrap", available: true })

  const missing = describeSandboxStatus({
    config: { permission: { sandbox: { mode: "auto" } } },
    platform: "linux",
    hasBwrap: false
  })
  assert.equal(missing.status, "auto-but-unavailable")
  assert.equal(missing.available, false)
  assert.match(missing.reason, /bwrap/)

  const win = describeSandboxStatus({
    config: { permission: { sandbox: { mode: "auto" } } },
    platform: "win32"
  })
  assert.equal(win.status, "auto-but-unavailable")
  assert.match(win.reason, /win32/)

  const mac = describeSandboxStatus({
    config: { permission: { sandbox: { mode: "auto" } } },
    platform: "darwin"
  })
  assert.equal(mac.status, "sandbox-exec")
})

test("the unavailable notice is emitted once per process", () => {
  resetSandboxNotices()
  const status = describeSandboxStatus({
    config: { permission: { sandbox: { mode: "auto" } } },
    platform: "linux",
    hasBwrap: false
  })
  const first = takeSandboxUnavailableNotice(status)
  assert.match(first, /WITHOUT OS-level isolation/)
  // 每条命令都带一行纯粹烧 token —— 同一会话里后端不会中途变可用
  assert.equal(takeSandboxUnavailableNotice(status), "")
  resetSandboxNotices()
  assert.notEqual(takeSandboxUnavailableNotice(status), "")
  // 可用时不该有任何提示
  assert.equal(takeSandboxUnavailableNotice({ status: "bwrap" }), "")
  resetSandboxNotices()
})

test("probeSandboxSupport never probes off-platform and caches within the process", async () => {
  resetSandboxSupportCache()
  let calls = 0
  const probe = async () => { calls += 1; return true }

  const win = await probeSandboxSupport({ platform: "win32", probe, force: true })
  assert.deepEqual(win, { hasBwrap: false, hasSandboxExec: false })
  assert.equal(calls, 0, "非 Linux 不该 spawn 探测进程")

  const mac = await probeSandboxSupport({ platform: "darwin", probe, force: true })
  assert.deepEqual(mac, { hasBwrap: false, hasSandboxExec: true })
  assert.equal(calls, 0)

  resetSandboxSupportCache()
  await probeSandboxSupport({ platform: "linux", probe })
  await probeSandboxSupport({ platform: "linux", probe })
  assert.equal(calls, 1, "探测结果必须缓存，否则每条 bash 都多一次 spawn")
  resetSandboxSupportCache()
})
