/**
 * `kkcode doctor` 必须报沙箱状态。
 *
 * doctor 是用户在「我到底有没有被隔离」这个问题上的唯一离线答案，
 * 所以走真进程验收：库函数里返回对了但打印路径没接上，等于没有。
 */

import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs")

function runDoctor(args, home) {
  return spawnSync(process.execPath, [CLI, "doctor", ...args], {
    encoding: "utf8",
    env: { ...process.env, KKCODE_HOME: home, NO_COLOR: "1" }
  })
}

function withHome(fn) {
  // 隔离 HOME：doctor 会读写用户目录，不隔离就是往真实配置里写
  const home = mkdtempSync(path.join(os.tmpdir(), "kkcode-sandbox-doctor-"))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test("doctor reports sandbox off by default", () => {
  withHome((home) => {
    const { stdout } = runDoctor([], home)
    assert.match(stdout, /^sandbox: off \(bash runs unsandboxed\)$/m)
  })
})

test("doctor --json carries the resolved sandbox backend", () => {
  withHome((home) => {
    const { stdout } = runDoctor(["--json"], home)
    const report = JSON.parse(stdout)
    assert.equal(report.sandbox.status, "off")
    assert.equal(report.sandbox.backend, "none")
  })
})

test("doctor shows the real backend when sandbox is opted in", () => {
  withHome((home) => {
    // config.json 而不是 yaml：这条断言不该依赖可选的 yaml 依赖装没装
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ permission: { sandbox: { mode: "auto", network: false } } })
    )
    const { stdout } = runDoctor([], home)
    // 后端取决于跑测试的机器，但绝不能显示成 off —— 用户明确开了
    assert.match(stdout, /^sandbox: (bwrap network=off|sandbox-exec network=off|auto-but-unavailable — .+)$/m)
    assert.doesNotMatch(stdout, /^sandbox: off/m)
  })
})

test("doctor reports pruned warnings separately from hard config errors", () => {
  withHome((home) => {
    const configPath = path.join(home, "config.json")
    writeFileSync(configPath, JSON.stringify({ agent: { max_steps: "bad" } }))
    const warningRun = runDoctor(["--json"], home)
    assert.equal(warningRun.status, 0)
    const warningReport = JSON.parse(warningRun.stdout)
    assert.equal(warningReport.config.errors.length, 0)
    assert.ok(warningReport.config.warnings.some((warning) => warning.includes("agent.max_steps")))

    writeFileSync(configPath, JSON.stringify({ permission: { level: "full-auto" } }))
    const errorRun = runDoctor(["--json"], home)
    assert.equal(errorRun.status, 1, "hard config errors must make doctor fail")
    const errorReport = JSON.parse(errorRun.stdout)
    assert.ok(errorReport.config.errors.some((error) => error.includes("permission.level")))
    assert.equal(errorReport.config.warnings.length, 0)
    assert.equal(errorReport.ok, false)
  })
})
