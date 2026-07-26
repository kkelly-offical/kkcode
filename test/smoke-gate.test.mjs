import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { checkSmokeGate, resolveSmokeTarget } from "../src/session/smoke-gate.mjs"
import { GATE_NAMES, readGate, isDecisiveGate } from "../src/session/gate-contract.mjs"

async function withProject(files, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-smoke-"))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content)
    }
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("smoke is part of the gate contract", () => {
  assert.ok(GATE_NAMES.includes("smoke"), "smoke 必须在门禁枚举里，否则 readGate 取不到")
})

test("a project with no discoverable entry point is not_applicable", async () => {
  await withProject({ "README.md": "nothing runnable here" }, async (dir) => {
    const result = await checkSmokeGate({ cwd: dir, config: {} })
    // 乱猜启动命令会在别人的项目里制造假失败 —— 不判比错判好
    assert.equal(result.status, "not_applicable")
    assert.match(result.reason, /no runnable entry point/)
  })
})

test("a healthy CLI passes", async () => {
  await withProject({
    "package.json": JSON.stringify({ name: "ok-cli", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    "cli.mjs": 'console.log("1.0.0")\n'
  }, async (dir) => {
    const result = await checkSmokeGate({ cwd: dir, config: {} })
    assert.equal(result.status, "pass", result.reason)
    assert.equal(result.evidence.exitCode, 0)
    assert.deepEqual(result.evidence.crashSignatures, [])
  })
})

test("smoke catches what build and test cannot: an import that resolves nowhere", async () => {
  // 这就是这道门禁存在的理由。语法完全正确（node --check 会通过），
  // 也没有任何测试覆盖启动路径 —— 只有真的跑一次才会暴露。
  await withProject({
    "package.json": JSON.stringify({ name: "broken", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    "cli.mjs": 'import { thing } from "./does-not-exist.mjs"\nconsole.log(thing)\n'
  }, async (dir) => {
    const result = await checkSmokeGate({ cwd: dir, config: {} })
    assert.equal(result.status, "fail")
    assert.match(result.reason, /ERR_MODULE_NOT_FOUND|Cannot find module/)
    assert.ok(result.output, "失败必须带输出，否则模型无从下手")
  })
})

test("smoke catches a missing export that syntax checks pass", async () => {
  await withProject({
    "package.json": JSON.stringify({ name: "gone", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    "lib.mjs": "export const kept = 1\n",
    "cli.mjs": 'import { removed } from "./lib.mjs"\nconsole.log(removed())\n'
  }, async (dir) => {
    const result = await checkSmokeGate({ cwd: dir, config: {} })
    assert.equal(result.status, "fail", result.reason)
  })
})

test("a crash signature outweighs a zero exit code", async () => {
  // 一个进程可以打印 ERR_MODULE_NOT_FOUND 之后仍以 0 退出（吞掉自己的错误）。
  // 只看退出码的门禁会放过它，而那正是最该被抓的一类。
  await withProject({
    "package.json": JSON.stringify({ name: "swallow", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    "cli.mjs": `try { await import("./nope.mjs") } catch (e) { console.error(e.code, e.message) }
process.exit(0)
`
  }, async (dir) => {
    const result = await checkSmokeGate({ cwd: dir, config: {} })
    assert.equal(result.evidence.exitCode, 0, "前提：进程确实以 0 退出")
    assert.equal(result.status, "fail", "退出码为 0 但有崩溃签名，仍须判失败")
    assert.match(result.reason, /crash signature/)
  })
})

test("a hang is killed and reported as a timeout, not left running", async () => {
  await withProject({
    "package.json": JSON.stringify({ name: "hang", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    // 真的挂死要靠常驻 handle。`await new Promise(() => {})` 不行 ——
    // Node 检测到 top-level await 永不 settle，会以退出码 13 立即退出，
    // 那是另一种失败（也确实该判失败），不是挂死。
    "cli.mjs": "setInterval(() => {}, 1000)\n"
  }, async (dir) => {
    const config = { agent: { longagent: { usability_gates: { smoke: { timeout_ms: 1500 } } } } }
    const started = process.hrtime.bigint()
    const result = await checkSmokeGate({ cwd: dir, config })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(result.status, "fail")
    assert.match(result.reason, /did not finish within 1500ms/)
    assert.ok(elapsedMs < 10000, `必须被 kill 而非等到默认超时，实际 ${Math.round(elapsedMs)}ms`)
  })
})

test("a library entry point is imported rather than executed as a CLI", async () => {
  await withProject({
    "package.json": JSON.stringify({ name: "lib", version: "1.0.0", main: "index.mjs", type: "module" }),
    "index.mjs": "export const value = 42\n"
  }, async (dir) => {
    const target = await resolveSmokeTarget(dir, {})
    assert.equal(target.kind, "entry")
    assert.equal((await checkSmokeGate({ cwd: dir, config: {} })).status, "pass")
  })
})

test("an explicit command overrides discovery", async () => {
  await withProject({
    "package.json": JSON.stringify({ name: "custom", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    "cli.mjs": "process.exit(1)\n"
  }, async (dir) => {
    const config = {
      agent: { longagent: { usability_gates: { smoke: { command: process.execPath, args: ["-e", "0"] } } } }
    }
    const target = await resolveSmokeTarget(dir, config)
    assert.equal(target.kind, "configured", "显式配置必须优先于自动发现")
    assert.equal((await checkSmokeGate({ cwd: dir, config })).status, "pass")
  })
})

test("smoke can be disabled and then has no say", async () => {
  await withProject({
    "package.json": JSON.stringify({ name: "broken", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    "cli.mjs": 'import "./nope.mjs"\n'
  }, async (dir) => {
    const config = { agent: { longagent: { usability_gates: { smoke: { enabled: false } } } } }
    const result = await checkSmokeGate({ cwd: dir, config })
    assert.equal(result.enabled, false)
    assert.equal(isDecisiveGate(result), false)
  })
})

test("runUsabilityGates surfaces smoke through the contract", async () => {
  const { runUsabilityGates } = await import("../src/session/usability-gates.mjs")
  await withProject({
    "package.json": JSON.stringify({ name: "ok", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    "cli.mjs": 'console.log("ok")\n'
  }, async (dir) => {
    const config = {
      agent: {
        longagent: {
          usability_gates: {
            build: { enabled: false }, test: { enabled: false }, review: { enabled: false },
            health: { enabled: false }, budget: { enabled: false }
          }
        }
      }
    }
    const gates = await runUsabilityGates({ sessionId: "smoke-contract", config, cwd: dir })
    const smoke = readGate(gates, "smoke")
    assert.ok(smoke, "smoke 必须能通过 readGate 取到")
    assert.equal(smoke.status, "pass")
    assert.equal(gates.allPass, true)
  })
})

test("a program that can never finish is a failure, not a pass", async () => {
  // Node 对「top-level await 永不 settle」的处理是以退出码 13 退出，而不是挂死。
  // 写这条是因为上面那个超时用例最初就用了这个写法 —— 它 57ms 就返回了，
  // 测试却以为在验证超时逻辑。两种失败都要判失败，但走的是不同分支。
  await withProject({
    "package.json": JSON.stringify({ name: "unsettled", version: "1.0.0", bin: "cli.mjs", type: "module" }),
    "cli.mjs": "await new Promise(() => {})\n"
  }, async (dir) => {
    const result = await checkSmokeGate({ cwd: dir, config: {} })
    assert.equal(result.status, "fail")
    assert.equal(result.evidence.timedOut, false, "它不是超时，是主动退出")
    assert.equal(result.evidence.exitCode, 13)
  })
})
